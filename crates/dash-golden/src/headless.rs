//! The headless lavapipe device (T05 §4.2, T05-004): Mesa's software Vulkan driver, pinned in
//! `ci/tools.toml`, with the device limits of a browser tier.

use std::sync::Mutex;

use dash_gpu::{Tier, required_limits};

use crate::line::Cached;

/// Why the harness cannot run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GoldenError {
    /// No Vulkan adapter named `llvmpipe`.
    NoLavapipe,
    /// The device request failed.
    Device(String),
    /// Mapping a readback buffer failed.
    Readback(String),
}

impl std::fmt::Display for GoldenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GoldenError::NoLavapipe => f.write_str("no Vulkan llvmpipe (lavapipe) adapter"),
            GoldenError::Device(e) => write!(f, "lavapipe device: {e}"),
            GoldenError::Readback(e) => write!(f, "readback: {e}"),
        }
    }
}

impl std::error::Error for GoldenError {}

/// A lavapipe device with the limits of a browser tier.
#[derive(Debug)]
pub struct Headless {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
    /// Line marks with uploaded data, reused across renders of the same data.
    pub(crate) marks: Mutex<Vec<Cached>>,
}

impl Headless {
    /// The Vulkan `llvmpipe` adapter with `required_limits(limits_of, adapter)`.
    pub fn lavapipe(limits_of: Tier) -> Result<Headless, GoldenError> {
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(desc);
        let adapter = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::VULKAN))
            .into_iter()
            .find(|a| a.get_info().name.contains("llvmpipe"))
            .ok_or(GoldenError::NoLavapipe)?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("dash-golden"),
            required_features: wgpu::Features::empty(),
            required_limits: required_limits(limits_of, &adapter.limits()),
            ..Default::default()
        }))
        .map_err(|e| GoldenError::Device(e.to_string()))?;
        Ok(Headless {
            device,
            queue,
            info: adapter.get_info(),
            marks: Mutex::new(Vec::new()),
        })
    }

    /// Waits for the queue and maps `buf` for reading.
    pub(crate) fn read(&self, buf: &wgpu::Buffer) -> Result<Vec<u8>, GoldenError> {
        let slice = buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            // The receiver waits below; a send can only fail if it was dropped.
            let _ = tx.send(r);
        });
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(std::time::Duration::from_secs(600)),
            })
            .map_err(|e| GoldenError::Readback(e.to_string()))?;
        rx.recv()
            .map_err(|e| GoldenError::Readback(e.to_string()))?
            .map_err(|e| GoldenError::Readback(e.to_string()))?;
        let bytes = slice
            .get_mapped_range()
            .map_err(|e| GoldenError::Readback(format!("{e:?}")))?
            .to_vec();
        buf.unmap();
        Ok(bytes)
    }
}
