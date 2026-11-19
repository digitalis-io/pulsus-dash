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
    pub fn note(&mut self, uniforms: &[u8], bounds: &[u32], uploaded: bool) -> bool {
        if uniforms != self.uniforms.as_slice() || bounds != self.bounds.as_slice() {
            self.uniforms.clear();
            self.uniforms.extend_from_slice(uniforms);
            self.bounds.clear();
            self.bounds.extend_from_slice(bounds);
            self.pending = true;
        }
        self.pending |= uploaded;
        self.pending
    }

    /// A series was uploaded on a frame with nothing to draw (no usable plot yet).
    pub fn uploaded(&mut self) {
        self.pending = true;
    }

    /// A decimation pass was submitted.
    pub fn submitted(&mut self) {
        self.pending = false;
    }
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
        d.submitted();
        d.uploaded();
        assert!(d.note(&[1, 2], &[0, 6], false), "upload without a frame");
    }
}
