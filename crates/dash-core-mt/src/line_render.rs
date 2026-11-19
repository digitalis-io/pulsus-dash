//! The line scene of the render worker (plan #24 §4.1, §4.2): owns the [`LineScene`], the
//! [`LineMark`], the [`SegmentMark`], the staging bits and the pyramid buffer. Each frame it
//! creates the mark once the layer is published, converts and uploads at most
//! `UPLOAD_SAMPLES_PER_FRAME` samples (copy 2, T04-015), decimates when the frame changed, draws
//! the axes and the line, and posts the coverage reasons on change. It never takes a lock and
//! never waits on data-0 (T03-008).

use std::cell::Cell;
use std::rc::Rc;

use dash_gpu::{Gpu, Tier};
use dash_marks::line::{DecimatePath, LayoutError, LineLayout, LineMark};
use dash_marks::segment::SegmentMark;
use dash_scales::Plot;
use dash_scales::lod::{MARGIN, Pyramid, build_pyramid, rel_bits};
use dash_scene::line::{LayerInfo, LineScene};
use dash_tokens::spike::{AXIS, CANVAS_BG, LINE_WIDTH_CSS};
use wasm_bindgen::JsCast;

use crate::flags::LineFault;
use crate::line_load::uploads_this_frame;
use crate::line_table::TABLE;

/// How a line frame ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FrameEnd {
    /// Presented a frame.
    Presented,
    /// Nothing presented this time (surface outdated, occluded or timed out).
    Skipped,
    /// The tier failed (surface validation, out of memory); the loop stops.
    Failed,
}

/// The mark, once the layer is known.
struct Marked {
    layout: LineLayout,
    mark: LineMark,
}

/// The render worker's line state (plan §4.1 ownership table).
pub(crate) struct LineActive {
    pub(crate) scene: LineScene,
    marked: Option<Marked>,
    segments: SegmentMark,
    path: DecimatePath,
    layers_fault: bool,
    staging: Vec<u32>,
    pyramid: Pyramid,
    uploaded: u32,
    load_failed_seen: bool,
    prev_uniforms: Vec<u8>,
    prev_bounds: Vec<u32>,
    coverage_sent: Option<String>,
    /// Set by the out-of-memory error scope of the mark's allocation.
    oom: Rc<Cell<bool>>,
    dpr: f32,
    #[cfg_attr(not(feature = "probe"), allow(dead_code))]
    slots: u32,
    #[cfg_attr(not(feature = "probe"), allow(dead_code))]
    draws: (u32, u32),
    #[cfg_attr(not(feature = "probe"), allow(dead_code))]
    plot: Plot,
}

/// What the probe reports of the line scene.
#[cfg(feature = "probe")]
#[derive(Clone, Copy, Debug)]
pub(crate) struct LineProbe {
    pub(crate) decimation: &'static str,
    pub(crate) uploaded: u32,
    pub(crate) slots: u32,
    pub(crate) dpr: f32,
    pub(crate) draws: (u32, u32),
    pub(crate) plot: Plot,
}

/// Posts `{t: "coverage", reasons}` to the main thread (the shim sets `data-dash-coverage`).
fn post_coverage(reasons: &str) {
    let g = js_sys::global();
    let msg = js_sys::Object::new();
    // Setting data properties on a fresh plain object cannot fail.
    let _ = js_sys::Reflect::set(&msg, &"t".into(), &"coverage".into());
    let _ = js_sys::Reflect::set(&msg, &"reasons".into(), &reasons.into());
    if let Ok(post) = js_sys::Reflect::get(&g, &"postMessage".into())
        .and_then(|f| f.dyn_into::<js_sys::Function>())
    {
        // A failed post only delays the indication: it is re-sent on the next change.
        let _ = post.call1(&g, &msg);
    }
}

impl LineActive {
    pub(crate) fn new(gpu: &Gpu, fault: Option<LineFault>) -> LineActive {
        LineActive {
            scene: LineScene::new(),
            marked: None,
            segments: SegmentMark::new(&gpu.device, gpu.config.format),
            path: match gpu.tier {
                Tier::WebGpu => DecimatePath::Compute,
                Tier::WebGl2 => DecimatePath::Fragment,
            },
            layers_fault: fault == Some(LineFault::Layers1),
            staging: Vec::new(),
            pyramid: Pyramid::default(),
            uploaded: 0,
            load_failed_seen: false,
            prev_uniforms: Vec::new(),
            prev_bounds: Vec::new(),
            coverage_sent: None,
            oom: Rc::new(Cell::new(false)),
            dpr: 1.0,
            slots: 0,
            draws: (0, 0),
            plot: Plot {
                x0: 0.0,
                y0: 0.0,
                w: 0,
                h: 0,
            },
        }
    }

    /// After `Gpu::resize`: the scene's canvas is the surface's size, so the plot scissor always
    /// lies inside the surface.
    pub(crate) fn on_resize(&mut self, gpu: &Gpu, dpr: f32) {
        if dpr > 0.0 {
            self.dpr = dpr;
            let (w, h) = (gpu.config.width as f32, gpu.config.height as f32);
            self.scene.set_canvas(w / dpr, h / dpr, dpr);
        }
    }

