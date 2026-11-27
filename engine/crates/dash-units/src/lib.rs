//! Units and number formatting (VL-012, T08-027): the image of the client's
//! `client/src/i18n/format.ts` `Unit` and `formatValue`, byte for byte (plan #68 A.5).

/// The unit of a chart value; the same JSON as the TS `Unit` (T22-016, #290 §3.4): absent fields
/// take their defaults, and defaults are not written.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Unit {
    /// An SI-prefixed number.
    None,
    /// A number with no prefix.
    Plain,
    Suffix {
        suffix: String,
    },
    /// IEC (`prefix` absent or `iec`) or SI bytes; `/s` on every scale when per second.
    Bytes {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix: Option<Prefix>,
        #[serde(rename = "perSecond", default, skip_serializing_if = "is_false")]
        per_second: bool,
    },
    /// SI or IEC bits; `/s` on every scale when per second.
    Bits {
        prefix: Prefix,
        #[serde(rename = "perSecond", default, skip_serializing_if = "is_false")]
        per_second: bool,
    },
    Percent,
    Percentunit,
    Time {
        base: TimeBase,
    },
}

/// The scale family of bytes and bits: powers of 1024 (`iec`) or of 1000 (`si`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Prefix {
    Iec,
    Si,
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde's skip_serializing_if signature"
)]
fn is_false(b: &bool) -> bool {
    !*b
}

impl Unit {
    /// IEC bytes, not per second: the TS `{ kind: 'bytes' }`.
    pub fn bytes() -> Self {
        Self::Bytes {
            prefix: None,
            per_second: false,
        }
    }

    /// Whether the unit's scales are powers of 1024: IEC bytes (the default) and IEC bits.
    fn iec(&self) -> bool {
        match self {
            Self::Bytes { prefix, .. } => *prefix != Some(Prefix::Si),
            Self::Bits { prefix, .. } => *prefix == Prefix::Iec,
            _ => false,
        }
    }
}

/// The base of the unit's value ticks, as the TS `tickBase`: 1024 for IEC bytes and bits, else
/// 1000.
pub fn tick_base(unit: &Unit) -> u32 {
    if unit.iec() { 1024 } else { 1000 }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeBase {
    Ns,
    Us,
    Ms,
    S,
}

/// The decimal digits and exponent of finite `x > 0` rounded to `p` significant digits, ties
/// away from zero (ECMA-262 Number::toPrecision: "pick the larger n"). The exact digits come from
/// a 40-digit expansion, which is exact for every tie an f64 can hold.
fn digits_half_up(x: f64, p: usize) -> (Vec<u8>, i32) {
    let s = format!("{x:.39e}");
    let (mant, exp) = s.split_once('e').unwrap_or((&s, "0"));
    let mut e: i32 = exp.parse().unwrap_or(0);
    let all: Vec<u8> = mant
        .bytes()
        .filter(u8::is_ascii_digit)
        .map(|b| b - b'0')
        .collect();
    let mut d: Vec<u8> = all[..p].to_vec();
    if all.get(p).is_some_and(|r| *r >= 5) {
        let mut i = p;
        loop {
            if i == 0 {
                d.insert(0, 1);
                d.truncate(p);
                e += 1;
                break;
            }
            i -= 1;
            if d[i] == 9 {
                d[i] = 0;
            } else {
                d[i] += 1;
                break;
            }
        }
    }
    (d, e)
}

fn text(d: &[u8]) -> String {
    d.iter().map(|b| char::from(b'0' + b)).collect()
}

/// ECMAScript `x.toPrecision(p)` for 1 ≤ p ≤ 21.
pub fn to_precision(x: f64, p: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return if p == 1 {
            "0".into()
        } else {
            format!("0.{}", "0".repeat(p - 1))
        };
    }
    if x < 0.0 {
        return format!("-{}", to_precision(-x, p));
    }
    if x.is_infinite() {
        return "Infinity".into();
    }
    let (d, e) = digits_half_up(x, p);
    let m = text(&d);
    let p_i = p as i32;
    if e < -6 || e >= p_i {
        let sign = if e < 0 { '-' } else { '+' };
        let head = if p == 1 {
            m
        } else {
            format!("{}.{}", &m[..1], &m[1..])
        };
        return format!("{head}e{sign}{}", e.abs());
    }
    if e == p_i - 1 {
        return m;
    }
    if e >= 0 {
        let k = e as usize + 1;
        return format!("{}.{}", &m[..k], &m[k..]);
    }
    format!("0.{}{m}", "0".repeat((-(e + 1)) as usize))
}

