//! Helpers of unit:dsf-limits (plan #68 B3 §5): the shared limit files, coverage/error message
//! builders, frames re-targeted to other part ids, and a driver that observes the decoder after
//! every frame.
#![allow(dead_code)]

use crate::common::{Body, F, Msg, Piece, Tb, V, encode_pieces, fixture_dir, header, parse};
use dash_wire::{BodyDecoder, Event, Frame, FrameSplitter, Limits, SharedBytes};
use std::path::PathBuf;

pub fn schemas_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../wire/schemas")
}

/// `wire/schemas/<name>` parsed.
pub fn limits_json(name: &str) -> serde_json::Value {
    let p = schemas_dir().join(name);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

pub fn num(v: &serde_json::Value, k: &str) -> u64 {
    v.get(k)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_else(|| panic!("limits: {k}"))
}

/// A limit set from a limits file.
pub fn limits_from(name: &str) -> Limits {
    let v = limits_json(name);
    let u = |k: &str| num(&v, k) as usize;
    Limits {
        open_parts: u("open_parts"),
        distinct_parts: u("distinct_parts"),
        rows_per_batch_labels: u("rows_per_batch_labels"),
        rows_per_batch_grid: u("rows_per_batch_grid"),
        series_per_part: u("series_per_part"),
        label_rows_per_part: u("label_rows_per_part"),
        label_bytes_per_part: u("label_bytes_per_part"),
        meta_list_elements: u("meta_list_elements"),
        meta_string_bytes: u("meta_string_bytes"),
        body_budget: num(&v, "body_budget"),
        value_budget: num(&v, "value_budget"),
    }
}

/// `wire/schemas/limits-test.json`, the set of the `limits-*.dsf` fixtures.
pub fn test_limits() -> Limits {
    limits_from("limits-test.json")
}

/// The committed `limits-*.dsf` fixtures (and `budget-over.dsf`), by name.
pub fn limit_fixtures() -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(fixture_dir())
        .unwrap_or_else(|e| panic!("fixtures: {e}"))
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|n| n.strip_suffix(".dsf").map(str::to_owned))
        .filter(|n| n.starts_with("limits-") || n == "budget-over")
        .collect();
    out.sort();
    out
}

// ---------------------------------------------------------------------------------------------
// coverage/1 and error/1 batches (B1's layout: 8-aligned buffers, null slots zero)

fn null_fixed(b: &mut Body, width: usize) {
    b.node(1, 1);
    b.buf(&[0]);
    b.buf(&vec![0; width]);
}

fn list(b: &mut Body, items: &[&[u8]]) {
    b.node(1, 0);
    b.buf(&[]);
    let mut offs = 0i32.to_le_bytes().to_vec();
    offs.extend_from_slice(&(items.len() as i32).to_le_bytes());
    b.buf(&offs);
    let vals: Vec<Option<&[u8]>> = items.iter().map(|i| Some(*i)).collect();
    b.utf8(&vals, false);
}

/// A one-row `coverage/1` batch: `phase`, `truncation_reason`, the four lists (excluded_dims,
/// warnings, infos, upstream_query_ids); every other nullable column null, counters 0.
pub fn coverage_batch(phase: u8, reason: Option<&[u8]>, lists: [&[&[u8]]; 4]) -> Msg {
    let mut b = Body::new(8, 1);
    b.fixed(&[phase], 1);
    b.fixed(&[4], 1); // exactness unknown
    null_fixed(&mut b, 4); // rollup_level_s
    null_fixed(&mut b, 8); // sampled_ratio
    b.node(1, 0); // truncated
    b.buf(&[]);
    b.buf(&[0]);
    b.utf8(&[reason], false);
    null_fixed(&mut b, 8); // dropped_count
    b.fixed(&0u32.to_le_bytes(), 1); // series_returned
    for w in [8, 8, 2, 2, 8] {
        null_fixed(&mut b, w); // rows_read … retention_floor
    }
    for l in lists {
        list(&mut b, l);
    }
    for w in [1, 8, 8] {
        null_fixed(&mut b, w); // read_cache, read_cache_through, data_end
    }
    b.fixed(&0u32.to_le_bytes(), 1);
    b.fixed(&0u32.to_le_bytes(), 1);
    b.finish(1)
}

/// A one-row `error/1` batch.
pub fn error_batch(message: &[u8], suggestion: Option<&[u8]>) -> Msg {
    let mut b = Body::new(8, 1);
    b.fixed(&[8], 1);
    b.fixed(&500u16.to_le_bytes(), 1);
    b.utf8(&[Some(message)], false);
    null_fixed(&mut b, 4);
    null_fixed(&mut b, 4);
    b.utf8(&[suggestion], false);
    b.finish(1)
}

