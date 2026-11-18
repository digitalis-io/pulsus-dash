#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `ci:shim-lint` (T03-001): the JS lexer and the shim lint (plan §4.2).

mod common;

use std::path::PathBuf;
use std::process::Command;

use common::{lines, tree};
use xtask::XtaskError;
use xtask::jslex::{LexError, count_code_lines, strip_comments};
use xtask::report::Rule;
use xtask::shim::{ShimFiles, candidates, lint, lint_files};

fn count(src: &str) -> u32 {
    count_code_lines(&strip_comments(src).unwrap())
}

fn files(paths: &[&str]) -> ShimFiles {
    ShimFiles {
        candidates: paths.iter().map(PathBuf::from).collect(),
    }
}

/// Lints a fixture tree whose candidates are all its files.
fn lint_tree(fx: &[(&str, &[u8])]) -> xtask::shim::ShimReport {
    let t = tree(fx);
    let paths: Vec<&str> = fx.iter().map(|(p, _)| *p).collect();
    lint_files(t.path(), &files(&paths)).unwrap()
}

fn rules(r: &xtask::shim::ShimReport) -> Vec<Rule> {
    r.violations.iter().map(|v| v.rule).collect()
}

#[test]
fn jslex_counts_code_lines_only() {
    assert_eq!(
        count("a();\n\n// c\n/* x\n y\n z */\nb(); // t\n   \n\"s\";\n"),
        3
    );
}

#[test]
fn jslex_slashes_in_strings_are_code() {
    let src = "const u = \"a//b\"; const v = '/*';\nx();\n";
    let stripped = strip_comments(src).unwrap();
    assert_eq!(count_code_lines(&stripped), 2);
    assert!(stripped.contains("a//b"));
}

#[test]
fn jslex_unterminated_block_fails_closed() {
    assert_eq!(
        strip_comments("/* never closed\nx();"),
        Err(LexError::UnterminatedBlockComment { line: 1 })
    );
}

#[test]
fn jslex_unterminated_string() {
    assert_eq!(
        strip_comments("x(\"abc\n);"),
        Err(LexError::UnterminatedString { line: 1 })
    );
}

#[test]
fn jslex_regex_literal_rejected() {
    assert_eq!(
        strip_comments("const r = /[/*]/;\nhidden();\nx(); /* */\n"),
        Err(LexError::AmbiguousSlash { line: 1 })
    );
}

#[test]
fn jslex_regex_after_control_paren_rejected() {
    assert_eq!(
        strip_comments("if (a) /[/*]/.test(s);\nhidden();\n"),
        Err(LexError::AmbiguousSlash { line: 1 })
    );
}

#[test]
fn jslex_regex_after_keyword_or_brace_rejected() {
    assert_eq!(
        strip_comments("return /x/;"),
        Err(LexError::AmbiguousSlash { line: 1 })
    );
    assert_eq!(
        strip_comments("}\n/[/*]/.test(s);"),
        Err(LexError::AmbiguousSlash { line: 2 })
    );
    assert_eq!(
        strip_comments("`a`/2"),
        Err(LexError::AmbiguousSlash { line: 1 })
    );
}

#[test]
fn jslex_division_allowed() {
    let src = "const h = w / 2;\nconst q = a[0]/b;\nconst r = n /* c */ / 4;\nconst s = f(x) / 2;\nconst t = (a + b) / 2;\nconst u = 1/3;\n";
    let stripped = strip_comments(src).unwrap();
    assert_eq!(count_code_lines(&stripped), 6);
    let line3 = stripped.lines().nth(2).unwrap();
    assert_eq!(line3, format!("const r = n{}/ 4;", " ".repeat(9)));
}

#[test]
fn jslex_template_substitution() {
    assert_eq!(count("const t = `a${b / 2}c${\"`\"}d`;\nx();\n"), 2);
    assert_eq!(
        strip_comments("const t = `${ /x/ }`;\n"),
        Err(LexError::AmbiguousSlash { line: 1 })
    );
}

