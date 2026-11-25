//! The render worker's frame table (plan #68 C1 §3.4): one viewport per ChartFrame, built into a
//! draw list and an `a11y` summary. Data enters only through [`Frames::set_chunk`] (the Part D
//! seam); the `data_*` calls build a chunk in the local id space from the TS series.

use std::sync::Arc;

use dash_marks::DrawList;
use dash_scene::Theme;
use dash_wire::Chunk;

use crate::CoreError;

#[derive(Debug, Default)]
pub struct Frames {}

impl Frames {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(&mut self, id: u32, frame_id: Option<String>) {
        let _ = (id, frame_id);
    }

    pub fn set_spec(&mut self, id: u32, json: &str) -> Result<(), CoreError> {
        let _ = (id, json);
        Ok(())
    }

    pub fn set_window(&mut self, id: u32, from_ms: f64, to_ms: f64) {
        let _ = (id, from_ms, to_ms);
    }

    pub fn set_theme(&mut self, id: u32, theme: Theme) {
        let _ = (id, theme);
    }

    pub fn resize(&mut self, id: u32, css_w: f64, css_h: f64, dpr: f32) {
        let _ = (id, css_w, css_h, dpr);
    }

    pub fn size(&self, id: u32) -> Option<(f64, f64, f32)> {
        let _ = id;
        None
    }

    pub fn dispose(&mut self, id: u32) {
        let _ = id;
    }

    pub fn set_chunk(&mut self, id: u32, chunk: Option<Arc<Chunk>>) {
        let _ = (id, chunk);
    }

    pub fn data_begin(&mut self, id: u32) {
        let _ = id;
    }

    pub fn data_series(
        &mut self,
        id: u32,
        key: &str,
        names: Vec<String>,
        values: Vec<String>,
        t_ms: &[f64],
        v: &[f64],
    ) -> Result<(), CoreError> {
        let _ = (id, key, names, values, t_ms, v);
        Ok(())
    }

    pub fn data_end(&mut self, id: u32) -> Result<(), CoreError> {
        let _ = id;
        Ok(())
    }

    pub fn data_clear(&mut self, id: u32) {
        let _ = id;
    }

    /// The draw list of frame `id` and its `a11y` summary JSON when it changed.
    pub fn build(&mut self, id: u32) -> Option<(DrawList, Option<String>)> {
        let _ = id;
        None
    }
}
