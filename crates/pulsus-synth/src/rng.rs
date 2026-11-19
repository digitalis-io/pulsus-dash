//! SplitMix64: the seed expander of every generator (T05-010).

/// SplitMix64 (Steele, Lea, Flood 2014): a 64-bit state advanced by the golden-ratio increment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SplitMix64(u64);

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        SplitMix64(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        0
    }

    /// Uniform in [0, 1): the top 53 bits × 2⁻⁵³.
    pub fn next_f64(&mut self) -> f64 {
        0.0
    }
}
