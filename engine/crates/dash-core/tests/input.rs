//! unit:input-ring, decoder leg (plan #68 C2a1 §3.1, §3.2, §5 `ring_decode`, `ring_rollover`,
//! `ring_fixture`; T03-006, T03-019): the render worker reads [tail, head) in order, follows the
//! wrap marker, rejects a bad record with the rest of the batch, and always leaves tail = head;
//! the free-running `u32` counters roll over 2³² without losing a record; the TS `InputRing`'s
//! bytes (`engine/fixtures/input-ring.json`) decode to what it logged. Plan #68 C2b (§5
//! `ring_decode`): Overlay and Select records, an Overlay across the wrap, and a short Overlay.
//! Plan #68 C2d2 (§3.2, §5 `drain_batch`): the same bytes as one ST input batch decode to the
//! ring's records; a bad record mid-batch is `Bad` and the rest of the batch is skipped.
mod common;
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use common::{Block, Producer, Rec};
use dash_core::input::{Bad, Decoded, Record, drain, drain_batch, log_json};
use dash_protocol::RING_BYTES;
use dash_protocol::input::rec;
use serde_json::Value;

fn resize(frame: u32) -> Rec {
    Rec::Resize {
        frame,
        css: (1118.5, 240.25),
        dpr: 1.25,
        device: (1398, 300),
    }
}

#[test]
fn ring_decode() {
    let b = Block::default();
    let mut p = Producer::default();
    assert!(p.publish(&b, &resize(4), 1, 10.5));
    assert!(p.publish(&b, &Rec::camera(4, 1.0e12, 1.0e12 + 3.6e6), 2, 11.0));
    let mut out = Vec::new();
    assert_eq!(drain(&b, &mut out), Ok(()));
    assert_eq!(out.len(), 2);
    assert_eq!(
        out[0],
        Decoded {
            seq: 1,
            t_ms: 10.5,
            rec: Record::Resize {
                frame: 4,
                css_w: 1118.5,
                css_h: 240.25,
                dpr: 1.25,
                device_w: 1398,
                device_h: 300
            }
        }
    );
    assert_eq!((out[1].seq, out[1].t_ms), (2, 11.0));
    assert!(matches!(
        out[1].rec,
        Record::Camera { frame: 4, view, value, band }
            if view == (1.0e12, 1.0e12 + 3.6e6) && value.0.is_nan() && value.1.is_nan() && band.is_nan()
    ));
    assert_eq!(b.tail(), b.head());

    // A Camera at physical 65 512: 24 bytes are left, so a wrap marker there and the record at 0.
    let w = Block::default();
    w.start_at(RING_BYTES - 24);
    let mut p = Producer::default();
    assert!(p.publish(&w, &Rec::camera(1, 5.0, 6.0), 7, 1.0));
    assert_eq!(w.get(RING_BYTES - 24) & 0xFF, u32::from(rec::WRAP));
    let mut out = Vec::new();
    assert_eq!(drain(&w, &mut out), Ok(()));
    assert_eq!(out.len(), 1);
    assert!(matches!(
        out[0],
        Decoded {
            seq: 7,
            rec: Record::Camera {
                frame: 1,
                view: (5.0, 6.0),
                ..
            },
            ..
        }
    ));
    assert_eq!((w.tail(), w.head()), (RING_BYTES + 64, RING_BYTES + 64));

    // Plan #68 C2b: an Overlay at the wrap (24 bytes left), then a Select; an Overlay of 56 bytes.
    let o = Block::default();
    o.start_at(RING_BYTES - 24);
    let mut p = Producer::default();
    let ov = Rec::Overlay {
        frame: 3,
        hover: 1,
        boxed: 1,
        x: 320.25,
        y: 108.5,
        key: 0,
        box_x0: 100.0,
        box_x: 40.5,
    };
    assert!(p.publish(&o, &ov, 8, 2.0));
    assert_eq!(o.get(RING_BYTES - 24) & 0xFF, u32::from(rec::WRAP));
    let sel = Rec::Select {
        frame: 3,
        x: 12.5,
        y: -3.0,
    };
    assert!(p.publish(&o, &sel, 9, 3.0));
    let key = Rec::Overlay {
        frame: 3,
        hover: 2,
        boxed: 0,
        x: 0.0,
        y: 0.0,
        key: 60,
        box_x0: 0.0,
        box_x: 0.0,
    };
    assert!(p.publish(&o, &key, 10, 4.0));
    let mut out = Vec::new();
    assert_eq!(drain(&o, &mut out), Ok(()));
    assert_eq!(
        out,
        vec![
            Decoded {
                seq: 8,
                t_ms: 2.0,
                rec: Record::Overlay {
                    frame: 3,
                    hover: 1,
                    boxed: 1,
                    x: 320.25,
                    y: 108.5,
                    key: 0,
                    box_x0: 100.0,
                    box_x: 40.5
                }
            },
            Decoded {
                seq: 9,
                t_ms: 3.0,
                rec: Record::Select {
                    frame: 3,
                    x: 12.5,
                    y: -3.0
                }
            },
            Decoded {
                seq: 10,
                t_ms: 4.0,
                rec: Record::Overlay {
                    frame: 3,
                    hover: 2,
                    boxed: 0,
                    x: 0.0,
                    y: 0.0,
                    key: 60,
                    box_x0: 0.0,
                    box_x: 0.0
                }
            },
        ]
    );
    assert_eq!(o.tail(), o.head());
    let short = Block::default();
    let mut p = Producer::default();
    assert!(p.publish(
        &short,
        &Rec::Raw {
            kind: 0x24,
            size: 56
        },
        1,
        1.0
    ));
    let mut out = Vec::new();
    assert_eq!(
        drain(&short, &mut out),
        Err(Bad { at: 0 }),
        "an Overlay of 56 bytes"
    );
    assert!(out.is_empty());
    assert_eq!(short.tail(), short.head());

    // An unknown kind and a size below the header: the rest is skipped, tail = head.
    for (word0, name) in [
        (0x7E | (64 << 16), "kind 0x7E"),
        (u32::from(rec::CAMERA) | (12 << 16), "size 12"),
    ] {
        let k = Block::default();
        let mut p = Producer::default();
        assert!(p.publish(&k, &Rec::camera(1, 5.0, 6.0), 1, 1.0));
        assert!(p.publish(&k, &Rec::camera(1, 5.0, 7.0), 2, 1.0));
        assert!(p.publish(&k, &Rec::camera(1, 5.0, 8.0), 3, 1.0));
        k.put(64, word0);
        let mut out = Vec::new();
        assert_eq!(drain(&k, &mut out), Err(Bad { at: 64 }), "{name}");
        assert_eq!(out.len(), 1, "{name}: the record before the bad one");
        assert_eq!(k.tail(), k.head(), "{name}");
    }
}

