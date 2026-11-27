//! `join_grid` (plan #68 D2 §3.2, ADR-0034): a streamed grid part's batch chunks joined into one
//! chunk, so a frame draws one chunk (T02-002). The series count is not known before the part is
//! streamed (T04-006), so the batches arrive as chunks of their own; the join is the one extra
//! exact-size copy ADR-0034 adds to T04-015, made on the pool. A single batch chunk is reused as
//! is.
#![deny(clippy::indexing_slicing)]

use crate::chunk::{Chunk, ChunkId, MAX_SAMPLES, TimeAxis};

/// Why the batch chunks of a grid part cannot be joined.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum JoinError {
    /// No batch chunk: the caller builds the empty chunk from the grid.
    #[error("no batch chunk")]
    Empty,
    /// The joined chunk's size overflows, or exceeds `MAX_SAMPLES`.
    #[error("joined size")]
    Size,
    /// The chunks are not of one grid, or a chunk's layout is inconsistent.
    #[error("chunk shape")]
    Shape,
}

/// The values of a joined chunk of `series` series of `len` points each: checked arithmetic, at
/// most `MAX_SAMPLES` (so every offset fits `u32`).
pub fn joined_size(series: usize, len: usize) -> Result<usize, JoinError> {
    series
        .checked_mul(len)
        .filter(|n| *n <= MAX_SAMPLES)
        .ok_or(JoinError::Size)
}

/// `c`'s layout matches its grid: `len` values per series, `series + 1` offsets, the validity
/// words of its values.
fn check_layout(c: &Chunk, len: u32) -> Result<(), JoinError> {
    let n = c.series.len();
    let values = joined_size(n, len as usize)?;
    if c.values.len() != values || c.offsets.len() != n + 1 {
        return Err(JoinError::Shape);
    }
    match &c.present {
        Some(p) if p.len() != values.div_ceil(64) => Err(JoinError::Shape),
        _ => Ok(()),
    }
}

/// Whether value `i` of `c` is present.
fn present(c: &Chunk, i: usize) -> bool {
    c.present
        .as_ref()
        .is_none_or(|w| w.get(i / 64).is_some_and(|w| w >> (i % 64) & 1 == 1))
}

/// The grid part's chunks in arrival order → one chunk with the same series order and grid. With
/// exactly one chunk it is reused as is (its id set to `id`, no copy). Otherwise the values and
/// validity are copied once into exact-size buffers, sized with checked arithmetic before anything
/// is allocated: an overflow, or more than `MAX_SAMPLES`, is `Size`.
pub fn join_grid(parts: Vec<Chunk>, id: ChunkId) -> Result<Chunk, JoinError> {
    let Some(first) = parts.first() else {
        return Err(JoinError::Empty);
    };
    let TimeAxis::Grid {
        start_ms,
        step_ms,
        len,
    } = first.time
    else {
        return Err(JoinError::Shape);
    };
    // Sizes first, from the counts alone: nothing is allocated for a size that fails.
    let mut series = 0usize;
    for c in &parts {
        let same = matches!(c.time, TimeAxis::Grid { start_ms: s, step_ms: t, len: l }
            if (s, t, l) == (start_ms, step_ms, len));
        if !same {
            return Err(JoinError::Shape);
        }
        series = series.checked_add(c.series.len()).ok_or(JoinError::Size)?;
    }
    let total = joined_size(series, len as usize)?;
    for c in &parts {
        check_layout(c, len)?;
    }
    let mut parts = parts;
    if parts.len() == 1 {
        let mut only = parts.pop().ok_or(JoinError::Empty)?;
        only.id = id;
        return Ok(only);
    }
    let any_absent = parts.iter().any(|c| c.present.is_some());
    let mut metas = Vec::with_capacity(series);
    let mut values = Vec::with_capacity(total);
    let mut words = if any_absent {
        vec![0u64; total.div_ceil(64)]
    } else {
        Vec::new()
    };
    let mut finite: Option<(f64, f64)> = None;
    for c in parts {
        let base = values.len();
        values.extend_from_slice(&c.values);
        if any_absent {
            for i in (0..c.values.len()).filter(|&i| present(&c, i)) {
                let at = base + i;
                if let Some(w) = words.get_mut(at / 64) {
                    *w |= 1 << (at % 64);
                }
            }
        }
        finite = match (finite, c.finite) {
            (None, f) | (f, None) => f,
            (Some((a, b)), Some((x, y))) => Some((a.min(x), b.max(y))),
        };
        metas.extend(c.series);
    }
    // total ≤ MAX_SAMPLES = 2³¹, so every offset fits u32.
    let offsets = (0..=series).map(|s| (s * len as usize) as u32).collect();
    Ok(Chunk {
        id,
        time: TimeAxis::Grid {
            start_ms,
            step_ms,
            len,
        },
        series: metas,
        offsets,
        values,
        present: any_absent.then_some(words),
        finite,
    })
}
