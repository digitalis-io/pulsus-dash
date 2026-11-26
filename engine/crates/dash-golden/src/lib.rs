//! Headless golden renders on lavapipe (T05-004, T05-005), ꟻLIP comparison and the decimation
//! references (plan #68 §3.12, A.4, A.15.2).

pub mod flip;
pub mod reference;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dash_gpu::{GpuContext, HeadlessTarget};
use dash_marks::desc::{DrawList, MarkItem};
use dash_marks::line::{Renderer, RendererOptions};
use dash_scales::Range64;
use dash_scales::encode::{axis_map, choose_encoding, is_far};
use dash_scene::hover::{HoverAt, hover_at, overlay_item};
use dash_scene::{
    Band, Camera, PlotCamera, SelectionIn, Size64, Theme, ValueRange, Viewport, VisSpec, YRange,
};
use dash_tokens::Rgba8;
use dash_wire::{Chunk, ChunkBuilder, ChunkId, SeriesMeta};
use pulsus_synth::{GALLERY_WINDOW, GalleryLine, gallery_line};

pub use flip::{FlipStats, flip_mean, flip_stats};
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

    /// An 8-bit RGBA or RGB (made opaque) PNG.
    pub fn read_png(path: &Path) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut reader = png::Decoder::new(std::io::BufReader::new(file))
            .read_info()
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let size = reader
            .output_buffer_size()
            .ok_or_else(|| format!("{}: too large", path.display()))?;
        let mut buf = vec![0; size];
        let info = reader
            .next_frame(&mut buf)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        if info.bit_depth != png::BitDepth::Eight {
            return Err(format!("{}: not 8-bit RGB or RGBA", path.display()));
        }
        buf.truncate(info.buffer_size());
        let rgba = match info.color_type {
            png::ColorType::Rgba => buf,
            // Browser screenshots (`golden:engine-line`) are RGB: opaque.
            png::ColorType::Rgb => buf
                .as_chunks::<3>()
                .0
                .iter()
                .flat_map(|p| [p[0], p[1], p[2], 255])
                .collect(),
            _ => return Err(format!("{}: not 8-bit RGB or RGBA", path.display())),
        };
        Ok(Self {
            w: info.width,
            h: info.height,
            rgba,
        })
    }

    /// Writes an 8-bit RGBA PNG, creating the parent directory.
    pub fn write_png(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), self.w, self.h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc
            .write_header()
            .map_err(|e| format!("{}: {e}", path.display()))?;
        w.write_image_data(&self.rgba)
            .map_err(|e| format!("{}: {e}", path.display()))
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
        let suffix = if self.manual {
            "-manual"
        } else if self.dpr == 2.0 {
            "@2x"
        } else {
            ""
        };
        format!("{}-{theme}{suffix}", self.line.id())
    }
}

/// The ten engine line goldens (plan #68 §3.12).
pub fn pages() -> Vec<Page> {
    let mut out = Vec::new();
    for line in GalleryLine::ALL {
        for theme in [Theme::Dark, Theme::Light] {
            out.push(Page {
                line,
                theme,
                dpr: 1.0,
                manual: false,
            });
        }
    }
    out.push(Page {
        line: GalleryLine::Line50,
        theme: Theme::Dark,
        dpr: 2.0,
        manual: false,
    });
    out.push(Page {
        line: GalleryLine::Line50,
        theme: Theme::Dark,
        dpr: 1.0,
        manual: true,
    });
    out
}

/// The golden frame size, CSS px.
pub const PAGE_CSS: Size64 = Size64 {
    w: 1118.0,
    h: 240.0,
};

/// The gallery viewport of `line`.
pub fn page_viewport(
    line: GalleryLine,
    theme: Theme,
    css: Size64,
    dpr: f32,
    value_range: Option<ValueRange>,
) -> Viewport {
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
        events: std::sync::Arc::from([]),
        selection: Default::default(),
    }
}

/// The layer pages (plan #68 C2c1): gallery pages with threshold lines and event lines, whose
/// inputs (spec JSON, series and event times) are the `engine/fixtures/layer.json` cases of the
/// same id (written from `dev/gallery.ts` by `engine-fixtures.ts`).
pub const LAYER_PAGES: [&str; 2] = ["line-thresholds", "line-events"];

