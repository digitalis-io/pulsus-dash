#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `ci migrations` file-level rules (T11-001, T11-013): plan §3.8.

use std::path::Path;

use xtask::migrations::lint_text;
use xtask::report::Rule;

#[test]
fn migration_lint_rules() {
    let ext = lint_text(Path::new("m/1.sql"), "CREATE EXTENSION pg_trgm;\n");
    assert_eq!(ext.len(), 1, "{ext:?}");
    assert_eq!(ext[0].rule, Rule::MigrationExtension);
    assert_eq!(ext[0].line, Some(1));
    let commented = lint_text(Path::new("m/2.sql"), "-- CREATE EXTENSION x\nSELECT 1;\n");
    assert!(commented.is_empty(), "{commented:?}");
    let attach = lint_text(
        Path::new("m/3.sql"),
        "ALTER TABLE events ATTACH PARTITION events_2026 FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');\n",
    );
    assert_eq!(attach.len(), 1, "{attach:?}");
    assert_eq!(attach[0].rule, Rule::MigrationLint);
    let validated = lint_text(
        Path::new("m/4.sql"),
        "ALTER TABLE events_2026 VALIDATE CONSTRAINT events_2026_range;\nALTER TABLE events ATTACH PARTITION events_2026 FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');\n",
    );
    assert!(validated.is_empty(), "{validated:?}");
}
