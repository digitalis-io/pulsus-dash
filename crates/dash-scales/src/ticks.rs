//! Nice ticks for the minimal axes (plan #24 §3.3).

pub fn linear_ticks(_lo: f64, _hi: f64, _target: u32) -> Vec<f64> {
    Vec::new()
}

pub fn time_ticks(_lo_ms: f64, _hi_ms: f64, _target: u32) -> Vec<f64> {
    Vec::new()
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
            step(&time_ticks(0.0, 30.0 * 86_400_000.0, 2)),
            35.0 * 86_400_000.0
        );
        assert_eq!(
            step(&time_ticks(0.0, 28.0 * 86_400_000.0, 2)),
            14.0 * 86_400_000.0
        );
    }
}