/// A fixture number: a JSON number or "NaN", "Infinity", "-Infinity".
fn fixture_num(v: &serde_json::Value) -> f64 {
    match v {
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        serde_json::Value::String(s) if s == "Infinity" => f64::INFINITY,
        serde_json::Value::String(s) if s == "-Infinity" => f64::NEG_INFINITY,
        _ => f64::NAN,
    }
}

fn fixture_nums(v: &serde_json::Value) -> Vec<f64> {
    v.as_array()
        .map(|a| a.iter().map(fixture_num).collect())
        .unwrap_or_default()
}

/// The chunk of a fixture's `series` (`{key, labels, t, v}`), in the local id space.
pub fn fixture_chunk(series: &serde_json::Value) -> Result<Chunk, String> {
    let mut b = ChunkBuilder::explicit(ChunkId(1 << 63));
    for s in series.as_array().into_iter().flatten() {
        let key = s["key"].as_str().unwrap_or_default();
        let key_hash = u64::from_str_radix(key, 16).map_err(|e| format!("key {key:?}: {e}"))?;
        let labels: Vec<(String, String)> = s["labels"]
            .as_object()
            .map(|o| {
                o.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                    .collect()
            })
            .unwrap_or_default();
        let meta = SeriesMeta {
            key_hash,
            labels: labels.into(),
        };
        b.push_series(meta, Some(&fixture_nums(&s["t"])), &fixture_nums(&s["v"]))
            .map_err(|e| e.to_string())?;
    }
    Ok(b.finish())
}

/// The viewport of `layer.json` case `id` (a [`LAYER_PAGES`] page) at `css` and `dpr`: its spec,
/// series, event times and window, on the idle camera of the spec.
pub fn layer_viewport(id: &str, theme: Theme, css: Size64, dpr: f32) -> Result<Viewport, String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/layer.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let row = rows
        .iter()
        .find(|r| r["case"].as_str() == Some(id))
        .ok_or_else(|| format!("layer.json has no case {id:?}"))?;
    let spec = VisSpec::from_json(row["spec"].as_str().unwrap_or_default())
        .map_err(|e| format!("{id}: {e}"))?;
    let window = Range64 {
        lo: fixture_num(&row["window"]["fromMs"]),
        hi: fixture_num(&row["window"]["toMs"]),
    };
    Ok(Viewport {
        id: 0,
        frame_id: None,
        css,
        dpr,
        theme,
        camera: Camera::Plot2D(PlotCamera::idle(window, &spec)),
        spec,
        data: Some(Arc::new(fixture_chunk(&row["series"])?)),
        band: Band::Measure,
        events: Arc::from(fixture_nums(&row["events"])),
        selection: Default::default(),
    })
}

/// Renders a layer page (plan #68 C2c1).
pub fn render_layer_page(
    ctx: &GpuContext,
    id: &str,
    theme: Theme,
    css: Size64,
    dpr: f32,
) -> Result<Image, String> {
    let v = layer_viewport(id, theme, css, dpr)?;
    let (list, _) = dash_scene::build(&v);
    let mut r = Renderer::new(
        ctx,
        wgpu::TextureFormat::Rgba8Unorm,
        RendererOptions::default(),
    );
    Ok(render_list(ctx, &mut r, &list))
}

/// The middle 40 % of the page's auto domain (the `-manual` golden).
pub fn manual_range(line: GalleryLine, css: Size64) -> Option<ValueRange> {
    let v = page_viewport(line, Theme::Dark, css, 1.0, None);
    let ax = dash_scene::build(&v).1?.value_axis?;
    let span = ax.max - ax.min;
    Some(ValueRange {
        min: ax.min + 0.3 * span,
        max: ax.min + 0.7 * span,
    })
}

/// Device px of a CSS size.
pub fn device_size(css: (f64, f64), dpr: f32) -> (u32, u32) {
    (
        (css.0 * f64::from(dpr)).round() as u32,
        (css.1 * f64::from(dpr)).round() as u32,
    )
}

