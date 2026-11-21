//! Series colour assignment and colour roles (T02-004, T02-005, VL-002). A series' colour is a
//! function of its own labels and key: the Table 8-1a level colour for a log-level series, else
//! `key_hash mod 8` (the client's `canvas2d/palette.ts`). Specs can name only `SeriesColour` and
//! `GuideColour`; state colours are not reachable from here.

/// Labels that carry a log level, in precedence order.
pub const LEVEL_LABELS: [&str; 2] = ["level", "detected_level"];

/// Table 8-1a: lower-case level value → series colour index (0 = series-1).
pub fn level_colour(value_lower: &str) -> Option<u8> {
    match value_lower {
        "error" | "err" | "critical" | "crit" | "fatal" | "alert" | "emergency" => Some(5),
        "warn" | "warning" => Some(1),
        "info" | "informational" | "notice" => Some(0),
        "debug" => Some(4),
        "trace" => Some(3),
        _ => None,
    }
}

/// 0..7: the level row's index for a log-level series, else key_hash mod 8 (low 3 bits).
///
/// As `palette.ts`: the first level label present decides; an unknown level value falls back to
/// the key (the TS loop `break`s). `palette.ts` takes the last hex digit of the 16-digit key and
/// masks it with 7, which is `key_hash & 7`.
pub fn series_colour_index(key_hash: u64, labels: &[(String, String)]) -> u8 {
    for label in LEVEL_LABELS {
        if let Some((_, v)) = labels.iter().find(|(k, _)| k == label) {
            if let Some(i) = level_colour(&v.to_lowercase()) {
                return i;
            }
            break;
        }
    }
    (key_hash & 7) as u8
}

/// A series colour slot (0–7); only made from a series' identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeriesColour(u8);

impl SeriesColour {
    pub fn of(key_hash: u64, labels: &[(String, String)]) -> Self {
        Self(series_colour_index(key_hash, labels))
    }

    pub fn index(self) -> u8 {
        self.0
    }
}

/// Guide colours; `Grid` maps to the `hairline` token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuideColour {
    Grid,
}