#[test]
fn ring_rollover() {
    // (a) A full ring across 2³².
    let b = Block::default();
    b.start_at(0xFFFF_FF00);
    let mut p = Producer::default();
    for s in 1..=1024u32 {
        assert!(
            p.publish(
                &b,
                &Rec::camera(1, f64::from(s), f64::from(s) + 1.0),
                s,
                0.0
            ),
            "{s}"
        );
    }
    assert_eq!(b.head().wrapping_sub(b.tail()), 65_536);
    assert!(
        !p.publish(&b, &Rec::camera(1, 0.0, 1.0), 1025, 0.0),
        "no overwrite"
    );
    let mut out = Vec::new();
    assert_eq!(drain(&b, &mut out), Ok(()));
    let seqs: Vec<u32> = out.iter().map(|d| d.seq).collect();
    assert_eq!(seqs, (1..=1024).collect::<Vec<_>>());
    assert_eq!(b.tail(), 0xFF00);
    assert_eq!(b.head(), 0xFF00);

    // (b) The gap at the end of the ring as the counter rolls over.
    let g = Block::default();
    g.start_at(0xFFFF_FFE8);
    let mut p = Producer::default();
    assert!(p.publish(&g, &Rec::camera(2, 1.0, 2.0), 9, 0.0));
    assert_eq!(g.head(), 0x40);
    assert_eq!(g.get(0) & 0xFF, u32::from(rec::CAMERA));
    let mut out = Vec::new();
    assert_eq!(drain(&g, &mut out), Ok(()));
    assert_eq!(out.len(), 1);
    assert_eq!(g.tail(), 0x40);
}

/// Numbers as f64 (JSON writes a whole f64 as an integer).
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => serde_json::json!(n.as_f64()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .filter_map(|i| s.get(2 * i..2 * i + 2))
        .filter_map(|b| u8::from_str_radix(b, 16).ok())
        .collect()
}

