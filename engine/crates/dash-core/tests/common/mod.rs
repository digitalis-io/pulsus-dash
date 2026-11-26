//! Shared by the input ring tests (plan #68 C2a1 §5): a control block in plain atomics and the
//! producer of §4.1 restated in Rust (the TS `InputRing`'s publish: the gap marker when a record
//! would cross the end, the payload, then the head with release ordering, then the idle word's
//! compare-exchange 1 → 0, here a swap to 0, which is the same on a 0/1 word).
#![allow(dead_code)]

use std::sync::atomic::{AtomicU32, Ordering};

use dash_core::input::Words;
use dash_protocol::input::{CAMERA_BYTES, RESIZE_BYTES, rec};
use dash_protocol::{CB_BYTES, RING_BYTES, off};

/// A control block of `AtomicU32` words.
#[derive(Debug)]
pub struct Block(Vec<AtomicU32>);

impl Default for Block {
    fn default() -> Self {
        Self((0..CB_BYTES / 4).map(|_| AtomicU32::new(0)).collect())
    }
}

impl Block {
    fn word(&self, off: u32) -> &AtomicU32 {
        match self.0.get((off / 4) as usize) {
            Some(w) => w,
            None => panic!("offset {off} outside the control block"),
        }
    }

    /// head = tail = `v`.
    pub fn start_at(&self, v: u32) {
        self.store(off::INPUT_HEAD, v, Ordering::SeqCst);
        self.store(off::INPUT_TAIL, v, Ordering::SeqCst);
    }

    pub fn store_head(&self, v: u32) {
        self.store(off::INPUT_HEAD, v, Ordering::SeqCst);
    }

    pub fn head(&self) -> u32 {
        self.load(off::INPUT_HEAD, Ordering::SeqCst)
    }

    pub fn tail(&self) -> u32 {
        self.load(off::INPUT_TAIL, Ordering::SeqCst)
    }

    pub fn idle(&self) -> u32 {
        self.load(off::INPUT_IDLE, Ordering::SeqCst)
    }

    /// One data word at physical offset `phys` of the ring.
    pub fn put(&self, phys: u32, v: u32) {
        self.store(off::INPUT_DATA + phys, v, Ordering::Relaxed);
    }

    pub fn get(&self, phys: u32) -> u32 {
        self.load(off::INPUT_DATA + phys, Ordering::Relaxed)
    }
}

impl Words for Block {
    fn load(&self, off: u32, o: Ordering) -> u32 {
        self.word(off).load(o)
    }
    fn store(&self, off: u32, v: u32, o: Ordering) {
        self.word(off).store(v, o);
    }
    fn swap(&self, off: u32, v: u32, o: Ordering) -> u32 {
        self.word(off).swap(v, o)
    }
}

/// A record to publish.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rec {
    Resize {
        frame: u32,
        css: (f32, f32),
        dpr: f32,
        device: (u32, u32),
    },
    Camera {
        frame: u32,
        view: (f64, f64),
        value: (f64, f64),
        band: f64,
    },
}

impl Rec {
    pub fn camera(frame: u32, lo: f64, hi: f64) -> Self {
        Rec::Camera {
            frame,
            view: (lo, hi),
            value: (f64::NAN, f64::NAN),
            band: f64::NAN,
        }
    }

    pub fn size(&self) -> u32 {
        match self {
            Rec::Resize { .. } => RESIZE_BYTES,
            Rec::Camera { .. } => CAMERA_BYTES,
        }
    }
}

/// The producer's side of one block.
#[derive(Debug, Default)]
pub struct Producer {
    pub wakes: u32,
}

fn put64(b: &Block, at: u32, v: f64) {
    let bits = v.to_bits();
    b.put(at, bits as u32);
    b.put(at + 4, (bits >> 32) as u32);
}

impl Producer {
    /// Publishes `r` with `seq`; false (nothing written) when it does not fit.
    pub fn publish(&mut self, b: &Block, r: &Rec, seq: u32, t_ms: f64) -> bool {
        let head = b.head();
        let tail = b.load(off::INPUT_TAIL, Ordering::Acquire);
        let size = r.size();
        let mut phys = head & (RING_BYTES - 1);
        let gap = if phys + size > RING_BYTES {
            RING_BYTES - phys
        } else {
            0
        };
        let free = RING_BYTES - head.wrapping_sub(tail);
        if free < size + gap {
            return false;
        }
        if gap > 0 {
            b.put(phys, u32::from(rec::WRAP) | (gap << 16));
            phys = 0;
        }
        let kind = match r {
            Rec::Resize { .. } => rec::RESIZE,
            Rec::Camera { .. } => rec::CAMERA,
        };
        b.put(phys, u32::from(kind) | (size << 16));
        b.put(phys + 4, seq);
        put64(b, phys + 8, t_ms);
        match *r {
            Rec::Resize {
                frame,
                css,
                dpr,
                device,
            } => {
                b.put(phys + 16, css.0.to_bits());
                b.put(phys + 20, css.1.to_bits());
                b.put(phys + 24, dpr.to_bits());
                b.put(phys + 28, device.0);
                b.put(phys + 32, device.1);
                b.put(phys + 36, frame);
            }
            Rec::Camera {
                frame,
                view,
                value,
                band,
            } => {
                b.put(phys + 16, frame);
                b.put(phys + 20, 0);
                put64(b, phys + 24, view.0);
                put64(b, phys + 32, view.1);
                put64(b, phys + 40, value.0);
                put64(b, phys + 48, value.1);
                put64(b, phys + 56, band);
            }
        }
        b.store(
            off::INPUT_HEAD,
            head.wrapping_add(gap + size),
            Ordering::SeqCst,
        );
        if b.swap(off::INPUT_IDLE, 0, Ordering::SeqCst) == 1 {
            self.wakes += 1;
        }
        true
    }
}
