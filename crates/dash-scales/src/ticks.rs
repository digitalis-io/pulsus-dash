//! Nice ticks for the minimal axes (plan #24 §3.3).

/// Ticks never exceed this count.
const MAX_TICKS: usize = 64;

const SECOND: f64 = 1_000.0;
const MINUTE: f64 = 60.0 * SECOND;
const HOUR: f64 = 60.0 * MINUTE;
const DAY: f64 = 24.0 * HOUR;
const WEEK: f64 = 7.0 * DAY;

/// Multiples `k·step` in `[lo, hi]` (at most 64).
fn multiples(lo: f64, hi: f64, step: f64) -> Vec<f64> {
    if !(step.is_finite() && step > 0.0 && lo.is_finite() && hi.is_finite()) {
        return Vec::new();
    }
    let first = (lo / step).ceil();
    let last = (hi / step).floor();
    let mut out = Vec::new();
    let mut k = first;
    while k <= last && out.len() < MAX_TICKS {
        out.push(k * step);
        k += 1.0;
    }
    out
}

/// The smallest `{1, 2, 5}·10^e` ≥ `raw` (decade found by ×/÷ 10 loops).
fn nice_125(raw: f64) -> f64 {
    let mut p = 1.0;
    while p > raw {
        p /= 10.0;
    }
    while p * 10.0 <= raw {
        p *= 10.0;
    }
    [1.0, 2.0, 5.0, 10.0]
        .into_iter()
        .map(|m| m * p)
        .find(|v| *v >= raw)
        .unwrap_or(10.0 * p)
}

/// Linear ticks: step = the smallest `{1, 2, 5}·10^e ≥ (hi − lo) / target`; ticks `k·step`.
pub fn linear_ticks(lo: f64, hi: f64, target: u32) -> Vec<f64> {
    let raw = (hi - lo) / f64::from(target.max(1));
    if !(raw.is_finite() && raw > 0.0) {
        return Vec::new();
    }
    let step = nice_125(raw);
    let step = if (hi - lo) / step > MAX_TICKS as f64 {
        nice_125((hi - lo) / MAX_TICKS as f64)
    } else {
        step
    };
    multiples(lo, hi, step)
}

/// The time ladder (ms): 1-2-5 from 1 to 500 ms; 1, 2, 5, 10, 15, 30 s; 1, 2, 5, 10, 15, 30
/// min; 1, 2, 3, 6, 12 h; 1, 2, 7 d; then weeks × 1-2-5 decades.
fn time_step(raw: f64) -> f64 {
    const LADDER: [f64; 29] = [
        1.0,
        2.0,
        5.0,
        10.0,
        20.0,
        50.0,
        100.0,
        200.0,
        500.0,
        SECOND,
        2.0 * SECOND,
        5.0 * SECOND,
        10.0 * SECOND,
        15.0 * SECOND,
        30.0 * SECOND,
        MINUTE,
        2.0 * MINUTE,
        5.0 * MINUTE,
        10.0 * MINUTE,
        15.0 * MINUTE,
        30.0 * MINUTE,
        HOUR,
        2.0 * HOUR,
        3.0 * HOUR,
        6.0 * HOUR,
        12.0 * HOUR,
        DAY,
        2.0 * DAY,
        WEEK,
    ];
    match LADDER.into_iter().find(|s| *s >= raw) {
        Some(s) => s,
        None => WEEK * nice_125(raw / WEEK),
    }
}

/// Time ticks: the smallest ladder step ≥ `(hi − lo) / target`; multiples from the Unix epoch.
pub fn time_ticks(lo_ms: f64, hi_ms: f64, target: u32) -> Vec<f64> {
    let raw = (hi_ms - lo_ms) / f64::from(target.max(1));
    if !(raw.is_finite() && raw > 0.0) {
        return Vec::new();
    }
    let mut step = time_step(raw);
    if (hi_ms - lo_ms) / step > MAX_TICKS as f64 {
        step = time_step((hi_ms - lo_ms) / MAX_TICKS as f64);
    }
    multiples(lo_ms, hi_ms, step)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(t: &[f64]) -> f64 {
        t[1] - t[0]
    }

    #[test]
    fn ticks_nice() {
        assert_eq!(
            linear_ticks(0.0, 97.0, 5),
            vec![0.0, 20.0, 40.0, 60.0, 80.0]
        );
        assert_eq!(linear_ticks(-3.0, 7.1, 6), vec![-2.0, 0.0, 2.0, 4.0, 6.0]);
        let big = linear_ticks(1e9, 1e9 + 5.0, 5);
        assert_eq!(step(&big), 1.0);
        assert_eq!(big.len(), 6);
        assert_eq!(big[0], 1e9);
        let hour = time_ticks(0.0, 3.6e6, 6);
        assert_eq!(step(&hour), 6e5);
        assert_eq!(hour.len(), 7);
        let ms = time_ticks(1.7e12 + 500.0, 1.7e12 + 2_500.0, 4);
        assert_eq!(step(&ms), 500.0);
        assert_eq!(ms.len(), 5);
        assert_eq!(ms[0], 1.7e12 + 500.0);
        assert!(linear_ticks(0.0, 1e9, 1_000_000).len() <= 64);
        assert_eq!(
            step(&time_ticks(0.0, 75.0 * 86_400_000.0, 5)),
            35.0 * 86_400_000.0
        );
        assert_eq!(
            step(&time_ticks(0.0, 28.0 * 86_400_000.0, 2)),
            14.0 * 86_400_000.0
        );
    }
}