#[test]
fn ring_fixture() {
    let rows = fixture::load("input-ring.json");
    assert_eq!(rows.len(), 1, "input-ring.json: one image");
    let img = &rows[0];
    let start = img["start"].as_u64().unwrap_or(0) as u32;
    let head = img["head"].as_u64().unwrap_or(0) as u32;
    assert_eq!(start, 0xFFFF_FF80);
    let bytes = hex(img["data"].as_str().unwrap_or(""));
    assert_eq!(bytes.len() as u32, head.wrapping_sub(start));
    let b = Block::default();
    b.start_at(start);
    for (i, w) in bytes.chunks(4).enumerate() {
        let phys = start.wrapping_add(4 * i as u32) & (RING_BYTES - 1);
        let mut le = [0u8; 4];
        le[..w.len()].copy_from_slice(w);
        b.put(phys, u32::from_le_bytes(le));
    }
    b.store_head(head);
    let mut out = Vec::new();
    assert_eq!(drain(&b, &mut out), Ok(()));
    let want = img["records"].as_array().cloned().unwrap_or_default();
    assert_eq!(want.len(), 40);
    let got: Vec<Value> = out.iter().map(|d| norm(&log_json(d))).collect();
    let want: Vec<Value> = want.iter().map(norm).collect();
    assert_eq!(got, want);
    assert_eq!(b.tail(), head);
    // The image has the gap: its first two records leave 24 bytes before the end.
    assert!(head < start, "the image rolls over 2³²");
}

/// The fixture's ring image as one byte batch, and the ring drain of the same bytes.
fn fixture_batch() -> (Vec<u8>, Vec<Decoded>) {
    let rows = fixture::load("input-ring.json");
    let img = &rows[0];
    let start = img["start"].as_u64().unwrap_or(0) as u32;
    let head = img["head"].as_u64().unwrap_or(0) as u32;
    let bytes = hex(img["data"].as_str().unwrap_or(""));
    let b = Block::default();
    b.start_at(start);
    for (i, w) in bytes.chunks(4).enumerate() {
        let phys = start.wrapping_add(4 * i as u32) & (RING_BYTES - 1);
        let mut le = [0u8; 4];
        le[..w.len()].copy_from_slice(w);
        b.put(phys, u32::from_le_bytes(le));
    }
    b.store_head(head);
    let mut ring = Vec::new();
    assert_eq!(drain(&b, &mut ring), Ok(()));
    (bytes, ring)
}

#[test]
fn drain_batch_decodes_as_the_ring() {
    let (bytes, ring) = fixture_batch();
    assert_eq!(ring.len(), 40);
    let mut out = Vec::new();
    assert_eq!(drain_batch(&bytes, &mut out), Ok(()));
    assert_eq!(out.len(), ring.len());
    let got: Vec<Value> = out.iter().map(|d| norm(&log_json(d))).collect();
    let want: Vec<Value> = ring.iter().map(|d| norm(&log_json(d))).collect();
    assert_eq!(got, want);

    // Appended to what is there.
    let mut more = vec![ring[0]];
    assert_eq!(drain_batch(&bytes, &mut more), Ok(()));
    assert_eq!(more.len(), 41);

    // An empty batch is no record.
    let mut none = Vec::new();
    assert_eq!(drain_batch(&[], &mut none), Ok(()));
    assert!(none.is_empty());
}

#[test]
fn drain_batch_bad_record_skips_the_rest() {
    let (bytes, ring) = fixture_batch();
    // The byte offset of record 10 in the batch: walk the sizes (a wrap marker carries its gap).
    let mut at = 0usize;
    let mut seen = 0;
    while seen < 10 {
        let kind = bytes[at];
        let size = u16::from_le_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        if kind != rec::WRAP {
            seen += 1;
        }
        at += size;
    }
    while bytes[at] == rec::WRAP {
        at += u16::from_le_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
    }
    for (what, patch) in [
        ("an unknown kind", [0x7Fu8, 0, 0, 0]),
        ("a size not a multiple of 8", [bytes[at], 0, 20, 0]),
        ("a size past the batch", [bytes[at], 0, 0, 0x80]),
        ("a size under the header", [bytes[at], 0, 8, 0]),
    ] {
        let mut bad = bytes.clone();
        bad[at..at + 4].copy_from_slice(&patch);
        let mut out = Vec::new();
        assert_eq!(
            drain_batch(&bad, &mut out),
            Err(Bad { at: at as u32 }),
            "{what}"
        );
        assert_eq!(out.len(), 10, "{what}: the records before it");
        assert_eq!(out[..], ring[..10], "{what}");
    }
    // A record cut off by the end of the batch.
    let mut out = Vec::new();
    assert_eq!(
        drain_batch(&bytes[..at + 20], &mut out),
        Err(Bad { at: at as u32 })
    );
    assert_eq!(out.len(), 10);
}