#[test]
fn jslex_asi_and_tagged_template_rejected() {
    assert_eq!(
        strip_comments("break l\n/[/*]/.test(s);\nhidden();\n"),
        Err(LexError::AmbiguousSlash { line: 2 })
    );
    assert_eq!(
        strip_comments("x`${/[/*]/}`;\nhidden();\n"),
        Err(LexError::AmbiguousSlash { line: 1 })
    );
    assert_eq!(
        strip_comments("const a = b\n  / 2;\n"),
        Err(LexError::AmbiguousSlash { line: 2 })
    );
}

#[test]
fn jslex_line_terminators_rejected() {
    assert_eq!(
        strip_comments("// c\u{2028}eval(\"1\");\n"),
        Err(LexError::LineTerminator { line: 1 })
    );
    assert_eq!(
        strip_comments("// c\rx();\n"),
        Err(LexError::LineTerminator { line: 1 })
    );
}

#[test]
fn jslex_unsupported_constructs_rejected() {
    assert_eq!(
        strip_comments("<!-- /*\neval(\"1\");\n"),
        Err(LexError::UnsupportedComment { line: 1 })
    );
    assert_eq!(
        strip_comments("#!/*\neval(\"1\");\n"),
        Err(LexError::UnsupportedComment { line: 1 })
    );
    assert_eq!(
        strip_comments("\\u0065val(\"1\");"),
        Err(LexError::UnsupportedChar { line: 1 })
    );
    assert_eq!(
        strip_comments("a);"),
        Err(LexError::UnbalancedParen { line: 1 })
    );
    assert_eq!(
        strip_comments("return\u{00A0}/[/*]/;"),
        Err(LexError::UnsupportedChar { line: 1 })
    );
}

#[test]
fn shim_lex_error_fails_gate() {
    let r = lint_tree(&[("web/shim/boot.js", b"const r = /[/*]/;\neval(\"1\");\n")]);
    assert_eq!(r.violations.len(), 1, "{:?}", r.violations);
    let v = &r.violations[0];
    assert_eq!(v.rule, Rule::ShimLexError);
    assert_eq!(v.line, Some(1));
    assert!(v.message.contains("AmbiguousSlash"), "{}", v.message);
}

#[test]
fn shim_missing_dir() {
    let t = tree(&[]);
    let r = lint_files(t.path(), &files(&[])).unwrap();
    assert_eq!(rules(&r), vec![Rule::ShimDirMissing]);
}

#[test]
fn shim_budget_boundary_300_passes() {
    let r = lint_tree(&[("web/shim/boot.js", &lines(300))]);
    assert_eq!(r.total, 300);
    assert!(r.violations.is_empty(), "{:?}", r.violations);
}

#[test]
fn shim_budget_301_fails() {
    let r = lint_tree(&[
        ("web/shim/boot.js", &lines(200)),
        ("web/shim/net.js", &lines(101)),
    ]);
    assert_eq!(r.total, 301);
    assert_eq!(rules(&r), vec![Rule::ShimLineBudget]);
}

#[test]
fn shim_gen_named_files_are_counted() {
    let r = lint_tree(&[
        ("web/shim/boot.js", &lines(10)),
        ("web/shim/layout.gen.js", &lines(150)),
        ("web/shim/sub/x.gen.js", &lines(141)),
    ]);
    assert_eq!(r.total, 301);
    assert_eq!(rules(&r), vec![Rule::ShimLineBudget]);
}

#[test]
fn shim_gen_candidate_counted() {
    let r = lint_tree(&[
        ("web/shim/gen/dash-core-mt/dash_core_mt.js", &lines(400)),
        ("web/shim/boot.js", &lines(1)),
    ]);
    assert_eq!(r.total, 401);
    assert_eq!(rules(&r), vec![Rule::ShimLineBudget]);
}

fn git(root: &std::path::Path, args: &[&str]) {
    let st = Command::new("git")
        .args(args)
        .current_dir(root)
        .status()
        .unwrap();
    assert!(st.success(), "git {args:?}");
}

