//! Scene graph and camera controllers. Design: T02. #23 adds the runtime spike scene
//! ([`spike`]); #24 adds the 2D camera controller ([`camera`]) and the line chart scene
//! ([`line`]). The full scene graph follows with the gallery.

pub mod camera;
pub mod line;
pub mod spike;

use dash_protocol::input::{InputRecord, RecordHeader};

/// A scene that consumes the input records drained at frame start (T03-019).
pub trait InputSink {
    fn apply(&mut self, h: &RecordHeader, r: &InputRecord);
}
