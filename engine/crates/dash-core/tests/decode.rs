//! The MT decode service (plan #68 D2 §3.2, §5): `decode_service`, `limit_fallback`,
//! `invalid_body`, `chunk_ids` and `chunk_table`, on a native rayon pool. A counting global
//! allocator (this test binary only) bounds the allocations of the limit cases.
//!
//! `engine/fixtures/range-decoded/<case>.json` holds the message each route fixture
//! (`wire/fixtures/route/`) decodes to, every f64 as its 16-digit hex bit pattern. They are
//! written by the sequential reference below (`DASH_FIXTURE_UPDATE=1`), independent of the service.
#![cfg(feature = "mt")]

#[path = "../../dash-wire/tests/common/mod.rs"]
#[allow(dead_code, clippy::all)]
mod wirekit;

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dash_core::decode::{ChunkTable, DecodeService, Done, Failure};
use dash_wire::{
    BodyDecoder, Chunk, ChunkBuilder, ChunkId, Coverage, DsfError, ErrorRow, Event, FrameSplitter,
    MAX_GRID_LEN, MAX_PAYLOAD, PartError, SeriesMeta, SharedBytes, TimeAxis,
};
use serde_json::{Map, Value, json};

// ---------------------------------------------------------------------------------------------
// A counting allocator: the largest allocation, and how many of one watched size.

static LARGEST: AtomicUsize = AtomicUsize::new(0);
static WATCH: AtomicUsize = AtomicUsize::new(0);
static HITS: AtomicUsize = AtomicUsize::new(0);

struct Counting;

// SAFETY: every method forwards to `System` with the caller's arguments unchanged; the only
// additions are atomic counters, which do not allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LARGEST.fetch_max(layout.size(), Ordering::Relaxed);
        if layout.size() == WATCH.load(Ordering::Relaxed) {
            HITS.fetch_add(1, Ordering::Relaxed);
        }
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

// ---------------------------------------------------------------------------------------------
// Fixtures

