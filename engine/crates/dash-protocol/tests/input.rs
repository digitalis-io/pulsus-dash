//! unit:input-ring, layout leg (plan #68 C2a1 §3.1, §5 `input_layout`, `seq`; T03-005, T03 §5.4):
//! the record kinds, sizes and payload offsets, the two new control words, the generated TS
//! constants and the worker's modular seq comparison. Plan #68 C2b (§3.1, §5 `input_layout`): the
//! Overlay (0x24, 64 B) and Select (0x25, 40 B) records.
use dash_protocol::input::{self, camera, header, overlay, rec, resize, select, seq_ge};
use dash_protocol::{REGIONS, gen_ts, off};

#[test]
fn input_layout() {
    assert_eq!(input::HEADER_BYTES, 16);
    assert_eq!((rec::WRAP, rec::RESIZE, rec::CAMERA), (0x00, 0x20, 0x23));
    assert_eq!((input::RESIZE_BYTES, input::CAMERA_BYTES), (40, 64));
    assert_eq!(input::RESIZE_BYTES % 8, 0);
    assert_eq!(input::CAMERA_BYTES % 8, 0);
    assert_eq!(
        (
            header::KIND,
            header::FLAGS,
            header::SIZE,
            header::SEQ,
            header::T_MS
        ),
        (0, 1, 2, 4, 8)
    );
    assert_eq!(
        [
            resize::CSS_W,
            resize::CSS_H,
            resize::DPR,
            resize::DEVICE_W,
            resize::DEVICE_H,
            resize::FRAME
        ],
        [16, 20, 24, 28, 32, 36]
    );
    assert_eq!(
        [
            camera::FRAME,
            camera::VIEW_LO,
            camera::VIEW_HI,
            camera::VALUE_MIN,
            camera::VALUE_MAX,
            camera::BAND
        ],
        [16, 24, 32, 40, 48, 56]
    );
    // INPUT_IDLE shares the tail's line (render → main), not the head's.
    assert_eq!(off::INPUT_IDLE, 0xC8);
    assert_eq!(off::INPUT_IDLE / 64, off::INPUT_TAIL / 64);
    assert_ne!(off::INPUT_IDLE / 64, off::INPUT_HEAD / 64);
    // INPUT_BAD is a runtime counter past the frame statistics (0x4400–0x4D0F).
    assert_eq!(off::INPUT_BAD, 0x4D10);
    let counters = REGIONS.iter().find(|r| r.name == "counters");
    assert!(
        counters
            .is_some_and(|r| off::INPUT_BAD >= r.offset && off::INPUT_BAD + 4 <= r.offset + r.size),
        "{counters:?}"
    );
    assert!(off::ALL.contains(&("INPUT_IDLE", 0xC8)));
    assert!(off::ALL.contains(&("INPUT_BAD", 0x4D10)));
    // Plan #68 C2b §3.1: Overlay and Select; 0x26 stays reserved.
    assert_eq!((rec::OVERLAY, rec::SELECT), (0x24, 0x25));
    assert_eq!((input::OVERLAY_BYTES, input::SELECT_BYTES), (64, 40));
    assert_eq!(input::OVERLAY_BYTES % 8, 0);
    assert_eq!(input::SELECT_BYTES % 8, 0);
    assert_eq!(
        [
            overlay::FRAME,
            overlay::HOVER,
            overlay::BOX,
            overlay::X,
            overlay::Y,
            overlay::KEY,
            overlay::BOX_X0,
            overlay::BOX_X
        ],
        [16, 20, 21, 24, 32, 40, 48, 56]
    );
    assert_eq!([select::FRAME, select::X, select::Y], [16, 24, 32]);
    let ts = gen_ts();
    for line in [
        "export const REC_OVERLAY = 36;\n",
        "export const REC_SELECT = 37;\n",
        "export const REC_OVERLAY_BYTES = 64;\n",
        "export const REC_SELECT_BYTES = 40;\n",
        "export const OVERLAY_FRAME = 16;\n",
        "export const OVERLAY_HOVER = 20;\n",
        "export const OVERLAY_BOX = 21;\n",
        "export const OVERLAY_X = 24;\n",
        "export const OVERLAY_Y = 32;\n",
        "export const OVERLAY_KEY = 40;\n",
        "export const OVERLAY_BOX_X0 = 48;\n",
        "export const OVERLAY_BOX_X = 56;\n",
        "export const SELECT_FRAME = 16;\n",
        "export const SELECT_X = 24;\n",
        "export const SELECT_Y = 32;\n",
    ] {
        assert!(ts.contains(line), "{line:?} not in\n{ts}");
    }
    for line in [
        "export const OFF_INPUT_IDLE = 200;\n",
        "export const OFF_INPUT_BAD = 19728;\n",
        "export const REC_WRAP = 0;\n",
        "export const REC_RESIZE = 32;\n",
        "export const REC_CAMERA = 35;\n",
        "export const REC_HEADER_BYTES = 16;\n",
        "export const REC_RESIZE_BYTES = 40;\n",
        "export const REC_CAMERA_BYTES = 64;\n",
        "export const RESIZE_FRAME = 36;\n",
        "export const CAMERA_BAND = 56;\n",
    ] {
        assert!(ts.contains(line), "{line:?} not in\n{ts}");
    }
}

#[test]
fn seq() {
    assert!(seq_ge(0x7FFF_FFFF, 0));
    assert!(!seq_ge(0x8000_0000, 0));
    assert!(seq_ge(0x8000_0000, 0x7FFF_FFFF));
    assert!(!seq_ge(0x7FFF_FFFF, 0x8000_0000));
    assert!(seq_ge(1, 0xFFFF_FFFF));
    assert!(!seq_ge(0xFFFF_FFFF, 1));
    assert!(seq_ge(5, 5));
}
