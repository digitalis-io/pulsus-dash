fn seeded_clippy() -> u8 {
    return 1;
}

#[test]
fn seeded_clippy_runs() {
    assert_eq!(seeded_clippy(), 1);
}
