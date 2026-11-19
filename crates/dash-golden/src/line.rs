//! Line-chart renders for the golden tests (plan #24 §3.6, §4.4): the visual image, the binary
//! mask pass and the GPU records of a [`LineData`] at a [`View`], decimated (T1 compute or T2
//! render-to-texture) or by the reference (every raw segment and isolated sample, one item per
//! slot per pass, `Max` blended).
//!
//! The functions panic (with the cause) when the GPU work fails: they are a test harness.

use std::sync::PoisonError;

use dash_marks::line::{DecimatePath, LineLayout, LineMark};
use dash_scales::lod::{
    EMPTY, Prepared, Pyramid, ReferenceCursor, SlotRecord, build_pyramid, prepare, rel_bits,
};
use dash_scales::raster::Mask;
use dash_scene::line::{LayerInfo, LineFrame, LineScene};
use pulsus_synth::line::{LinePreset, series};

use crate::headless::Headless;

/// A line layer as the render worker holds it: bits relative to each series' `v_ref`.
#[derive(Clone, Debug, PartialEq)]
pub struct LineData {
    pub layer: LayerInfo,
    pub bits: Vec<Vec<u32>>,
    pub prepared: Vec<Prepared>,
}

impl LineData {
    /// Every series of `p` at `seed` (generated on all cores).
    pub fn synth(seed: u64, p: &LinePreset) -> LineData {
        let ids: Vec<u32> = (0..p.series).collect();
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
        let chunk = ids.len().div_ceil(threads).max(1);
        let mut rows: Vec<(Vec<u32>, Prepared)> = Vec::with_capacity(ids.len());
        std::thread::scope(|scope| {
            let handles: Vec<_> = ids
                .chunks(chunk)
                .map(|part| {
                    scope.spawn(move || {
                        part.iter()
                            .map(|&id| {
                                let s = series(seed, p, id);
                                let valid = |k: usize| s.valid[k];
                                let pr = prepare(&s.values, &valid);
                                let mut bits = vec![0u32; s.values.len()];
                                rel_bits(&s.values, &valid, pr.v_ref, &mut bits);
                                (bits, pr)
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            for h in handles {
                match h.join() {
                    Ok(part) => rows.extend(part),
                    Err(e) => std::panic::resume_unwind(e),
                }
            }
        });
        let (bits, prepared) = rows.into_iter().unzip();
        LineData {
            layer: LayerInfo {
                start_ms: p.start_ms,
                step_ms: p.step_ms,
                n: p.points,
                requested: p.series,
                held: p.series,
            },
            bits,
            prepared,
        }
    }

    fn series(&self) -> u32 {
        self.bits.len() as u32
    }

    /// One series as its own layer.
    fn only(&self, i: u32) -> LineData {
        LineData {
            layer: LayerInfo {
                requested: 1,
                held: 1,
                ..self.layer
            },
            bits: vec![self.bits[i as usize].clone()],
            prepared: vec![self.prepared[i as usize]],
        }
    }

    /// A cheap content fingerprint (cache key).
    fn fingerprint(&self) -> u64 {
        let mut h: u64 = 0xCBF2_9CE4_8422_2325;
        let mut eat = |v: u64| {
            h ^= v;
            h = h.wrapping_mul(0x0000_0100_0000_01B3);
        };
        eat(self.layer.start_ms as u64);
        eat(self.layer.step_ms as u64);
        eat(u64::from(self.layer.n));
        for (b, p) in self.bits.iter().zip(&self.prepared) {
            eat(p.v_ref.to_bits());
            eat(b.len() as u64);
            let stride = (b.len() / 64).max(1);
            for v in b.iter().step_by(stride) {
                eat(u64::from(*v));
            }
        }
        h
    }
}

/// A canvas and camera. The scene fits both axes; `x`, `y` then replace the camera's x
/// (`t_left_rel_ms`, `ms_per_px`) or y (`v_bottom`, `v_per_px`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    pub css: (u32, u32),
    pub dpr: f32,
    pub x: Option<(f64, f64)>,
    pub y: Option<(f64, f64)>,
}

/// What draws the line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Render {
    Decimated(DecimatePath),
    /// Every raw segment and isolated sample, one item per slot per pass (§4.4).
    Reference,
}

/// The line scene of `d` at `v`.
fn scene(d: &LineData, v: &View) -> LineScene {
    let mut s = LineScene::new();
    s.set_layer(d.layer);
    s.set_canvas(v.css.0 as f32, v.css.1 as f32, v.dpr);
    for p in &d.prepared {
        s.add_series(*p);
    }
    let c = s.controller_mut();
    let mut cam = *c.camera();
    let l = *c.limits();
    if let Some((t, m)) = v.x {
        cam.t_left_rel_ms = t;
        cam.ms_per_px = m;
    }
    if let Some((b, p)) = v.y {
        cam.v_bottom = b;
        cam.v_per_px = p;
    }
    c.set_camera(cam, l);
    s
}

/// The device's layout of `d` (`max_dim` overrides the texture dimension).
fn layout(h: &Headless, d: &LineData, max_dim: Option<u32>) -> (LineLayout, u32) {
    let lim = h.device.limits();
    let md = max_dim.unwrap_or(lim.max_texture_dimension_2d);
    match LineLayout::new(d.series(), d.layer.n, md, lim.max_texture_array_layers) {
        Ok(l) => (l, md),
        Err(e) => panic!("layout of {} series × {}: {e:?}", d.series(), d.layer.n),
    }
}

/// The scene's frame for `d` at `v` (texture layout of an 8 192 / 256-layer device).
pub fn frame(d: &LineData, v: &View) -> Option<LineFrame> {
    let info = LineLayout::new(d.series(), d.layer.n, 8_192, 256)
        .map(|l| l.info())
        .ok()?;
    scene(d, v).frame(&info)
}

/// What a cached mark computes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Decimate(DecimatePath),
    Reference,
}

/// A line mark with `d` uploaded.
#[derive(Debug)]
pub(crate) struct Cached {
    key: (u64, Kind, u32, wgpu::TextureFormat),
    layout: LineLayout,
    mark: LineMark,
}

/// Marks kept per device (each holds a full copy of the data).
const CACHED: usize = 3;

/// Runs `f` with a mark holding `d` (created and uploaded on a cache miss).
fn with_mark<T>(
    h: &Headless,
    d: &LineData,
    kind: Kind,
    format: wgpu::TextureFormat,
    max_dim: Option<u32>,
    f: impl FnOnce(&mut LineMark, &LineLayout) -> T,
) -> T {
    let (layout, md) = layout(h, d, max_dim);
    let key = (d.fingerprint(), kind, md, format);
    let mut marks = h.marks.lock().unwrap_or_else(PoisonError::into_inner);
    let at = match marks
        .iter()
        .position(|c| c.key == key && c.layout == layout)
    {
        Some(i) => i,
        None => {
            let path = match kind {
                Kind::Decimate(p) => p,
                Kind::Reference => DecimatePath::Compute,
            };
            let mark = LineMark::new(&h.device, format, layout, path, 16, md);
            let mut pyr = Pyramid::default();
            for (i, bits) in d.bits.iter().enumerate() {
                build_pyramid(bits, &mut pyr);
                mark.upload_series(&h.queue, i as u32, bits, &pyr);
            }
            h.queue.submit([]);
            if marks.len() >= CACHED {
                marks.remove(0);
            }
            marks.push(Cached { key, layout, mark });
            marks.len() - 1
        }
    };
    let c = &mut marks[at];
    f(&mut c.mark, &c.layout)
}

/// Bytes per row of a buffer copy (256-aligned).
fn padded(bytes: u32) -> u32 {
    bytes.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT
}

/// Copies `tex` (`w × h × layers`, `texel` bytes) into `encoder`'s readback buffer.
fn copy_out(
    h: &Headless,
    encoder: &mut wgpu::CommandEncoder,
    tex: &wgpu::Texture,
    texel: u32,
) -> (wgpu::Buffer, u32) {
    let s = tex.size();
    let row = padded(s.width * texel);
    let buf = h.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("golden readback"),
        size: u64::from(row) * u64::from(s.height) * u64::from(s.depth_or_array_layers),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buf,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row),
                rows_per_image: Some(s.height),
            },
        },
        s,
    );
    (buf, row)
}

