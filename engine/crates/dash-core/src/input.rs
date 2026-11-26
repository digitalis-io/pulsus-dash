//! The input ring's consumer (TODO C2a1: stub).

use std::sync::atomic::Ordering;

/// The control block's words.
pub trait Words {
    fn load(&self, off: u32, o: Ordering) -> u32;
    fn store(&self, off: u32, v: u32, o: Ordering);
    fn swap(&self, off: u32, v: u32, o: Ordering) -> u32;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Record {
    Resize {
        frame: u32,
        css_w: f32,
        css_h: f32,
        dpr: f32,
        device_w: u32,
        device_h: u32,
    },
    Camera {
        frame: u32,
        view: (f64, f64),
        value: (f64, f64),
        band: f64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Decoded {
    pub seq: u32,
    pub t_ms: f64,
    pub rec: Record,
}

#[derive(Debug, PartialEq, thiserror::Error)]
#[error("input record at {at}")]
pub struct Bad {
    pub at: u32,
}

pub fn drain(_w: &impl Words, _out: &mut Vec<Decoded>) -> Result<(), Bad> {
    Ok(())
}

pub fn before_sleep(_w: &impl Words) -> bool {
    false
}

/// The probe's log entry of a decoded record.
pub fn log_json(_d: &Decoded) -> serde_json::Value {
    serde_json::Value::Null
}
