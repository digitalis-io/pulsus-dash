//! unit:fb-reader, aliasing without amplification (plan #68 B2 §3.3, review r1 finding 1): a
//! Schema whose KeyValue strings, or whose Field names, all reference one large string is
//! rejected as `Flatbuffer` before any string is copied, so decoding it allocates no more than
//! a small multiple of the message size. A counting global allocator (this test binary only)
//! measures the allocations of the `frame` call.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use dash_wire::{
    BodyDecoder, Event, Frame, FrameHeader, FrameType, IpcError, PartError, SharedBytes,
};

thread_local! {
    static ALLOCATED: Cell<usize> = const { Cell::new(0) };
}

struct Counting;

// SAFETY: every method forwards to `System` with the caller's arguments unchanged; the only
// addition is a thread-local counter, which does not allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = ALLOCATED.try_with(|a| a.set(a.get() + layout.size()));
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract for `layout`.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` was allocated by `System` (through `alloc`) with `layout`.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn put16(b: &mut [u8], at: usize, v: u16) {
    b[at..at + 2].copy_from_slice(&v.to_le_bytes());
}
fn put32(b: &mut [u8], at: usize, v: u32) {
    b[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

/// A Schema message flatbuffer with `fields` Field tables and `kvs` KeyValue tables. With
/// `shared`, every name, key and value references the one `big`-byte string at the end;
/// otherwise only the first reference exists (`fields` = 1, `kvs` = 0) and the buffer is valid.
fn schema(fields: usize, kvs: usize, big: usize) -> Vec<u8> {
    // Vtables: empty 4..8, Message 8..18, Schema 18..28, KeyValue 28..36, Field 36..48.
    let fields_vec = 76;
    let kv_vec = fields_vec + 4 + 4 * fields;
    let field0 = kv_vec + 4 + 4 * kvs;
    let kv0 = field0 + 16 * fields;
    let empty0 = kv0 + 12 * kvs;
    let s = empty0 + 4 * fields;
    let end = (s + 4 + big + 1).div_ceil(8) * 8;
    let mut b = vec![0u8; end];
    put32(&mut b, 0, 48);
    put16(&mut b, 4, 4);
    put16(&mut b, 6, 4);
    for (at, v) in [(8, 10), (10, 12), (12, 8), (14, 10), (16, 4)] {
        put16(&mut b, at, v);
    }
    for (at, v) in [(18, 10), (20, 12), (22, 0), (24, 4), (26, 8)] {
        put16(&mut b, at, v);
    }
    for (at, v) in [(28, 8), (30, 12), (32, 4), (34, 8)] {
        put16(&mut b, at, v);
    }
    for (at, v) in [(36, 12), (38, 16), (40, 4), (42, 0), (44, 12), (46, 8)] {
        put16(&mut b, at, v);
    }
    // Message: header → Schema at 64, version V5, header_type Schema.
    put32(&mut b, 48, 40);
    put32(&mut b, 52, 12);
    put16(&mut b, 56, 4);
    b[58] = 1;
    // Schema: fields and custom_metadata vectors.
    put32(&mut b, 64, 46);
    put32(&mut b, 68, (fields_vec - 68) as u32);
    put32(&mut b, 72, (kv_vec - 72) as u32);
    put32(&mut b, fields_vec, fields as u32);
    put32(&mut b, kv_vec, kvs as u32);
    for i in 0..fields {
        let e = fields_vec + 4 + 4 * i;
        let f = field0 + 16 * i;
        let t = empty0 + 4 * i;
        put32(&mut b, e, (f - e) as u32);
        put32(&mut b, f, (f - 36) as u32);
        put32(&mut b, f + 4, (s - (f + 4)) as u32);
        put32(&mut b, f + 8, (t - (f + 8)) as u32);
        b[f + 12] = 5; // Utf8
        put32(&mut b, t, (t - 4) as u32);
    }
    for i in 0..kvs {
        let e = kv_vec + 4 + 4 * i;
        let k = kv0 + 12 * i;
        put32(&mut b, e, (k - e) as u32);
        put32(&mut b, k, (k - 28) as u32);
        put32(&mut b, k + 4, (s - (k + 4)) as u32);
        put32(&mut b, k + 8, (s - (k + 8)) as u32);
    }
    put32(&mut b, s, big as u32);
    b[s + 4..s + 4 + big].fill(b'a');
    b
}

/// Decodes `meta` as the labels SCHEMA of part 1; returns its failure and the bytes the
/// `frame` call allocated.
fn decode(meta: &[u8]) -> (Option<PartError>, usize) {
    const OFFSET: usize = 16;
    let mut l = meta.len();
    while !(OFFSET + 8 + l).is_multiple_of(64) {
        l += 8;
    }
    let mut payload = vec![0xFF; 4];
    payload.extend_from_slice(&(l as i32).to_le_bytes());
    payload.extend_from_slice(meta);
    payload.resize(8 + l, 0);
    let frame = Frame {
        header: FrameHeader {
            kind: FrameType::Schema,
            flags: 0,
            part_id: 1,
            payload_len: payload.len() as u32,
            rank: 0,
        },
        payload: SharedBytes::copy_from(&payload, OFFSET),
        payload_offset: OFFSET as u64,
    };
    let mut d = BodyDecoder::new(1);
    ALLOCATED.with(|a| a.set(0));
    let ev = d.frame(frame);
    let allocated = ALLOCATED.with(Cell::get);
    let failure = ev.into_iter().find_map(|e| match e {
        Event::Failed { reason, .. } => Some(reason),
        _ => None,
    });
    (failure, allocated)
}

const BIG: usize = 256 << 10;

#[test]
fn the_layout_is_valid_without_aliasing() {
    // One field, no metadata: the flatbuffer passes; the schema check then refuses it.
    let (f, _) = decode(&schema(1, 0, BIG));
    assert!(matches!(f, Some(PartError::Schema(_))), "{f:?}");
}

#[test]
fn shared_key_value_strings_are_rejected_without_copying() {
    let meta = schema(0, 64, BIG);
    let (f, allocated) = decode(&meta);
    assert_eq!(f, Some(PartError::Ipc(IpcError::Flatbuffer)));
    assert!(
        allocated <= 2 * meta.len(),
        "{allocated} bytes allocated for a {}-byte message",
        meta.len()
    );
}

#[test]
fn shared_field_names_are_rejected_without_copying() {
    let meta = schema(64, 0, BIG);
    let (f, allocated) = decode(&meta);
    assert_eq!(f, Some(PartError::Ipc(IpcError::Flatbuffer)));
    assert!(
        allocated <= 2 * meta.len(),
        "{allocated} bytes allocated for a {}-byte message",
        meta.len()
    );
}