/// ECMAScript `String(x)` (Number::toString): the shortest round-trip digits.
pub fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x < 0.0 {
        return format!("-{}", js_number_to_string(-x));
    }
    if x.is_infinite() {
        return "Infinity".into();
    }
    let s = format!("{x:e}");
    let (mant, exp) = s.split_once('e').unwrap_or((&s, "0"));
    let digits: String = mant.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        return format!("{digits}{}", "0".repeat((n - k) as usize));
    }
    if 0 < n && n <= 21 {
        return format!("{}.{}", &digits[..n as usize], &digits[n as usize..]);
    }
    if -6 < n && n <= 0 {
        return format!("0.{}{digits}", "0".repeat((-n) as usize));
    }
    let e = n - 1;
    let sign = if e < 0 { '-' } else { '+' };
    let head = if k == 1 {
        digits
    } else {
        format!("{}.{}", &digits[..1], &digits[1..])
    };
    format!("{head}e{sign}{}", e.abs())
}

/// ECMAScript `Math.round`: half toward +∞.
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// ECMAScript `Number(s)` for the strings `sig` produces.
fn js_number(s: &str) -> f64 {
    s.parse().unwrap_or(f64::NAN)
}

/// `to_precision(x, 3)` with the mantissa's trailing zeros dropped.
fn precision3(x: f64) -> String {
    let p = to_precision(x, 3);
    let (mantissa, exponent) = match p.split_once('e') {
        Some((m, e)) => (m, Some(e)),
        None => (p.as_str(), None),
    };
    let m = if mantissa.contains('.') {
        mantissa.trim_end_matches('0').trim_end_matches('.')
    } else {
        mantissa
    };
    match exponent {
        None => m.to_owned(),
        Some(e) => format!("{m}e{e}"),
    }
}

/// Three significant digits, or the rounded integer from 100; trailing zeros dropped.
fn sig(x: f64) -> String {
    if x.abs() >= 100.0 {
        return js_number_to_string(js_round(x));
    }
    precision3(x)
}

struct Scale {
    size: f64,
    text: &'static str,
}

/// The largest scale not above `abs`, carried to the next one while the digits reach its size.
fn scaled(abs: f64, scales: &[Scale], space: &str) -> String {
    let mut i = 0;
    while i + 1 < scales.len() && abs >= scales[i + 1].size {
        i += 1;
    }
    loop {
        let s = &scales[i];
        let digits = sig(abs / s.size);
        if let Some(next) = scales.get(i + 1)
            && js_number(&digits).abs() >= js_round(next.size / s.size)
        {
            i += 1;
            continue;
        }
        return if s.text.is_empty() {
            digits
        } else {
            format!("{digits}{space}{}", s.text)
        };
    }
}

const SI: [Scale; 6] = [
    Scale {
        size: 1.0,
        text: "",
    },
    Scale {
        size: 1e3,
        text: "k",
    },
    Scale {
        size: 1e6,
        text: "M",
    },
    Scale {
        size: 1e9,
        text: "G",
    },
    Scale {
        size: 1e12,
        text: "T",
    },
    Scale {
        size: 1e15,
        text: "P",
    },
];

/// A data unit's scale texts at powers of 1000 or 1024 (TS `IEC_BYTES`, `SI_BYTES`, `SI_BITS`,
/// `IEC_BITS`).
const IEC_BYTES: [&str; 6] = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
const SI_BYTES: [&str; 6] = ["B", "kB", "MB", "GB", "TB", "PB"];
const SI_BITS: [&str; 6] = ["b", "kb", "Mb", "Gb", "Tb", "Pb"];
const IEC_BITS: [&str; 6] = ["b", "Kib", "Mib", "Gib", "Tib", "Pib"];
const POW1000: [f64; 6] = [1.0, 1e3, 1e6, 1e9, 1e12, 1e15];
const POW1024: [f64; 6] = [
    1.0,
    1024.0,
    1_048_576.0,
    1_073_741_824.0,
    1_099_511_627_776.0,
    1_125_899_906_842_624.0,
];

/// `scaled` over a data unit's scales, each text followed by `tail` (`/s` or ''): the TS
/// `scaled(abs, dataScales(unit), ' ', 3)`.
fn scaled_data(abs: f64, texts: &[&str; 6], sizes: &[f64; 6], tail: &str) -> String {
    let mut i = 0;
    while i + 1 < sizes.len() && abs >= sizes[i + 1] {
        i += 1;
    }
    loop {
        let digits = sig(abs / sizes[i]);
        if let Some(next) = sizes.get(i + 1)
            && js_number(&digits).abs() >= js_round(next / sizes[i])
        {
            i += 1;
            continue;
        }
        return format!("{digits} {}{tail}", texts[i]);
    }
}

const TIME: [Scale; 7] = [
    Scale {
        size: 1e-9,
        text: "ns",
    },
    Scale {
        size: 1e-6,
        text: "µs",
    },
    Scale {
        size: 1e-3,
        text: "ms",
    },
    Scale {
        size: 1.0,
        text: "s",
    },
    Scale {
        size: 60.0,
        text: "min",
    },
    Scale {
        size: 3_600.0,
        text: "h",
    },
    Scale {
        size: 86_400.0,
        text: "d",
    },
];

