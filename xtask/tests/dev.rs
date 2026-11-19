#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `cargo xtask dev` helpers: `dev/local.env` and the Dex config (plan §3.10).

use xtask::dev::{merge_local_env, render_dex};

fn get<'a>(env: &'a [(String, String)], k: &str) -> Option<&'a str> {
    env.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str())
}

#[test]
fn local_env_parsing() {
    let env = vec![("A".to_string(), "9".to_string())];
    let merged = merge_local_env("# c\n\nA=1\nB=\"two\"\nC=x=y\n", &env);
    assert_eq!(get(&merged, "A"), Some("9"));
    assert_eq!(get(&merged, "B"), Some("two"));
    assert_eq!(get(&merged, "C"), Some("x=y"));
    assert_eq!(merged.iter().filter(|(k, _)| k == "A").count(), 1);
    assert_eq!(merged.len(), 3);
}

#[test]
fn dex_render_has_hash_not_password() {
    let root = xtask::repo_root().unwrap();
    let tmpl = std::fs::read_to_string(root.join("dev/dex.yaml.tmpl")).unwrap();
    let password = "Fixed-Password-For-Test1";
    let out = render_dex(&tmpl, 6556, password).unwrap();
    assert!(out.contains("issuer: http://localhost:6556/dex"), "{out}");
    assert!(!out.contains(password));
    assert!(!out.contains("@@"), "{out}");
    let hash = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("hash: "))
        .unwrap()
        .trim_matches('"')
        .to_string();
    assert!(hash.starts_with("$2b$10$"), "{hash}");
    assert!(bcrypt::verify(password, &hash).unwrap());
    let v: serde_norway::Value = serde_norway::from_str(&out).unwrap();
    assert_eq!(
        v["staticClients"][0]["id"].as_str(),
        Some("pulsus-dash-dev")
    );
    assert_eq!(
        v["staticPasswords"][0]["email"].as_str(),
        Some("dev@example.com")
    );
}