/// A META or ERROR frame: the schema message of `like` (a fixture frame), `batch`, EOS.
pub fn stream_frame(like: &F, flags: u16, part: u32, batch: Msg) -> F {
    F::new(
        like.kind,
        flags,
        part,
        like.rank,
        vec![Piece::M(like.msg(0).clone()), Piece::M(batch), Piece::Eos],
    )
}

/// The grid-empty fixture's frames: SCHEMA(1), META(2, planned), SCHEMA(2), BATCH(1)|LAST,
/// META(2)|LAST, END.
pub fn empty_frames() -> Vec<F> {
    parse(&crate::common::fixture("grid-empty"))
}

/// A `metric_matrix.grid/1` SCHEMA message like grid-empty's (labels part 1) with `len` points
/// and, when `planned` is set, a `dash.planned` value.
pub fn grid_schema(len: u32, planned: Option<&str>) -> Msg {
    let m = empty_frames()[2].msg(0).clone();
    m.edit(|t| {
        crate::common::set_kv(t, "dash.grid.len", &len.to_string());
        if let Some(p) = planned {
            crate::common::set_kv(t, "dash.planned", p);
        }
        let fields = t.t_mut(2).tv_mut(1);
        fields[1].t_mut(3).set_int(0, 4, i64::from(len));
    })
}

/// The accounted cost of a SCHEMA message (B3 §3.1): 256 + field names (children included) +
/// metadata keys and values, read from its flatbuffer tree.
pub fn schema_cost(m: &Msg) -> u64 {
    fn names(f: &Tb) -> u64 {
        let own = f.string(0).map_or(0, |s| s.len() as u64);
        let kids = match f.f.get(&5) {
            Some(V::Tv(c)) => c.iter().map(names).sum(),
            _ => 0,
        };
        own + kids
    }
    let t = m.tree();
    let s = t.t(2);
    let fields: u64 = s.tv(1).iter().map(names).sum();
    let kvs: u64 = s
        .tv(2)
        .iter()
        .map(|kv| {
            (kv.string(0).unwrap_or_default().len() + kv.string(1).unwrap_or_default().len()) as u64
        })
        .sum();
    256 + fields + kvs
}

/// Appends frame `f` encoded at its body position.
pub fn append(out: &mut Vec<u8>, f: &F) {
    let payload = match &f.raw {
        Some(r) => r.clone(),
        None => encode_pieces(&f.pieces, out.len() + 16),
    };
    out.extend_from_slice(&header(
        1,
        f.kind,
        f.flags,
        f.part,
        payload.len() as u32,
        f.rank,
        0,
    ));
    out.extend_from_slice(&payload);
}

/// The frames of a well-formed body, sliced out of one copy.
pub fn frames_of(body: &[u8]) -> Vec<Frame> {
    let mut s = FrameSplitter::new();
    let mut out = Vec::new();
    if s.push(SharedBytes::copy_from(body, 0)).is_err() {
        panic!("push");
    }
    while let Ok(Some(f)) = s.next() {
        out.push(f);
    }
    out
}

/// `f` for part `part` at a body offset `shift` (a multiple of 64) later.
pub fn retarget(f: &Frame, part: u32, shift: u64) -> Frame {
    let mut g = f.clone();
    g.header.part_id = part;
    g.payload_offset += shift;
    g
}

/// Feeds frames to `d`, calling `after(d, i, events)` after each.
pub fn feed(
    d: &mut BodyDecoder,
    frames: impl IntoIterator<Item = Frame>,
    mut after: impl FnMut(&BodyDecoder, usize, &[Event]),
) -> Vec<Event> {
    let mut all = Vec::new();
    for (i, f) in frames.into_iter().enumerate() {
        let ev = d.frame(f);
        after(d, i, &ev);
        all.extend(ev);
    }
    all
}

/// A whole body through the splitter (one copy) and a decoder with `limits`, checking after
/// every frame that the body budget is never exceeded; the events with `finish`.
pub fn decode_with(body: &[u8], limits: Limits) -> (Vec<Event>, BodyDecoder) {
    let mut d = BodyDecoder::with_limits(1, limits);
    let mut ev = feed(&mut d, frames_of(body), |d, i, _| {
        assert!(
            d.retained().2 <= limits.body_budget,
            "frame {i}: {:?}",
            d.retained()
        );
    });
    ev.extend(d.finish());
    (ev, d)
}
