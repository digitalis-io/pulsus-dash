//! Headless golden renders on lavapipe (T05-004, T05-005), ꟻLIP comparison and the decimation
//! references (plan #68 §3.12, A.4, A.15.2).

pub mod flip;
pub mod reference;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dash_gpu::{GpuContext, HeadlessTarget};
use dash_marks::desc::{DrawList, MarkItem};
use dash_marks::line::Renderer;
use dash_scales::Range64;
use dash_scales::encode::{axis_map, choose_encoding, is_far};
use dash_scene::{Band, Camera, PlotCamera, Size64, Theme, ValueRange, Viewport, VisSpec, YRange};
use dash_tokens::Rgba8;
use dash_wire::Chunk;
use pulsus_synth::{GALLERY_WINDOW, GalleryLine, gallery_line};

pub use flip::flip_mean;
pub use reference::{RefFrame, RefMasks, reference_mask};

/// An RGBA8 image, rows without padding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
}

impl Image {
    /// Red channel > 0 (the A.4 coverage rule for white-on-black renders).
    pub fn covered(&self, x: u32, y: u32) -> bool {
        x < self.w && y < self.h && self.rgba[((y * self.w + x) * 4) as usize] > 0
    }

    pub fn read_png(path: &Path) -> Result<Self, String> {
        let _ = path;
        Err("not implemented".into())
    }

    pub fn write_png(&self, path: &Path) -> Result<(), String> {
        let _ = path;
        Err("not implemented".into())
    }
}

/// The committed goldens directory.
pub fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("goldens")
}

/// One golden page.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Page {
    pub line: GalleryLine,
    pub theme: Theme,
    pub dpr: f32,
    pub manual: bool,
}

impl Page {
    /// `<page>-<theme>[@2x|-manual]`.
    pub fn name(&self) -> String {
        let theme = match self.theme {
            Theme::Dark => "dark",
            Theme::Light => "light",
        };
        let suffix = if self.manual { "-manual" } else if self.dpr == 2.0 { "@2x" } else { "" };
        format!("{}-{theme}{suffix}", self.line.id())
    }
}

/// The ten engine line goldens (plan #68 §3.12).
pub fn pages() -> Vec<Page> {
    let mut out = Vec::new();
    for line in GalleryLine::ALL {
        for theme in [Theme::Dark, Theme::Light] {
            out.push(Page { line, theme, dpr: 1.0, manual: false });
        }
    }
    out.push(Page { line: GalleryLine::Line50, theme: Theme::Dark, dpr: 2.0, manual: false });
    out.push(Page { line: GalleryLine::Line50, theme: Theme::Dark, dpr: 1.0, manual: true });
    out
}

/// The golden frame size, CSS px.
pub const PAGE_CSS: Size64 = Size64 { w: 1118.0, h: 240.0 };

/// The gallery viewport of `line`.
pub fn page_viewport(line: GalleryLine, theme: Theme, css: Size64, dpr: f32, value_range: Option<ValueRange>) -> Viewport {
    let (chunk, mut spec) = gallery_line(line, GALLERY_WINDOW);
    spec.value_range = value_range;
    let spec = VisSpec::Line(spec);
    Viewport {
        id: 0,
        frame_id: None,
        css,
        dpr,
        theme,
        camera: Camera::Plot2D(PlotCamera::idle(Range64::from(GALLERY_WINDOW), &spec)),
        spec,
        data: Some(Arc::new(chunk)),
        band: Band::Measure,
    }
}

/// The middle 40 % of the page's auto domain (the `-manual` golden).
pub fn manual_range(line: GalleryLine, css: Size64) -> Option<ValueRange> {
    let v = page_viewport(line, Theme::Dark, css, 1.0, None);
    let ax = dash_scene::build(&v).1?.value_axis?;
    let span = ax.max - ax.min;
    Some(ValueRange { min: ax.min + 0.3 * span, max: ax.min + 0.7 * span })
}

