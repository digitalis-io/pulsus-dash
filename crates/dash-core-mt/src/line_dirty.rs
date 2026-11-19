//! When the line scene must decimate (plan #24 §4.2 step 4): the frame's uniforms or column bounds
//! changed, or a series was uploaded. The state stays pending until a decimation pass is
//! submitted, so a frame that skips presenting (surface outdated, lost, timed out or occluded)
//! does not lose it.

/// The last uniforms and bounds seen, and whether a decimation is owed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DecimateState {
    uniforms: Vec<u8>,
    bounds: Vec<u32>,
    pending: bool,
}

impl DecimateState {
    /// Records this frame's inputs; returns whether a decimation is pending.
    pub fn note(&mut self, _uniforms: &[u8], _bounds: &[u32], _uploaded: bool) -> bool {
        false
    }

    /// A decimation pass was submitted.
    pub fn submitted(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skipped_dirty_frame_decimates_next() {
        let mut d = DecimateState::default();
        // Frame 1: new uniforms; the surface is outdated, so nothing is submitted.
        assert!(d.note(&[1, 2], &[0, 5], false));
        // Frame 2: unchanged inputs, still pending; this time the pass is submitted.
        assert!(d.note(&[1, 2], &[0, 5], false));
        d.submitted();
        // Frame 3: unchanged and already decimated.
        assert!(!d.note(&[1, 2], &[0, 5], false));
        // An upload on a skipped frame stays pending too.
        assert!(d.note(&[1, 2], &[0, 5], true));
        assert!(d.note(&[1, 2], &[0, 5], false));
        d.submitted();
        assert!(!d.note(&[1, 2], &[0, 5], false));
        assert!(d.note(&[1, 2], &[0, 6], false), "bounds changed");
    }
}
