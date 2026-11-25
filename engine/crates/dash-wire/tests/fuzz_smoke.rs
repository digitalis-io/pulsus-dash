//! unit:dsf-fuzz-smoke (plan #68 B2 §5; T04-010): seeded mutants of every fixture through the
//! splitter, the decoder and `finish`. No panic, and every published chunk is consistent.
mod common;
mod support;

use std::panic::{AssertUnwindSafe, catch_unwind};

use common::{FIXTURES, fixture};
use dash_wire::{Chunk, Event, Verdict};

const MUTANTS: usize = 25_000;

struct XorShift(u64);

impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn mutate(body: &[u8], r: &mut XorShift) -> Vec<u8> {
    let mut b = body.to_vec();
    match r.below(4) {
        0 => {
            let n = 1 + r.below(8);
            let at = r.below(b.len());
            for i in at..(at + n).min(b.len()) {
                b[i] = r.next() as u8;
            }
        }
        1 => {
            for _ in 0..1 + r.below(4) {
                let bit = r.below(b.len() * 8);
                b[bit / 8] ^= 1 << (bit % 8);
            }
        }
        2 => b.truncate(r.below(b.len())),
        _ => {
            let wide = r.below(2) == 0;
            let w = if wide { 8 } else { 4 };
            let at = r.below(b.len() / w) * w;
            let v: i64 = match r.below(4) {
                0 => 0,
                1 => -1,
                2 => i64::from(i32::MAX),
                _ => i64::MAX,
            };
            let bytes = v.to_le_bytes();
            if at + w <= b.len() {
                b[at..at + w].copy_from_slice(&bytes[..w]);
            }
        }
    }
    b
}

fn check_chunk(c: &Chunk) -> Result<(), String> {
    if c.offsets.len() != c.series.len() + 1 {
        return Err("offsets length".into());
    }
    if c.offsets.last().map(|o| *o as usize) != Some(c.values.len()) {
        return Err("values length".into());
    }
    if let Some(p) = &c.present {
        if p.len() != c.values.len().div_ceil(64) {
            return Err("present length".into());
        }
        let rem = c.values.len() % 64;
        if rem != 0 && p.last().is_some_and(|w| w >> rem != 0) {
            return Err("trailing present bits".into());
        }
        for (i, v) in c.values.iter().enumerate() {
            if p[i / 64] >> (i % 64) & 1 == 0 && v.to_bits() != 0x7FF8_0000_0000_0000 {
                return Err(format!("null slot {i} bits {:x}", v.to_bits()));
            }
        }
    }
    Ok(())
}

#[test]
fn mutants_never_panic_and_chunks_stay_consistent() {
    for (n, name) in FIXTURES.iter().enumerate() {
        let body = fixture(name);
        // The unmutated body decodes completely.
        let base = support::run(&body, 1);
        assert_eq!(
            base.last(),
            Some(&Event::Verdict(Verdict::Complete)),
            "{name}"
        );
        let mut r = XorShift(0x9E37_79B9_7F4A_7C15 ^ (n as u64 + 1));
        for i in 0..MUTANTS {
            let m = mutate(&body, &mut r);
            let out = catch_unwind(AssertUnwindSafe(|| support::run(&m, 1)));
            let Ok(ev) = out else {
                panic!("{name} mutant {i} panicked")
            };
            assert!(
                matches!(ev.last(), Some(Event::Verdict(_))),
                "{name} mutant {i}: no verdict"
            );
            for e in &ev {
                if let Event::Chunk { chunk, .. } = e
                    && let Err(why) = check_chunk(chunk)
                {
                    panic!("{name} mutant {i}: {why}");
                }
            }
        }
    }
}
