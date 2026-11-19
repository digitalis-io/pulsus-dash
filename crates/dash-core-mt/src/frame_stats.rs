//! Per-frame timing exported in the control block counters (`FS_*`, T03 §4.3 counters region):
//! frame count, a 64-bucket interval histogram (0.5 ms buckets), intervals over 50 ms, and the
//! last 256 intervals and render CPU times. All stores are relaxed (readers tolerate tearing
//! across words).

use std::sync::atomic::Ordering::Relaxed;

use dash_protocol::layout::off;

use crate::control::Control;

/// Histogram buckets; the last one holds every interval ≥ 31.5 ms.
pub const HIST_BUCKETS: usize = 64;
/// Entries in each recent array.
pub const RECENT: u32 = 256;
/// An interval over this is a long frame.
pub const LONG_FRAME_MS: f32 = 50.0;

/// A view of the frame statistics of one control block.
#[derive(Debug)]
pub struct FrameStats<'a> {
    cb: &'a Control,
}

impl<'a> FrameStats<'a> {
    pub fn new(cb: &'a Control) -> Self {
        FrameStats { cb }
    }

    /// Records one frame interval and its render CPU time (ms).
    pub fn record(&self, interval_ms: f32, cpu_ms: f32) {
        let cb = self.cb;
        let bucket = ((interval_ms / 0.5) as usize).min(HIST_BUCKETS - 1) as u32;
        cb.word(off::FS_HIST + 4 * bucket).fetch_add(1, Relaxed);
        if interval_ms > LONG_FRAME_MS {
            cb.word(off::FS_LONG_FRAMES).fetch_add(1, Relaxed);
        }
        let idx = cb.word(off::FS_RECENT_IDX).load(Relaxed) % RECENT;
        cb.word(off::FS_RECENT_INTERVAL + 4 * idx)
            .store(interval_ms.to_bits(), Relaxed);
        cb.word(off::FS_RECENT_CPU + 4 * idx)
            .store(cpu_ms.to_bits(), Relaxed);
        cb.word(off::FS_RECENT_IDX)
            .store((idx + 1) % RECENT, Relaxed);
        cb.word(off::FS_FRAMES).fetch_add(1, Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_stats_histogram() {
        let cb = Control::alloc().expect("control block");
        let fs = FrameStats::new(&cb);
        for i in [0.2f32, 16.6, 40.0, 60.0] {
            fs.record(i, 1.0);
        }
        let w = |at: u32| cb.word(at).load(Relaxed);
        let hist: Vec<u32> = (0..64).map(|i| w(off::FS_HIST + 4 * i)).collect();
        assert_eq!(hist[0], 1);
        assert_eq!(hist[33], 1);
        assert_eq!(hist[63], 2);
        assert_eq!(hist.iter().sum::<u32>(), 4);
        assert_eq!(w(off::FS_FRAMES), 4);
        assert_eq!(w(off::FS_LONG_FRAMES), 1);
        assert_eq!(w(off::FS_RECENT_IDX), 4);
        let recent: Vec<f32> = (0..4)
            .map(|i| f32::from_bits(w(off::FS_RECENT_INTERVAL + 4 * i)))
            .collect();
        assert_eq!(recent, vec![0.2, 16.6, 40.0, 60.0]);
        let cpu: Vec<f32> = (0..4)
            .map(|i| f32::from_bits(w(off::FS_RECENT_CPU + 4 * i)))
            .collect();
        assert_eq!(cpu, vec![1.0; 4]);
    }
}
