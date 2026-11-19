#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Input record decode/encode (T03 §5.4).

use dash_protocol::input::{DecodeError, InputRecord, PointerPhase, RecordHeader, decode, encode};

fn header(kind: u8, size: u16, seq: u32, t_ms: f64) -> Vec<u8> {
    let mut b = vec![kind, 0];
    b.extend_from_slice(&size.to_le_bytes());
    b.extend_from_slice(&seq.to_le_bytes());
    b.extend_from_slice(&t_ms.to_le_bytes());
    b
}

#[test]
fn decode_pointer_record() {
    let mut b = header(0x02, 40, 9, 1234.5);
    b.extend_from_slice(&12.5f32.to_le_bytes());
    b.extend_from_slice(&7.25f32.to_le_bytes());
    b.extend_from_slice(&3u32.to_le_bytes());
    b.extend_from_slice(&0b101u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&[0, 0, 128, 0, 1, 1, 0, 0]);
    assert_eq!(b.len(), 40);
    let (h, r) = decode(&b).unwrap();
    assert_eq!(
        h,
        RecordHeader {
            kind: 0x02,
            flags: 0,
            size: 40,
            seq: 9,
            t_ms: 1234.5
        }
    );
    assert_eq!(
        r,
        InputRecord::Pointer {
            phase: PointerPhase::Move,
            x: 12.5,
            y: 7.25,
            pointer_id: 3,
            mods: 0b101,
            buttons: 1,
            button: 0,
            ptype: 0,
            pressure: 128,
            width: 1,
            height: 1,
            tilt_x: 0,
            tilt_y: 0,
        }
    );
}

#[test]
fn decode_wheel_resize_visibility() {
    let cases = [
        (
            0x05,
            InputRecord::Wheel {
                x: 4.0,
                y: 5.0,
                dx: 1.5,
                dy: -3.0,
                mods: 0,
                mode: 1,
            },
            40,
        ),
        (
            0x20,
            InputRecord::Resize {
                css_w: 800.0,
                css_h: 600.0,
                dpr: 2.0,
                device_w: 1600,
                device_h: 1200,
            },
            40,
        ),
        (0x21, InputRecord::Visibility(2), 24),
    ];
    for (i, (kind, rec, size)) in cases.into_iter().enumerate() {
        let h = RecordHeader {
            kind,
            flags: 1,
            size: 0,
            seq: i as u32,
            t_ms: 10.0 + i as f64,
        };
        let bytes = encode(&h, &rec);
        assert_eq!(bytes.len(), size, "{rec:?}");
        let (h2, r2) = decode(&bytes).unwrap();
        assert_eq!(
            h2,
            RecordHeader {
                size: size as u16,
                ..h
            }
        );
        assert_eq!(r2, rec);
    }
}

#[test]
fn decode_rejects_bad_sizes() {
    let mut b = header(0x02, 12, 0, 0.0);
    b.resize(40, 0);
    assert_eq!(decode(&b), Err(DecodeError::BadSize { size: 12 }));
    let mut b = header(0x02, 44, 0, 0.0);
    b.resize(48, 0);
    assert_eq!(decode(&b), Err(DecodeError::BadSize { size: 44 }));
    let mut b = header(0x01, 48, 0, 0.0);
    b.resize(48, 0);
    assert_eq!(
        decode(&b),
        Err(DecodeError::BadKindSize { kind: 1, size: 48 })
    );
    let mut b = header(0x02, 40, 0, 0.0);
    b.resize(32, 0);
    assert_eq!(decode(&b), Err(DecodeError::BadSize { size: 40 }));
    assert_eq!(decode(&[0x02, 0, 40]), Err(DecodeError::Short));
}
