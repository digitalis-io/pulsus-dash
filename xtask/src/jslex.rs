//! A fail-closed JS comment stripper for the shim lint (plan §4.2).

/// Why a JS source was rejected.
#[derive(Debug, PartialEq, Eq)]
pub enum LexError {
    UnterminatedBlockComment { line: u32 },
    UnterminatedString { line: u32 },
    UnterminatedTemplate { line: u32 },
    AmbiguousSlash { line: u32 },
    LineTerminator { line: u32 },
    UnsupportedComment { line: u32 },
    UnsupportedChar { line: u32 },
    UnbalancedParen { line: u32 },
}

/// Reserved words and contextual keywords after which `/` is never division.
pub const KEYWORDS: [&str; 50] = [
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
    "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
    "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true",
    "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "implements",
    "interface", "package", "private", "protected", "public", "await", "async", "of", "get",
    "set",
];

pub fn strip_comments(_src: &str) -> Result<String, LexError> {
    Ok(String::new())
}

pub fn count_code_lines(_stripped: &str) -> u32 {
    0
}
