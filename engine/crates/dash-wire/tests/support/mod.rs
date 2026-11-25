//! Drivers for the integration tests: a body through `FrameSplitter` and `BodyDecoder` as Part D
//! will run them (plan #68 B2 §4.1 "End of input").
#![allow(dead_code)]

use dash_wire::{BodyDecoder, Event, FrameSplitter, PartError, SharedBytes, Verdict};

/// Feeds `pieces` (each copied at its body offset mod 64) and returns the events of every
/// `frame`/`fail_stream` call, then the events of the first `finish` call.
pub fn run_split(pieces: &[&[u8]], first: u64) -> (Vec<Vec<Event>>, Vec<Event>) {
    let mut s = FrameSplitter::new();
    let mut d = BodyDecoder::new(first);
    let mut calls = Vec::new();
    let mut offset = 0usize;
    'outer: for p in pieces {
        let chunk = SharedBytes::copy_from(p, offset % 64);
        offset += p.len();
        if let Err(e) = s.push(chunk) {
            calls.push(d.fail_stream(e));
            break;
        }
        loop {
            match s.next() {
                Ok(Some(f)) => calls.push(d.frame(f)),
                Ok(None) => break,
                Err(e) => {
                    calls.push(d.fail_stream(e));
                    break 'outer;
                }
            }
        }
    }
    if let Err(e) = s.finish() {
        calls.push(d.fail_stream(e));
    }
    let fin = d.finish();
    (calls, fin)
}

/// The whole body in one chunk: every event in order, `finish` included.
pub fn run(body: &[u8], first: u64) -> Vec<Event> {
    let (calls, fin) = run_split(&[body], first);
    calls.into_iter().flatten().chain(fin).collect()
}

/// The events of each call (frame calls, then `finish`).
pub fn run_calls(body: &[u8]) -> Vec<Vec<Event>> {
    let (mut calls, fin) = run_split(&[body], 1);
    calls.push(fin);
    calls
}

/// The failure of `part`, if any.
pub fn failure(ev: &[Event], part: u32) -> Option<PartError> {
    ev.iter().find_map(|e| match e {
        Event::Failed { part: p, reason } if *p == part => Some(reason.clone()),
        _ => None,
    })
}

pub fn verdict(ev: &[Event]) -> Option<Verdict> {
    ev.iter().find_map(|e| match e {
        Event::Verdict(v) => Some(v.clone()),
        _ => None,
    })
}

/// No `Grid`, `Chunk`, `Coverage` or `Upstream` event for `part`.
pub fn silent(ev: &[Event], part: u32) -> bool {
    !ev.iter().any(|e| match e {
        Event::Grid { part: p, .. }
        | Event::Chunk { part: p, .. }
        | Event::Coverage { part: p, .. }
        | Event::Upstream { part: p, .. } => *p == part,
        _ => false,
    })
}

pub fn chunks(ev: &[Event], part: u32) -> usize {
    ev.iter()
        .filter(|e| matches!(e, Event::Chunk { part: p, .. } if *p == part))
        .count()
}

pub fn coverages(ev: &[Event], part: u32) -> usize {
    ev.iter()
        .filter(|e| matches!(e, Event::Coverage { part: p, .. } if *p == part))
        .count()
}

/// The events concerning `part` (for "the other parts unchanged").
pub fn of_part(ev: &[Event], part: u32) -> Vec<Event> {
    ev.iter()
        .filter(|e| match e {
            Event::Grid { part: p, .. }
            | Event::Chunk { part: p, .. }
            | Event::Coverage { part: p, .. }
            | Event::Upstream { part: p, .. }
            | Event::Failed { part: p, .. }
            | Event::PartEnd { part: p } => *p == part,
            _ => false,
        })
        .cloned()
        .collect()
}

/// The whole body in one chunk; returns the events (with `finish`) and the decoder, so a test
/// can call `finish` again or read `stream_error`.
pub fn run_dec(body: &[u8]) -> (Vec<Event>, Vec<Event>, BodyDecoder) {
    let mut s = FrameSplitter::new();
    let mut d = BodyDecoder::new(1);
    let mut ev = Vec::new();
    if let Err(e) = s.push(SharedBytes::copy_from(body, 0)) {
        ev.extend(d.fail_stream(e));
    }
    loop {
        match s.next() {
            Ok(Some(f)) => ev.extend(d.frame(f)),
            Ok(None) => break,
            Err(e) => {
                ev.extend(d.fail_stream(e));
                break;
            }
        }
    }
    if let Err(e) = s.finish() {
        ev.extend(d.fail_stream(e));
    }
    let fin = d.finish();
    (ev, fin, d)
}

/// A comparable image of events: chunk values by their bits (NaN payloads included).
pub fn fingerprint(ev: &[Event]) -> Vec<String> {
    ev.iter()
        .map(|e| match e {
            Event::Chunk {
                part,
                rank,
                flags,
                chunk,
            } => {
                let bits: Vec<u64> = chunk.values.iter().map(|v| v.to_bits()).collect();
                format!(
                    "Chunk {part} {rank} {flags} {:?} {:?} {:?} {:?} {bits:?} {:?} {:?}",
                    chunk.id,
                    chunk.time,
                    chunk.series,
                    chunk.offsets,
                    chunk.present,
                    chunk.finite.map(|(a, b)| (a.to_bits(), b.to_bits())),
                )
            }
            other => format!("{other:?}"),
        })
        .collect()
}

/// Event lists equal, chunk values compared by their bits (NaN payloads included).
pub fn same(a: &[Event], b: &[Event]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| match (x, y) {
            (
                Event::Chunk {
                    part: p1,
                    rank: r1,
                    flags: f1,
                    chunk: c1,
                },
                Event::Chunk {
                    part: p2,
                    rank: r2,
                    flags: f2,
                    chunk: c2,
                },
            ) => {
                (p1, r1, f1) == (p2, r2, f2)
                    && c1.id == c2.id
                    && c1.time == c2.time
                    && c1.series == c2.series
                    && c1.offsets == c2.offsets
                    && c1.present == c2.present
                    && c1.finite.map(|(l, h)| (l.to_bits(), h.to_bits()))
                        == c2.finite.map(|(l, h)| (l.to_bits(), h.to_bits()))
                    && c1.values.len() == c2.values.len()
                    && c1
                        .values
                        .iter()
                        .zip(&c2.values)
                        .all(|(u, v)| u.to_bits() == v.to_bits())
            }
            _ => x == y,
        })
}