    /// Step 3a: the layout and mark of the published layer (plan §4.2). `TooLarge` caps the
    /// series at the texture ceiling.
    fn ensure_mark(&mut self, gpu: &Gpu) {
        if self.marked.is_some() {
            return;
        }
        let Some(layer) = TABLE.layer() else {
            return;
        };
        let limits = gpu.device.limits();
        let max_dim = limits.max_texture_dimension_2d;
        let max_layers = if self.layers_fault {
            1
        } else {
            limits.max_texture_array_layers
        };
        let n = layer.grid.len;
        let layout = match LineLayout::new(layer.held, n, max_dim, max_layers) {
            Ok(l) => l,
            Err(LayoutError::TooLarge { max_series }) => {
                self.scene.set_texture_ceiling(max_series);
                match LineLayout::new(max_series, n, max_dim, max_layers) {
                    Ok(l) => l,
                    Err(_) => return,
                }
            }
        };
        self.scene.set_layer(LayerInfo {
            start_ms: layer.grid.start_ms,
            step_ms: layer.grid.step_ms,
            n,
            requested: layer.requested,
            held: layer.held,
        });
        self.staging.resize(n as usize, 0);
        let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let slots = gpu.config.width + 2 * MARGIN + 2;
        let mark = LineMark::new(
            &gpu.device,
            gpu.config.format,
            layout,
            self.path,
            slots,
            max_dim,
        );
        let oom = self.oom.clone();
        let popped = scope.pop();
        wasm_bindgen_futures::spawn_local(async move {
            if popped.await.is_some() {
                oom.set(true);
            }
        });
        self.marked = Some(Marked { layout, mark });
    }

    /// Converts and uploads this frame's series (step 3b), within the upload budget.
    fn upload(&mut self, gpu: &Gpu) -> bool {
        let Some(m) = &self.marked else {
            return false;
        };
        let published = TABLE.published().min(m.layout.series);
        let mut any = false;
        for _ in 0..uploads_this_frame(published, self.uploaded, m.layout.n) {
            let Some(c) = TABLE.pin(self.uploaded) else {
                break;
            };
            let s = &c.series;
            rel_bits(
                &s.values,
                &|k| s.is_valid(k),
                c.prepared.v_ref,
                &mut self.staging,
            );
            build_pyramid(&self.staging, &mut self.pyramid);
            m.mark
                .upload_series(&gpu.queue, self.uploaded, &self.staging, &self.pyramid);
            self.scene.add_series(c.prepared);
            self.uploaded += 1;
            any = true;
        }
        any
    }

    /// Steps 3a–5 of plan §4.2 at main-thread time `t_main_ms`.
    pub(crate) fn frame(&mut self, gpu: &mut Gpu, t_main_ms: f64) -> FrameEnd {
        if self.oom.get() {
            return FrameEnd::Failed;
        }
        self.ensure_mark(gpu);
        let mut dirty = self.upload(gpu);
        if TABLE.load_failed() && !self.load_failed_seen {
            self.scene.set_load_failed();
            self.load_failed_seen = true;
        }

        self.scene.step(t_main_ms);
        let frame = self
            .marked
            .as_ref()
            .and_then(|m| self.scene.frame(&m.layout.info()));
        if let (Some(f), Some(m)) = (&frame, &mut self.marked) {
            m.mark.set_frame(&gpu.device, &gpu.queue, f);
            let u = bytemuck::bytes_of(f.uniforms.as_ref());
            if u != self.prev_uniforms.as_slice() || f.columns.bounds != self.prev_bounds {
                dirty = true;
                self.prev_uniforms.clear();
                self.prev_uniforms.extend_from_slice(u);
                self.prev_bounds.clear();
                self.prev_bounds.extend_from_slice(&f.columns.bounds);
            }
            self.slots = f.columns.slots();
            self.plot = f.plot;
        }

        let surface = match gpu.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f)
            | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                gpu.reconfigure();
                return FrameEnd::Skipped;
            }
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return FrameEnd::Skipped;
            }
            wgpu::CurrentSurfaceTexture::Validation => return FrameEnd::Failed,
        };
        let view = surface
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        if let (true, Some(m)) = (dirty, &self.marked) {
            m.mark.decimate(&mut encoder);
        }
        {
            let [r, g, b, a] = CANVAS_BG;
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("line"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r, g, b, a }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            if let (Some(f), Some(m)) = (&frame, &self.marked) {
                let half_w = 0.5 * (LINE_WIDTH_CSS * self.dpr).max(1.0);
                self.segments.draw(
                    &gpu.device,
                    &gpu.queue,
                    &mut pass,
                    f.uniforms.canvas_px,
                    half_w,
                    AXIS,
                    &f.grid,
                );
                m.mark.draw(&mut pass);
            }
        }
        gpu.queue.submit([encoder.finish()]);
        gpu.queue.present(surface);
        self.draws = (
            self.marked.as_ref().map_or(0, |m| m.mark.take_draw_count()),
            self.segments.take_draw_count(),
        );
        let ids = self.scene.coverage().ids();
        if self.coverage_sent.as_deref() != Some(ids.as_str()) {
            post_coverage(&ids);
            self.coverage_sent = Some(ids);
        }
        FrameEnd::Presented
    }

    #[cfg(feature = "probe")]
    pub(crate) fn probe(&self) -> LineProbe {
        LineProbe {
            decimation: match self.path {
                DecimatePath::Compute => "compute",
                DecimatePath::Fragment => "fragment",
            },
            uploaded: self.uploaded,
            slots: self.slots,
            dpr: self.dpr,
            draws: self.draws,
            plot: self.plot,
        }
    }
}
