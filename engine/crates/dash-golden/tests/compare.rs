//! unit:compare-tile-max (plan #68 C1 §2, T05-005): `dash-golden compare --tile-max V` fails when
//! any 8×8 tile's mean ꟻLIP exceeds V, so a small local defect cannot hide under the image mean.
use std::path::{Path, PathBuf};
use std::process::Command;

use dash_golden::Image;
use dash_golden::flip::flip_stats;

fn white() -> Image {
    Image {
        w: 256,
        h: 256,
        rgba: vec![255; 256 * 256 * 4],
    }
}

/// White with the 8×8 tile at (64, 64) black.
fn with_black_tile() -> Image {
    let mut img = white();
    for y in 64..72 {
        for x in 64..72 {
            let i = (y * 256 + x) * 4;
            img.rgba[i..i + 3].copy_from_slice(&[0, 0, 0]);
        }
    }
    img
}

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("compare-tile-max");
    assert!(std::fs::create_dir_all(&dir).is_ok());
    dir.join(name)
}

fn compare(a: &Path, b: &Path, flags: &[&str]) -> i32 {
    let out = Command::new(env!("CARGO_BIN_EXE_dash-golden"))
        .arg("compare")
        .arg(a)
        .arg(b)
        .args(flags)
        .output();
    let Ok(out) = out else {
        panic!("run dash-golden")
    };
    out.status.code().unwrap_or(-1)
}

#[test]
fn one_dark_tile_passes_the_mean_and_fails_the_tile_max() {
    let (a, b) = (white(), with_black_tile());
    let s = flip_stats(&a, &b, &[]);
    assert!(s.tile_max >= 0.9, "tile max {}", s.tile_max);
    assert!(s.mean < 0.005, "mean {}", s.mean);
    let (pa, pb) = (scratch("white.png"), scratch("tile.png"));
    assert!(a.write_png(&pa).is_ok() && b.write_png(&pb).is_ok());
    assert_eq!(compare(&pa, &pb, &["--max", "0.005"]), 0);
    assert_eq!(
        compare(&pa, &pb, &["--max", "0.005", "--tile-max", "0.25"]),
        1
    );
    assert_eq!(
        compare(&pa, &pa, &["--max", "0.005", "--tile-max", "0.25"]),
        0
    );
    let same = flip_stats(&a, &a, &[]);
    assert_eq!((same.mean, same.tile_max), (0.0, 0.0));
}