/// Reads back a copy made by [`copy_out`], tightly packed.
fn read_packed(
    h: &Headless,
    buf: &wgpu::Buffer,
    row: u32,
    tex: &wgpu::Texture,
    texel: u32,
) -> Vec<u8> {
    let bytes = match h.read(buf) {
        Ok(b) => b,
        Err(e) => panic!("{e}"),
    };
    let s = tex.size();
    let tight = (s.width * texel) as usize;
    bytes
        .chunks(row as usize)
        .take((s.height * s.depth_or_array_layers) as usize)
        .flat_map(|r| r[..tight].iter().copied())
        .collect()
}

/// Draws `d` at `v` into a `format` target and returns its bytes (rows top-down).
fn draw_target(
    h: &Headless,
    d: &LineData,
    v: &View,
    r: Render,
    max_dim: Option<u32>,
    format: wgpu::TextureFormat,
) -> (Vec<u8>, u32) {
    let kind = match r {
        Render::Decimated(p) => Kind::Decimate(p),
        Render::Reference => Kind::Reference,
    };
    let mask = format == wgpu::TextureFormat::R8Unorm;
    with_mark(h, d, kind, format, max_dim, |mark, layout| {
        let Some(f) = scene(d, v).frame(&layout.info()) else {
            panic!("no frame for {v:?}");
        };
        let [w, ht] = f.uniforms.canvas_px.map(|c| c as u32);
        let target = h.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("golden target"),
            size: wgpu::Extent3d {
                width: w,
                height: ht,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let tv = target.create_view(&wgpu::TextureViewDescriptor::default());
        mark.set_frame(&h.device, &h.queue, &f);
        let pass = |enc: &mut wgpu::CommandEncoder, load: wgpu::LoadOp<wgpu::Color>| {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("golden"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &tv,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            if mask {
                mark.draw_mask(&mut p);
            } else {
                mark.draw(&mut p);
            }
        };
        let clear = wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT);
        let mut enc = h.device.create_command_encoder(&Default::default());
        match r {
            Render::Decimated(_) => {
                mark.decimate(&mut enc);
                pass(&mut enc, clear);
            }
            Render::Reference => {
                let slots = f.columns.slots() as usize;
                let mut cursors: Vec<Option<ReferenceCursor>> = (0..d.series())
                    .map(|_| Some(ReferenceCursor::new(&f.columns)))
                    .collect();
                let mut recs = vec![EMPTY; slots];
                let mut ks = vec![u32::MAX; slots];
                let mut q = 0;
                loop {
                    let mut any = false;
                    for (i, c) in cursors.iter_mut().enumerate() {
                        let Some(cur) = c else { continue };
                        if cur.next_pass(&d.bits[i], &mut recs, &mut ks) {
                            any = true;
                        } else {
                            *c = None;
                        }
                        // Exhausted series are written once more, as EMPTY.
                        mark.write_records(&h.queue, &recs, &ks, i as u32);
                    }
                    if !any && q > 0 {
                        break;
                    }
                    pass(&mut enc, if q == 0 { clear } else { wgpu::LoadOp::Load });
                    h.queue.submit([enc.finish()]);
                    enc = h.device.create_command_encoder(&Default::default());
                    q += 1;
                    if !any {
                        break;
                    }
                }
            }
        }
        let texel = if mask { 1 } else { 4 };
        let (buf, row) = copy_out(h, &mut enc, &target, texel);
        h.queue.submit([enc.finish()]);
        (read_packed(h, &buf, row, &target, texel), w)
    })
}

/// The visual image (`Rgba8Unorm`, rows top-down, no gridlines).
pub fn render(h: &Headless, d: &LineData, v: &View, r: Render, max_dim: Option<u32>) -> Vec<u8> {
    draw_target(h, d, v, r, max_dim, wgpu::TextureFormat::Rgba8Unorm).0
}

/// The GPU records of every series (slot order).
pub fn records(h: &Headless, d: &LineData, v: &View, p: DecimatePath) -> Vec<Vec<SlotRecord>> {
    with_mark(
        h,
        d,
        Kind::Decimate(p),
        wgpu::TextureFormat::Rgba8Unorm,
        None,
        |mark, layout| {
            let Some(f) = scene(d, v).frame(&layout.info()) else {
                panic!("no frame for {v:?}");
            };
            mark.set_frame(&h.device, &h.queue, &f);
            let mut enc = h.device.create_command_encoder(&Default::default());
            mark.decimate(&mut enc);
            let [ta, tb] = mark.record_textures();
            let (ba, ra) = copy_out(h, &mut enc, ta, 16);
            let (bb, rb) = copy_out(h, &mut enc, tb, 16);
            h.queue.submit([enc.finish()]);
            let a: Vec<[u32; 4]> = bytemuck::pod_collect_to_vec(&read_packed(h, &ba, ra, ta, 16));
            let b: Vec<[u32; 4]> = bytemuck::pod_collect_to_vec(&read_packed(h, &bb, rb, tb, 16));
            let size = ta.size();
            let (tile_w, rows) = (mark.tile_w() as usize, size.height as usize);
            let width = size.width as usize;
            (0..d.series() as usize)
                .map(|i| {
                    (0..f.columns.slots() as usize)
                        .map(|s| {
                            let at = (s / tile_w) * rows * width + i * width + s % tile_w;
                            SlotRecord { a: a[at], b: b[at] }
                        })
                        .collect()
                })
                .collect()
        },
    )
}

/// The mask pass of `series` (all if `None`), read back. A single series is drawn as its own
/// layer at the full scene's camera (same columns and `y` map).
pub fn render_mask(h: &Headless, d: &LineData, v: &View, r: Render, series: Option<u32>) -> Mask {
    if let Some(i) = series {
        let c = *scene(d, v).controller_mut().camera();
        let one = View {
            x: Some((c.t_left_rel_ms, c.ms_per_px)),
            y: Some((c.v_bottom, c.v_per_px)),
            ..*v
        };
        return render_mask(h, &d.only(i), &one, r, None);
    }
    let (bytes, w) = draw_target(h, d, v, r, None, wgpu::TextureFormat::R8Unorm);
    let Some(f) = frame(d, v) else {
        panic!("no frame for {v:?}");
    };
    Mask::from_r8(&bytes, w, &f.plot)
}

/// Panics naming `(missing, extra)` unless both are 0.
pub fn assert_zero_diff(got: &Mask, want: &Mask) {
    let (missing, extra) = dash_scales::raster::mask_diff(got, want);
    if (missing, extra) != (0, 0) {
        panic!("zero-diff failed: (missing, extra) = ({missing}, {extra})");
    }
}
