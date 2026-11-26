//! `dash-golden render` and `dash-golden compare` (plan #68 A.11 §3.12).
//!
//! ```text
//! dash-golden render  --page line-1|line-50|line-gaps|line-600|line-extreme|line-thresholds|line-events
//!                     --theme dark|light
//!                     --size 1118x240 --dpr 1|2 --tier t1|t2 [--value-range MIN,MAX]
//!                     [--hover X,Y] [--box X0,X] --out <png>
//! dash-golden compare <a.png> <b.png> [--region x,y,w,h]… [--max 0.005] [--tile-max V]
//!                     → prints the mean ꟻLIP, then the largest 8×8 tile mean with --tile-max
//! ```
//! Exit 0 on success (compare: mean ≤ max and, with `--tile-max`, every 8×8 tile's mean ≤ V; plan
//! #68 C1, T05-005), 1 when the comparison exceeds a limit, 2 on bad arguments or an I/O, adapter
//! or render error. `--hover` and `--box` (plan #68 C2b) draw the engine's overlay: the hover of a
//! pointer at canvas CSS px (X, Y) and the box band between X0 and X. `line-thresholds` and
//! `line-events` (plan #68 C2c1) draw the `layer.json` case of that id, without `--value-range`,
//! `--hover` or `--box`.

use std::path::PathBuf;
use std::process::ExitCode;

use dash_golden::{
    Image, LAYER_PAGES, OverlayAt, flip_stats, render_layer_page, render_page_overlay,
};
use dash_gpu::{AdapterChoice, GpuContext, Tier};
use dash_scene::{Size64, Theme, ValueRange};
use pulsus_synth::GalleryLine;

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn pair(s: &str, sep: char) -> Option<(f64, f64)> {
    let (a, b) = s.split_once(sep)?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

fn render(args: &[String]) -> Result<(), String> {
    let page = flag(args, "--page").ok_or("--page is required")?;
    let line = GalleryLine::RENDERABLE.into_iter().find(|g| g.id() == page);
    if line.is_none() && !LAYER_PAGES.contains(&page) {
        return Err(format!("unknown page {page}"));
    }
    let theme = match flag(args, "--theme").unwrap_or("dark") {
        "dark" => Theme::Dark,
        "light" => Theme::Light,
        t => return Err(format!("unknown theme {t}")),
    };
    let (w, h) = pair(flag(args, "--size").unwrap_or("1118x240"), 'x').ok_or("--size is WxH")?;
    let dpr: f32 = flag(args, "--dpr")
        .unwrap_or("1")
        .parse()
        .map_err(|_| "--dpr is a number")?;
    let tier = match flag(args, "--tier").unwrap_or("t1") {
        "t1" => Tier::T1,
        "t2" => Tier::T2,
        t => return Err(format!("unknown tier {t}")),
    };
    let value_range = match flag(args, "--value-range") {
        Some(v) => {
            let (min, max) = pair(v, ',').ok_or("--value-range is MIN,MAX")?;
            Some(ValueRange { min, max })
        }
        None => None,
    };
    let overlay = OverlayAt {
        hover: match flag(args, "--hover") {
            Some(v) => Some(pair(v, ',').ok_or("--hover is X,Y")?),
            None => None,
        },
        box_x: match flag(args, "--box") {
            Some(v) => Some(pair(v, ',').ok_or("--box is X0,X")?),
            None => None,
        },
    };
    let out = PathBuf::from(flag(args, "--out").ok_or("--out is required")?);
    let ctx = GpuContext::headless(AdapterChoice::Lavapipe, tier)
        .map_err(|e| format!("{e}; adapters: {:?}", GpuContext::adapter_list()))?;
    let Some(line) = line else {
        if value_range.is_some() || overlay != OverlayAt::default() {
            return Err(format!("{page}: no --value-range, --hover or --box"));
        }
        return render_layer_page(&ctx, page, theme, Size64 { w, h }, dpr)?.write_png(&out);
    };
    render_page_overlay(
        &ctx,
        line,
        theme,
        Size64 { w, h },
        dpr,
        value_range,
        overlay,
    )
    .write_png(&out)
}

fn compare(args: &[String]) -> Result<bool, String> {
    let files: Vec<&String> = args
        .iter()
        .skip(1)
        .take_while(|a| !a.starts_with("--"))
        .collect();
    let [a, b] = files[..] else {
        return Err("compare needs two PNG paths".into());
    };
    let (a, b) = (Image::read_png(a.as_ref())?, Image::read_png(b.as_ref())?);
    let mut regions = Vec::new();
    for (i, arg) in args.iter().enumerate() {
        if arg == "--region" {
            let v: Vec<u32> = args
                .get(i + 1)
                .ok_or("--region is x,y,w,h")?
                .split(',')
                .filter_map(|p| p.parse().ok())
                .collect();
            let [x, y, w, h] = v[..] else {
                return Err("--region is x,y,w,h".into());
            };
            regions.push([x, y, w, h]);
        }
    }
    let max: f32 = flag(args, "--max")
        .unwrap_or("0.005")
        .parse()
        .map_err(|_| "--max is a number")?;
    let tile_max: Option<f32> = match flag(args, "--tile-max") {
        Some(v) => Some(v.parse().map_err(|_| "--tile-max is a number")?),
        None => None,
    };
    let s = flip_stats(&a, &b, &regions);
    println!("{}", s.mean);
    if tile_max.is_some() {
        println!("tile max {}", s.tile_max);
    }
    Ok(s.mean <= max && tile_max.is_none_or(|t| s.tile_max <= t))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("render") => render(&args).map(|()| true),
        Some("compare") => compare(&args),
        _ => Err("usage: dash-golden render … | dash-golden compare <a.png> <b.png> …".into()),
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("error[dash-golden] {e}");
            ExitCode::from(2)
        }
    }
}