/// The cases with a JSON pair, the failure classes and the D1 DSF-only bodies.
const CASES: [&str; 15] = [
    "two-series",
    "gaps",
    "empty",
    "types-warning",
    "read-cache",
    "future-sample",
    "many",
    "mid-failure-query-invalid",
    "mid-failure-too-broad",
    "mid-failure-rate-limited",
    "mid-failure-timeout",
    "mid-failure-unavailable",
    "mid-failure-internal",
    "limits-many",
    "refused-open-parts",
];

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn route(name: &str) -> Vec<u8> {
    let p = root()
        .join("wire/fixtures/route")
        .join(format!("{name}.dsf"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

fn decoded_path(name: &str) -> PathBuf {
    root()
        .join("engine/fixtures/range-decoded")
        .join(format!("{name}.json"))
}

fn decoded_fixture(name: &str) -> Value {
    let p = decoded_path(name);
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

fn hex(v: f64) -> Value {
    Value::String(format!("{:016x}", v.to_bits()))
}

// ---------------------------------------------------------------------------------------------
// The sequential reference: the whole body through `FrameSplitter` and `BodyDecoder` at once.

fn strs<'a>(it: impl Iterator<Item = &'a str>) -> Value {
    Value::Array(it.map(|s| Value::String(s.to_owned())).collect())
}

fn coverage_json(c: &Coverage) -> Value {
    json!({
        "truncated": c.truncated,
        "truncation_reason": c.truncation_reason.as_deref(),
        "warnings": strs(c.warnings.iter()),
        "infos": strs(c.infos.iter()),
        "upstream_query_ids": strs(c.upstream_query_ids.iter()),
        "read_cache": c.read_cache,
        "read_cache_through": c.read_cache_through,
        "data_end": c.data_end,
    })
}

fn row_json(r: &ErrorRow) -> Value {
    json!({
        "code": r.code,
        "http_status": r.http_status,
        "message": &*r.message,
        "position": r.position,
        "retry_after_ms": r.retry_after_ms,
        "suggestion": r.suggestion.as_deref(),
    })
}

fn labels_json(m: &SeriesMeta) -> Value {
    let mut o = Map::new();
    for (k, v) in m.labels.iter() {
        o.insert(k.clone(), Value::String(v.clone()));
    }
    Value::Object(o)
}

fn valid(c: &Chunk, i: usize) -> bool {
    c.present
        .as_ref()
        .is_none_or(|w| w.get(i / 64).is_some_and(|w| w >> (i % 64) & 1 == 1))
}

fn events_of(body: &[u8]) -> Vec<Event> {
    let mut s = FrameSplitter::new();
    let mut d = BodyDecoder::new(1);
    let mut ev = Vec::new();
    match s.push(SharedBytes::copy_from(body, 0)) {
        Err(e) => ev.extend(d.fail_stream(e)),
        Ok(()) => loop {
            match s.next() {
                Ok(Some(f)) => ev.extend(d.frame(f)),
                Ok(None) => break,
                Err(e) => {
                    ev.extend(d.fail_stream(e));
                    break;
                }
            }
        },
    }
    if let Err(e) = s.finish() {
        ev.extend(d.fail_stream(e));
    }
    ev.extend(d.finish());
    ev
}

fn kind_of(r: &PartError) -> Failure {
    match r {
        PartError::Limit(_)
        | PartError::Stream(DsfError::Limit(_) | DsfError::PayloadTooLarge(_)) => Failure::Limit,
        PartError::Chunk(_) => Failure::Ids,
        _ => Failure::Invalid,
    }
}

/// The message of `body` in the fixture form: `decoded` (head, `ts`, `vs`) or `decode-failed`.
fn reference(body: &[u8]) -> Value {
    let ev = events_of(body);
    let mut grid = None;
    let mut chunks = Vec::new();
    let mut coverage = None;
    for e in &ev {
        match e {
            Event::Grid { part, info, .. } => grid = Some((*part, info.clone())),
            Event::Chunk { chunk, .. } => chunks.push(chunk.clone()),
            Event::Coverage { part, coverage: c }
                if grid.as_ref().is_some_and(|g| g.0 == *part) =>
            {
                coverage = Some(c.clone());
            }
            Event::Upstream { error, .. } => {
                return json!({
                    "t": "decode-failed",
                    "kind": "error",
                    "row": row_json(error),
                    "coverage": coverage.as_ref().map(coverage_json),
                    "planned": grid.as_ref().and_then(|g| g.1.planned.as_deref()),
                    "message": &*error.message,
                });
            }
            Event::Failed { reason, .. } => {
                return json!({"t": "decode-failed", "kind": kind_of(reason).as_str()});
            }
            _ => {}
        }
    }
    let (_, info) = grid.unwrap_or_else(|| panic!("no grid part"));
    let len = info.len as usize;
    let ts: Vec<Value> = (0..len)
        .map(|k| hex((info.start_ms + info.step_ms * k as i64) as f64))
        .collect();
    let mut series = Vec::new();
    let mut vs = Vec::new();
    for c in &chunks {
        for (s, m) in c.series.iter().enumerate() {
            series.push(json!({"key": format!("{:016x}", m.key_hash), "labels": labels_json(m)}));
            let base = c.offsets[s] as usize;
            vs.push(Value::Array(
                (0..len)
                    .map(|k| {
                        let i = base + k;
                        hex(if valid(c, i) { c.values[i] } else { f64::NAN })
                    })
                    .collect(),
            ));
        }
    }
    json!({
        "t": "decoded",
        "head": {
            "startMs": info.start_ms,
            "endMs": info.start_ms + (len as i64 - 1) * info.step_ms,
            "stepMs": info.step_ms,
            "planned": info.planned.as_deref(),
            "coverage": coverage.as_ref().map(coverage_json),
            "series": series,
        },
        "ts": ts,
        "vs": vs,
    })
}

/// A service result in the fixture form (no `req`, `chunk` or `epoch`).
fn message(d: &Done) -> Value {
    match d {
        Done::Decoded(m) => json!({
            "t": "decoded",
            "head": m.head,
            "ts": m.ts.iter().copied().map(hex).collect::<Vec<_>>(),
            "vs": m.vs.iter().map(|v| v.iter().copied().map(hex).collect::<Vec<_>>()).collect::<Vec<_>>(),
        }),
        Done::Failed(f) if f.kind == Failure::Error => json!({
            "t": "decode-failed",
            "kind": "error",
            "row": f.row,
            "coverage": f.coverage,
            "planned": f.planned,
            "message": f.message,
        }),
        Done::Failed(f) => json!({"t": "decode-failed", "kind": f.kind.as_str()}),
        Done::Credit { .. } => json!({"t": "decode-credit"}),
    }
}

#[test]
fn range_decoded_fixtures_are_current() {
    let update = std::env::var("DASH_FIXTURE_UPDATE").is_ok_and(|v| v == "1");
    for name in CASES {
        let want = reference(&route(name));
        if update {
            let p = decoded_path(name);
            std::fs::create_dir_all(p.parent().unwrap_or_else(|| panic!("dir")))
                .unwrap_or_else(|e| panic!("{e}"));
            let text = serde_json::to_string_pretty(&want).unwrap_or_else(|e| panic!("{e}"));
            std::fs::write(&p, text + "\n").unwrap_or_else(|e| panic!("{e}"));
            continue;
        }
        assert_eq!(
            decoded_fixture(name),
            want,
            "{name} (DASH_FIXTURE_UPDATE=1 rewrites)"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Driving the service

/// mulberry32 (the TS tests' PRNG).
struct Mulberry(u32);

impl Mulberry {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
    /// 1 B – 64 KiB.
    fn size(&mut self) -> usize {
        1 + (self.next() as usize % (64 << 10))
    }
}

fn split(body: &[u8], rng: &mut Mulberry) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < body.len() {
        let n = rng.size().min(body.len() - at);
        out.push(body[at..at + n].to_vec());
        at += n;
    }
    out
}

/// Pumps until `pred` holds for the results so far (30 s at most).
fn wait(svc: &mut DecodeService, out: &mut Vec<Done>, pred: impl Fn(&[Done]) -> bool) {
    let t0 = Instant::now();
    loop {
        svc.pump();
        out.extend(svc.take_done());
        if pred(out) {
            return;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(30),
            "timed out; results {out:?}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn finished(out: &[Done], req: u32) -> bool {
    out.iter().any(|d| match d {
        Done::Decoded(m) => m.req == req,
        Done::Failed(f) => f.req == req,
        Done::Credit { .. } => false,
    })
}

fn result_of(out: &[Done], req: u32) -> Option<&Done> {
    out.iter().find(|d| match d {
        Done::Decoded(m) => m.req == req,
        Done::Failed(f) => f.req == req,
        Done::Credit { .. } => false,
    })
}

fn credits(out: &[Done], req: u32) -> u64 {
    out.iter()
        .map(|d| match d {
            Done::Credit { req: r, bytes } if *r == req => *bytes,
            _ => 0,
        })
        .sum()
}

/// Decodes `body` in one push; its result.
fn decode_one(svc: &mut DecodeService, req: u32, body: &[u8]) -> Done {
    svc.begin(req);
    svc.push(req, body);
    svc.end(req);
    let mut out = Vec::new();
    wait(svc, &mut out, |o| finished(o, req));
    result_of(&out, req)
        .cloned()
        .unwrap_or_else(|| panic!("no result"))
}

/// `PING` frames of `bytes` bytes in all (16 each).
fn pings(bytes: usize) -> Vec<u8> {
    let mut h = [0u8; 16];
    h[0] = 1;
    h[1] = 8;
    h.repeat(bytes / 16)
}

#[test]
fn decode_service() {
    let mut svc = DecodeService::new(1);
    let threads = Arc::new(Mutex::new(BTreeSet::new()));
    let seen = Arc::clone(&threads);
    svc.set_task_hook(Arc::new(move || {
        if let Ok(mut s) = seen.lock() {
            s.insert(format!("{:?}", std::thread::current().id()));
        }
    }));
    let render = format!("{:?}", std::thread::current().id());
    let mut rng = Mulberry(68);
    let mut bodies: Vec<(String, Vec<u8>)> =
        CASES.iter().map(|n| ((*n).to_owned(), route(n))).collect();
    // One 12 MiB push: pings before the two-series body decode as two-series.
    let mut big = pings(12 << 20);
    big.extend(route("two-series"));
    bodies.push(("two-series".to_owned(), big));
    let mut req = 0u32;
    let mut out = Vec::new();
    for chunk in bodies.chunks(2) {
        // Request a (aborted part-way), then the case pair, ≤ 2 in flight at any time.
        req += 1;
        let aborted = req;
        let victim = route("many");
        svc.begin(aborted);
        svc.push(aborted, &victim[..victim.len() / 2]);
        svc.pump();
        let handle = svc.work_handle(aborted);
        assert!(handle.is_some(), "a running request has its state");
        svc.abort(aborted);
        let mut live = Vec::new();
        for (name, body) in chunk {
            req += 1;
            svc.begin(req);
            let pieces = if body.len() > 1 << 20 {
                vec![body.clone()]
            } else {
                split(body, &mut rng)
            };
            live.push((req, name.clone(), body.len(), pieces));
        }
        // Interleave the pushes of the live requests.
        let most = live.iter().map(|l| l.3.len()).max().unwrap_or(0);
        for i in 0..most {
            for (r, _, _, pieces) in &live {
                if let Some(p) = pieces.get(i) {
                    svc.push(*r, p);
                }
            }
            svc.pump();
            out.extend(svc.take_done());
        }
        for (r, ..) in &live {
            svc.end(*r);
        }
        let reqs: Vec<u32> = live.iter().map(|l| l.0).collect();
        wait(&mut svc, &mut out, |o| reqs.iter().all(|r| finished(o, *r)));
        for (r, name, len, _) in &live {
            let got = result_of(&out, *r).unwrap_or_else(|| panic!("{name}: no result"));
            assert_eq!(message(got), decoded_fixture(name), "{name}");
            if let Done::Decoded(m) = got {
                // Full grid, NaN at the absent points; one shared ts.
                assert!(m.vs.iter().all(|v| v.len() == m.ts.len()), "{name}");
                assert_eq!(m.epoch, 1);
                assert!(
                    svc.table_mut().get(1, m.chunk).is_some(),
                    "{name} in the table"
                );
                assert_eq!(credits(&out, *r), *len as u64, "{name}: credits");
            }
        }
        assert!(!finished(&out, aborted), "an aborted request has no result");
        let t0 = Instant::now();
        while handle.as_ref().is_some_and(|h| h.alive()) {
            assert!(t0.elapsed() < Duration::from_secs(10), "aborted state kept");
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    let gaps = out
        .iter()
        .find_map(|d| match d {
            Done::Decoded(m) if m.head["series"].as_array().is_some_and(|s| s.len() == 1) => {
                m.vs.first().filter(|v| v.iter().any(|x| x.is_nan()))
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("the gaps result"));
    assert_eq!(gaps.len(), 61);
    assert!(!svc.busy(), "every request ended");
    let threads = threads.lock().map(|s| s.clone()).unwrap_or_default();
    assert!(!threads.is_empty(), "pool tasks ran");
    assert!(
        !threads.contains(&render),
        "decoding ran on the render thread"
    );
}

#[test]
fn in_flight_limit() {
    let mut svc = DecodeService::new(1);
    assert_eq!(DecodeService::MAX_IN_FLIGHT, 2);
    assert_eq!(DecodeService::PAUSE_THRESHOLD_BYTES, 8 << 20);
    svc.begin(1);
    svc.begin(2);
    svc.begin(3);
    assert!(svc.busy());
    let mut out = Vec::new();
    wait(&mut svc, &mut out, |o| finished(o, 3));
    assert!(
        matches!(result_of(&out, 3), Some(Done::Failed(f)) if f.kind == Failure::Busy),
        "{out:?}"
    );
    let body = route("two-series");
    for r in [1, 2] {
        svc.push(r, &body);
        svc.end(r);
    }
    wait(&mut svc, &mut out, |o| finished(o, 1) && finished(o, 2));
    assert!(matches!(result_of(&out, 1), Some(Done::Decoded(_))));
    assert!(!svc.busy());
}

// ---------------------------------------------------------------------------------------------
// Limits and invalid bodies (Rust builders over the route fixtures)

/// two-series with its first frame header declaring a payload over `max_payload`.
fn over_payload() -> Vec<u8> {
    let mut b = route("two-series");
    wirekit::put_u32(&mut b, 8, MAX_PAYLOAD + 8);
    b
}

/// two-series with its grid schema's `dash.grid.len` (and list size) over `max_grid_len`.
fn over_grid() -> Vec<u8> {
    let mut fr = wirekit::parse(&route("two-series"));
    let len = MAX_GRID_LEN + 1;
    let i = fr
        .iter()
        .position(|f| {
            f.kind == wirekit::SCHEMA
                && wirekit::get_kv(&f.msg(0).tree(), "dash.grid.len").is_some()
        })
        .unwrap_or_else(|| panic!("a grid schema"));
    let m = fr[i].msg(0).edit(|t| {
        wirekit::set_kv(t, "dash.grid.len", &len.to_string());
        let fields = t.t_mut(2).tv_mut(1);
        fields[1].t_mut(3).set_int(0, 4, i64::from(len));
    });
    *fr[i].msg_mut(0) = m;
    wirekit::encode(&fr)
}

/// two-series with its first grid batch's last buffer offset past its slab.
fn bad_offsets() -> Vec<u8> {
    let mut fr = wirekit::parse(&route("two-series"));
    let i = fr
        .iter()
        .position(|f| f.kind == wirekit::BATCH && f.part == 2)
        .unwrap_or_else(|| panic!("a grid batch"));
    let m = fr[i].msg(0).edit(|t| {
        let rb = t.t_mut(2);
        let mut b = rb.pairs(2);
        if let Some(last) = b.last_mut() {
            last.0 = 1 << 30;
        }
        rb.set_pairs(2, &b);
    });
    *fr[i].msg_mut(0) = m;
    wirekit::encode(&fr)
}

fn kind(d: &Done) -> Option<Failure> {
    match d {
        Done::Failed(f) => Some(f.kind),
        _ => None,
    }
}

#[test]
fn limit_fallback() {
    let mut svc = DecodeService::new(1);
    LARGEST.store(0, Ordering::Relaxed);
    let d = decode_one(&mut svc, 1, &over_payload());
    assert_eq!(kind(&d), Some(Failure::Limit), "{d:?}");
    let largest = LARGEST.load(Ordering::Relaxed);
    assert!(
        largest < MAX_PAYLOAD as usize,
        "over-payload: largest allocation {largest}"
    );
    LARGEST.store(0, Ordering::Relaxed);
    let d = decode_one(&mut svc, 2, &over_grid());
    assert_eq!(kind(&d), Some(Failure::Limit), "{d:?}");
    let largest = LARGEST.load(Ordering::Relaxed);
    assert!(
        largest < (MAX_GRID_LEN as usize + 1) * 8,
        "over-grid: largest allocation {largest}"
    );
}

#[test]
fn invalid_body() {
    let mut svc = DecodeService::new(1);
    let d = decode_one(&mut svc, 1, &bad_offsets());
    assert_eq!(kind(&d), Some(Failure::Invalid), "{d:?}");
    // A limit is not an invalid body: it is retried as JSON.
    let d = decode_one(&mut svc, 2, &over_payload());
    assert_eq!(kind(&d), Some(Failure::Limit), "{d:?}");
    // A body cut short is invalid.
    let body = route("two-series");
    let d = decode_one(&mut svc, 3, &body[..body.len() - 16]);
    assert_eq!(kind(&d), Some(Failure::Invalid), "{d:?}");
}

// ---------------------------------------------------------------------------------------------
// Ids, epochs and the table

fn chunk_of(d: &Done) -> u32 {
    match d {
        Done::Decoded(m) => m.chunk,
        other => panic!("not decoded: {other:?}"),
    }
}

#[test]
fn chunk_ids() {
    let mut svc = DecodeService::new(1);
    // Two requests of two tenants and scopes, concurrently: each gets its own chunk.
    let (a, b) = (route("two-series"), route("gaps"));
    svc.begin(1);
    svc.begin(2);
    let mut rng = Mulberry(7);
    let (pa, pb) = (split(&a, &mut rng), split(&b, &mut rng));
    for i in 0..pa.len().max(pb.len()) {
        if let Some(p) = pa.get(i) {
            svc.push(1, p);
        }
        if let Some(q) = pb.get(i) {
            svc.push(2, q);
        }
        svc.pump();
    }
    svc.end(1);
    svc.end(2);
    let mut out = Vec::new();
    wait(&mut svc, &mut out, |o| finished(o, 1) && finished(o, 2));
    let first = chunk_of(result_of(&out, 1).unwrap_or_else(|| panic!("1")));
    let second = chunk_of(result_of(&out, 2).unwrap_or_else(|| panic!("2")));
    assert!(
        first >= 1 && second >= 1 && first != second,
        "{first} {second}"
    );
    let ca = svc.table_mut().get(1, first);
    let cb = svc.table_mut().get(1, second);
    assert!(ca.is_some() && cb.is_some());
    assert_ne!(ca.map(|c| c.series.clone()), cb.map(|c| c.series.clone()));
    let second = first.max(second);
    // Release one: gone from the table, and its id is never handed out again.
    svc.table_mut().release(1, second);
    assert!(svc.table_mut().get(1, second).is_none());
    let third = chunk_of(&decode_one(&mut svc, 5, &a));
    assert!(third > second, "never reused: {third}");
    // A restart: a new table and epoch. Old-epoch references miss; a late finaliser's release
    // of the old epoch is ignored.
    let mut next = DecodeService::new(2);
    let fresh = chunk_of(&decode_one(&mut next, 1, &a));
    assert_eq!(next.table().epoch(), 2);
    assert!(
        next.table_mut().get(1, fresh).is_none(),
        "old epoch → missing"
    );
    next.table_mut().release(1, fresh);
    assert!(
        next.table_mut().get(2, fresh).is_some(),
        "old-epoch release ignored"
    );
    // At the limit: one more insert, then `ids`.
    next.table_mut().set_next(u32::MAX - 1);
    assert_eq!(chunk_of(&decode_one(&mut next, 2, &a)), u32::MAX - 1);
    let d = decode_one(&mut next, 3, &a);
    assert_eq!(kind(&d), Some(Failure::Ids), "{d:?}");
}

fn grid_chunk(id: u64, series: usize, len: u32) -> Chunk {
    let mut b = ChunkBuilder::grid(ChunkId(id), 0, 1000, len);
    for s in 0..series {
        let meta = SeriesMeta {
            key_hash: s as u64,
            labels: Arc::from(Vec::new()),
        };
        let v: Vec<f64> = (0..len).map(f64::from).collect();
        if let Err(e) = b.push_series(meta, None, &v) {
            panic!("{e}");
        }
    }
    b.finish()
}

#[test]
fn chunk_table() {
    let probe = grid_chunk(1, 2, 100);
    let mut sizing = ChunkTable::new(1);
    let id = sizing.insert(Arc::new(probe));
    assert_eq!(id, Some(1));
    let one = sizing.unheld_bytes();
    assert!(one >= 2 * 100 * 8, "a chunk's bytes are counted: {one}");
    // Cap: one chunk. Three chunks, two held by frames.
    let mut t = ChunkTable::with_cap(1, one);
    let mut ids = Vec::new();
    let mut held: Vec<Arc<Chunk>> = Vec::new();
    for i in 0..3 {
        let id = t.insert(Arc::new(grid_chunk(i, 2, 100))).unwrap_or(0);
        ids.push(id);
        if i < 2 {
            // A frame takes it (`frame_set_chunk_ref`).
            held.extend(t.get(1, id));
        }
    }
    assert_eq!(ids, [1, 2, 3]);
    assert_eq!(held.len(), 2);
    let d = t.insert(Arc::new(grid_chunk(4, 2, 100)));
    assert_eq!(d, Some(4));
    // The unheld LRU (3) went; the held ones and the newest stay.
    assert!(t.get(1, 3).is_none(), "the unheld LRU evicted");
    assert!(t.get(1, 1).is_some() && t.get(1, 2).is_some() && t.get(1, 4).is_some());
    assert_eq!(t.unheld_bytes(), one);
    // Release of a held one: the entry goes, the frame's Arc keeps drawing.
    t.release(1, 1);
    assert!(t.get(1, 1).is_none());
    assert_eq!(held[0].values.len(), 200);
    // A single-series result: one batch, reused by the join (no copy); counted and evicted like
    // any other.
    let mut svc = DecodeService::new(1);
    let body = route("read-cache");
    let len = 61usize;
    WATCH.store(len * 8, Ordering::Relaxed);
    HITS.store(0, Ordering::Relaxed);
    let c = chunk_of(&decode_one(&mut svc, 1, &body));
    let hits = HITS.load(Ordering::Relaxed);
    WATCH.store(0, Ordering::Relaxed);
    // The batch's values, `ts` and `vs[0]`: no fourth copy for the join.
    assert!(hits <= 3, "{hits} allocations of the values' size");
    assert!(svc.table().unheld_bytes() >= len * 8);
    let got = svc.table_mut().get(1, c);
    assert!(matches!(
        got.as_deref().map(|c| &c.time),
        Some(TimeAxis::Grid { len: 61, .. })
    ));
    drop(got);
    assert_eq!(svc.table().len(), 1);
    // Unheld and over a zero cap: evicted at the next insert.
    let mut z = ChunkTable::with_cap(1, 0);
    let a = z.insert(Arc::new(grid_chunk(1, 1, 61)));
    let b = z.insert(Arc::new(grid_chunk(2, 1, 61)));
    assert!(a.is_some() && b.is_some());
    assert!(
        z.get(1, a.unwrap_or(0)).is_none(),
        "unheld beyond the cap: evicted"
    );
}