impl TimeBase {
    fn seconds(self) -> f64 {
        match self {
            Self::Ns => 1e-9,
            Self::Us => 1e-6,
            Self::Ms => 1e-3,
            Self::S => 1.0,
        }
    }
}

impl Unit {
    /// The value converted to the base unit: ×100 for percentunit, seconds for time.
    fn base_value(&self, v: f64) -> f64 {
        match self {
            Self::Percentunit => v * 100.0,
            Self::Time { base } => v * base.seconds(),
            _ => v,
        }
    }

    /// The tail of the out-of-range form: the unit of the converted value.
    fn base_tail(&self) -> String {
        match self {
            Self::None | Self::Plain => String::new(),
            Self::Suffix { suffix } => format!(" {suffix}"),
            Self::Bytes { .. } | Self::Bits { .. } => format!(" {}", self.data_base()),
            Self::Percent | Self::Percentunit => " %".into(),
            Self::Time { .. } => " s".into(),
        }
    }

    /// `/s` for a per-second data unit, else ''.
    fn per_second_tail(&self) -> &'static str {
        match self {
            Self::Bytes {
                per_second: true, ..
            }
            | Self::Bits {
                per_second: true, ..
            } => "/s",
            _ => "",
        }
    }

    /// A data unit's base symbol and its per-second tail: `B`, `B/s`, `b`, `b/s` (TS `dataBase`).
    fn data_base(&self) -> String {
        let symbol = if matches!(self, Self::Bits { .. }) {
            "b"
        } else {
            "B"
        };
        format!("{symbol}{}", self.per_second_tail())
    }
}

/// A chart value in its unit (VL-012, T08-027, T21-013), byte-identical to TS `formatValue` at its
/// default three digits: a converted value c ≥ 1e21 or 0 < c < 1e−12 is `toPrecision(3)` in
/// exponent form plus the base tail (`1e+21`, `1e-13 s`, `1e+22 B`).
pub fn format_value(v: f64, unit: &Unit) -> String {
    if v.is_nan() {
        return "—".into();
    }
    if v == f64::INFINITY {
        return "+Inf".into();
    }
    if v == f64::NEG_INFINITY {
        return "-Inf".into();
    }
    if v < 0.0 {
        return format!("-{}", format_value(-v, unit));
    }
    let c = unit.base_value(v);
    if c != 0.0 && !(1e-12..1e21).contains(&c) {
        return format!("{}{}", precision3(c), unit.base_tail());
    }
    let si = |v: f64| if v < 1.0 { sig(v) } else { scaled(v, &SI, "") };
    match unit {
        Unit::None => si(v),
        Unit::Plain => sig(v),
        Unit::Suffix { suffix } => format!("{} {suffix}", si(v)),
        Unit::Bytes { .. } | Unit::Bits { .. } => {
            if v < 1.0 {
                return format!("{} {}", sig(v), unit.data_base());
            }
            let bits = matches!(unit, Unit::Bits { .. });
            let texts = match (bits, unit.iec()) {
                (false, true) => &IEC_BYTES,
                (false, false) => &SI_BYTES,
                (true, false) => &SI_BITS,
                (true, true) => &IEC_BITS,
            };
            let sizes = if unit.iec() { &POW1024 } else { &POW1000 };
            scaled_data(v, texts, sizes, unit.per_second_tail())
        }
        Unit::Percent => format!("{} %", sig(v)),
        Unit::Percentunit => format!("{} %", sig(v * 100.0)),
        Unit::Time { base } => {
            let seconds = v * base.seconds();
            if seconds == 0.0 {
                "0 s".into()
            } else {
                scaled(seconds, &TIME, " ")
            }
        }
    }
}

/// The SI prefixes of the TS `formatCompact`, by power of 1000 from 10⁻¹² to 10¹⁸.
const COMPACT_PREFIXES: [&str; 11] = ["p", "n", "µ", "m", "", "k", "M", "G", "T", "P", "E"];

/// Port of format.ts `compactSamples`: the widest compact label of each SI prefix in `unit`
/// (`-88.8<prefix><tail>`), whose measured width is the narrowest value band (T02-011, #93).
pub fn compact_samples(unit: &Unit) -> Vec<String> {
    let tail = match unit {
        Unit::None | Unit::Plain => String::new(),
        Unit::Suffix { suffix } => format!(" {suffix}"),
        Unit::Percent | Unit::Percentunit => " %".to_owned(),
        Unit::Bytes { .. } | Unit::Bits { .. } => format!(" {}", unit.data_base()),
        Unit::Time { .. } => " s".to_owned(),
    };
    COMPACT_PREFIXES
        .iter()
        .map(|p| format!("-88.8{p}{tail}"))
        .collect()
}