/// Renders `list` into a fresh headless target.
pub fn render_list(ctx: &GpuContext, r: &mut Renderer, list: &DrawList) -> Image {
    let (w, h) = device_size(list.css, list.dpr);
    let mut t = HeadlessTarget::new(ctx, w, h);
    let _ = r.render(ctx, list, &mut t);
    Image {
        w,
        h,
        rgba: t.read(ctx),
    }
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
    let v = page_viewport(page, theme, css, dpr, value_range);
    let (list, _) = dash_scene::build(&v);
    let mut r = Renderer::new(
        ctx,
        wgpu::TextureFormat::Rgba8Unorm,
        RendererOptions::default(),
    );
    render_list(ctx, &mut r, &list)
}

/// The overlay of a native render (plan #68 C2b): a pointer hover and a box band, CSS px.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OverlayAt {
    pub hover: Option<(f64, f64)>,
    pub box_x: Option<(f64, f64)>,
}

/// Renders a gallery page with the overlay the engine draws for `o` (plan #68 C2b): the pointer
/// hover picked on the page's presentation (`dash-scene::hover`) and the box band; and with the
/// page `selection` (plan #68 C2c2: the emphasis and the interval band).
pub fn render_page_overlay(
    ctx: &GpuContext,
    page: GalleryLine,
    theme: Theme,
    css: Size64,
    dpr: f32,
    value_range: Option<ValueRange>,
    o: OverlayAt,
    selection: &SelectionIn,
) -> Image {
    let mut v = page_viewport(page, theme, css, dpr, value_range);
    v.selection = Arc::new(selection.clone());
    let b = dash_scene::build_frame(&v);
    let mut list = b.list;
    if let Some(p) = b.pick.as_deref() {
        let h = o
            .hover
            .and_then(|(x, y)| hover_at(p, HoverAt::Pointer { x, y }));
        list.items.push(overlay_item(p, h.as_ref(), o.box_x, theme));
    }
    let mut r = Renderer::new(
        ctx,
        wgpu::TextureFormat::Rgba8Unorm,
        RendererOptions::default(),
    );
    render_list(ctx, &mut r, &list)
}

pub const WHITE: Rgba8 = Rgba8([255, 255, 255, 255]);
pub const BLACK: Rgba8 = Rgba8([0, 0, 0, 255]);

/// A line-only draw list, white on black, made as `build` makes the line item for this plot and
/// axis; the reference renders use it so the plot is exactly `plot`.
#[allow(clippy::too_many_arguments)]
pub fn line_list(
    chunk: Arc<Chunk>,
    css: (f64, f64),
    dpr: f32,
    plot: [f64; 4],
    window: (f64, f64),
    axis: Range64,
    clip: bool,
) -> DrawList {
    let enc = choose_encoding(
        chunk.finite.map(Range64::from),
        axis,
        plot[3] * f64::from(dpr),
    );
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
            emphasis: None,
            width_css: dash_tokens::size::CHART_LINE,
            chunk,
        });
    }
    let cam = Camera::Plot2D(PlotCamera {
        x: Range64::from(window),
        y: YRange::Manual(axis),
    });
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
    let text =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools.toml"))
            .ok()?;
    let (table, name) = key.split_once('.')?;
    let mut current = String::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if let Some(t) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = t.to_owned();
        } else if current == table
            && let Some((k, v)) = line.split_once('=')
            && k.trim() == name
        {
            return Some(v.trim().trim_matches('"').to_owned());
        }
    }
    None
}

/// T05-004: the adapter is llvmpipe and its Mesa is `tools.toml [golden] mesa_upstream`.
pub fn pinned_driver(ctx: &GpuContext) -> Result<(), String> {
    let want =
        tools_value("golden.mesa_upstream").ok_or("tools.toml has no [golden] mesa_upstream")?;
    if ctx.info.driver != "llvmpipe" {
        return Err(format!(
            "adapter driver {:?} is not llvmpipe",
            ctx.info.driver
        ));
    }
    if !ctx.info.driver_info.contains(&format!("Mesa {want}")) {
        return Err(format!(
            "driver_info {:?} is not Mesa {want}",
            ctx.info.driver_info
        ));
    }
    Ok(())
}