/// Device px of a CSS size.
pub fn device_size(css: (f64, f64), dpr: f32) -> (u32, u32) {
    ((css.0 * f64::from(dpr)).round() as u32, (css.1 * f64::from(dpr)).round() as u32)
}

/// Renders `list` into a fresh headless target.
pub fn render_list(ctx: &GpuContext, r: &mut Renderer, list: &DrawList) -> Image {
    let (w, h) = device_size(list.css, list.dpr);
    let mut t = HeadlessTarget::new(ctx, w, h);
    let _ = r.render(ctx, list, &mut t);
    Image { w, h, rgba: t.read(ctx) }
}

/// Renders a gallery page.
pub fn render_page(
    ctx: &GpuContext,
    page: GalleryLine,
    theme: Theme,
    css: Size64,
    dpr: f32,
    value_range: Option<ValueRange>,
) -> Image {
    let _ = (page, theme, value_range);
    let (w, h) = device_size((css.w, css.h), dpr);
    let _ = ctx;
    Image { w, h, rgba: vec![0; w as usize * h as usize * 4] }
}

pub const WHITE: Rgba8 = Rgba8([255, 255, 255, 255]);
pub const BLACK: Rgba8 = Rgba8([0, 0, 0, 255]);

/// A line-only draw list, white on black, made as `build` makes the line item for this plot and
/// axis; the reference renders use it so the plot is exactly `plot`.
#[allow(clippy::too_many_arguments)]
pub fn line_list(chunk: Arc<Chunk>, css: (f64, f64), dpr: f32, plot: [f64; 4], window: (f64, f64), axis: Range64, clip: bool) -> DrawList {
    let enc = choose_encoding(chunk.finite.map(Range64::from), axis, plot[3] * f64::from(dpr));
    let mut items = Vec::new();
    if let Some(enc) = enc {
        let m = axis_map(&enc, axis, plot[3]);
        let s = chunk.series.len() as u32;
        items.push(MarkItem::Line {
            far: is_far(&enc, chunk.finite),
            series: 0..s,
            window,
            n: plot[2].floor() as u32,
            plot: plot.map(|x| x as f32),
            encoding: enc,
            axis: (m.ku as f32, m.ou as f32),
            colour_slots: (0..s).map(|k| (k % 8) as u8).collect(),
            lanes: None,
            width_css: dash_tokens::size::CHART_LINE,
            chunk,
        });
    }
    let cam = Camera::Plot2D(PlotCamera { x: Range64::from(window), y: YRange::Manual(axis) });
    let m = cam.view_proj(Size64 { w: css.0, h: css.1 });
    DrawList {
        clear: BLACK,
        css,
        dpr,
        view_proj: m.to_cols_array_2d().map(|c| c.map(|x| x as f32)),
        palette: [WHITE; 9],
        clip: clip.then(|| plot.map(|x| x as f32)),
        items,
    }
}

/// A value of `engine/tools.toml` (`table.key`), unquoted.
pub fn tools_value(key: &str) -> Option<String> {
    let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools.toml")).ok()?;
    let (table, name) = key.split_once('.')?;
    let mut current = String::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if let Some(t) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = t.to_owned();
        } else if current == table {
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == name {
                    return Some(v.trim().trim_matches('"').to_owned());
                }
            }
        }
    }
    None
}

/// T05-004: the adapter is llvmpipe and its Mesa is `tools.toml [golden] mesa_upstream`.
pub fn pinned_driver(ctx: &GpuContext) -> Result<(), String> {
    let want = tools_value("golden.mesa_upstream").ok_or("tools.toml has no [golden] mesa_upstream")?;
    if ctx.info.driver != "llvmpipe" {
        return Err(format!("adapter driver {:?} is not llvmpipe", ctx.info.driver));
    }
    if !ctx.info.driver_info.contains(&format!("Mesa {want}")) {
        return Err(format!("driver_info {:?} is not Mesa {want}", ctx.info.driver_info));
    }
    Ok(())
}