#[test]
fn shim_candidates_from_git() {
    let t = tree(&[
        (".gitignore", b"web/shim/gen/\n"),
        ("web/shim/a.js", b"x();\n"),
        ("web/shim/gen/c/c.js", b"x();\n"),
        ("web/shim/gen/c/forced.js", b"x();\n"),
        ("web/shim/b.js", b"x();\n"),
    ]);
    git(t.path(), &["init", "-q"]);
    git(t.path(), &["add", "web/shim/a.js"]);
    git(t.path(), &["add", "-f", "web/shim/gen/c/forced.js"]);
    let c = candidates(t.path()).unwrap();
    assert_eq!(
        c.candidates,
        vec![
            PathBuf::from("web/shim/a.js"),
            PathBuf::from("web/shim/b.js"),
            PathBuf::from("web/shim/gen/c/forced.js"),
        ]
    );
}

#[test]
fn shim_candidates_without_git_errors() {
    let t = tree(&[("web/shim/a.js", b"x();\n")]);
    assert!(matches!(candidates(t.path()), Err(XtaskError::Tool { .. })));
}

#[test]
fn shim_forbidden_tokens() {
    let r = lint_tree(&[
        ("web/shim/a.js", b"eval(\"1\");"),
        ("web/shim/b.js", b"\nnew Function(\"x\");"),
        ("web/shim/c.js", b"e.innerHTML = s;"),
        ("web/shim/d.js", b"// eval\nevaluate();"),
    ]);
    let got: Vec<(Rule, PathBuf, Option<u32>)> = r
        .violations
        .iter()
        .map(|v| (v.rule, v.path.clone(), v.line))
        .collect();
    assert_eq!(
        got,
        vec![
            (
                Rule::ShimForbiddenToken,
                PathBuf::from("web/shim/a.js"),
                Some(1)
            ),
            (
                Rule::ShimForbiddenToken,
                PathBuf::from("web/shim/b.js"),
                Some(2)
            ),
            (
                Rule::ShimForbiddenToken,
                PathBuf::from("web/shim/c.js"),
                Some(1)
            ),
        ]
    );
}

#[test]
fn shim_imports_allowed() {
    let r = lint_tree(&[
        (
            "web/shim/boot.js",
            b"import { p } from \"./net.js\";\nimport init from \"./gen/dash-core-mt/dash_core_mt.js\";\nconst w = new Worker(new URL(\"./worker.js\", import.meta.url), { type: \"module\" });\n",
        ),
        ("web/shim/net.js", b"x();\n"),
        ("web/shim/worker.js", b"x();\n"),
    ]);
    assert!(r.violations.is_empty(), "{:?}", r.violations);
}

#[test]
fn shim_imports_rejected() {
    let cases: [&[u8]; 10] = [
        b"import \"lib\";",
        b"import x from \"https://cdn.example.com/x.js\";",
        b"import x from \"/abs.js\";",
        b"import x from \"../outside.js\";",
        b"import x from \"./missing.js\";",
        b"import x from \"./gen/evil.js\";",
        b"import(name);",
        b"importScripts(\"./a.js\");",
        b"new Worker(u);",
        b"navigator.serviceWorker.register(u);",
    ];
    let names: Vec<String> = (0..cases.len())
        .map(|i| format!("web/shim/case{i}.js"))
        .collect();
    let fx: Vec<(&str, &[u8])> = names
        .iter()
        .map(String::as_str)
        .zip(cases.iter().copied())
        .collect();
    let r = lint_tree(&fx);
    assert_eq!(r.violations.len(), 10, "{:?}", r.violations);
    for name in &names {
        let per: Vec<_> = r
            .violations
            .iter()
            .filter(|v| v.path == PathBuf::from(name))
            .collect();
        assert_eq!(per.len(), 1, "{name}: {per:?}");
        assert_eq!(per[0].rule, Rule::ShimImport);
        assert_eq!(per[0].line, Some(1));
    }
}

#[test]
fn shim_repo_passes() {
    let r = lint(&xtask::repo_root().unwrap()).unwrap();
    assert!(r.violations.is_empty(), "{:?}", r.violations);
    assert_eq!(r.total, 0);
}
