//! unit:control-block-layout (plan #68 C1 §3.2, §5; T03-005): the v1 offsets are the T03 §4.3
//! table, the regions tile the block without overlap, and the committed `layout.gen.ts` is
//! `gen_ts()`.
use dash_protocol::{CB_ALIGN, CB_BYTES, LAYOUT_VERSION, REGIONS, Status, caps, gen_ts, off};

#[test]
fn offsets_are_the_t03_table() {
    assert_eq!(LAYOUT_VERSION, 1);
    assert_eq!((CB_BYTES, CB_ALIGN), (0x40000, 64));
    let want: [(&str, u32); 17] = [
        ("MAGIC", 0x00),
        ("LAYOUT_VERSION", 0x04),
        ("CAPS", 0x08),
        ("BOOT_EPOCH", 0x0C),
        ("BUILD_ID", 0x10),
        ("STATUS", 0x20),
        ("FRAME_NO", 0x40),
        ("LAST_PRESENT_MS", 0x48),
        ("VSYNC_MS", 0x50),
        ("VISIBLE", 0x54),
        ("INPUT_HEAD", 0x80),
        ("INPUT_TAIL", 0xC0),
        ("INPUT_OVERFLOW", 0xC4),
        ("CHORDS", 0x100),
        ("COPY", 0x400),
        ("COUNTERS", 0x4400),
        ("INPUT_DATA", 0x10000),
    ];
    assert_eq!(off::ALL, want);
    // The regions are in order, 64-byte aligned and never overlap; the last ends the block.
    for w in REGIONS.windows(2) {
        assert!(w[0].offset + w[0].size <= w[1].offset, "{:?} overlaps {:?}", w[0], w[1]);
        assert_eq!(w[1].offset % CB_ALIGN, 0, "{:?}", w[1]);
    }
    assert_eq!(REGIONS.last().map(|r| r.offset), Some(CB_BYTES));
    let codes: Vec<u32> = Status::ALL.iter().map(|s| *s as u32).collect();
    assert_eq!(codes, [0, 1, 2, 3, 4, 5]);
    assert_eq!(Status::from_u32(2), Some(Status::TierT2));
    assert_eq!(Status::from_u32(6), None);
    assert_eq!(
        caps::ALL.map(|(_, b)| b),
        [1, 2, 4, 8, 16, 32],
        "T03 §9.1 bit order"
    );
}

#[test]
fn committed_layout_gen_ts_is_generated() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../client/src/engine/wasm/layout.gen.ts");
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    let generated = gen_ts();
    assert!(generated.starts_with("// Generated"), "{generated:?}");
    assert!(generated.contains("export const OFF_STATUS = 32;\n"), "{generated}");
    assert!(generated.contains("export const STATUS_TIER_T2 = 2;\n"), "{generated}");
    assert_eq!(committed, generated, "{}: run cargo xtask gen-layout", path.display());
}
