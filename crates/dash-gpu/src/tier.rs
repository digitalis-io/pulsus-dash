//! Backend tier selection (PRF-044) and the fallback ladder (T03 §9.2, T03-025).
//!
//! WebGPU is tried first when `navigator.gpu` exists, then WebGL2; with neither the page is
//! Static. A failure before the canvas holds a context falls through to the next tier in place;
//! after it, the canvas is committed, so the render worker restarts on a fresh canvas.

use dash_protocol::status::{RETRY_T2, RuntimeStatus};

/// A GPU backend tier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    WebGpu,
    WebGl2,
}

impl Tier {
    /// The status the page shows for this tier.
    pub fn status(self) -> RuntimeStatus {
        match self {
            Tier::WebGpu => RuntimeStatus::TierT1,
            Tier::WebGl2 => RuntimeStatus::TierT2,
        }
    }
}

/// `?mode=` override.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForcedMode {
    None,
    T2,
    Static,
}

/// Tiers to try, in order.
pub fn tier_plan(forced: ForcedMode, has_navigator_gpu: bool) -> Vec<Tier> {
    match (forced, has_navigator_gpu) {
        (ForcedMode::Static, _) => Vec::new(),
        (ForcedMode::T2, _) | (ForcedMode::None, false) => vec![Tier::WebGl2],
        (ForcedMode::None, true) => vec![Tier::WebGpu, Tier::WebGl2],
    }
}

/// First non-sRGB format, else `formats[0]`; `None` if empty. A linear format keeps the
/// token colours exact (they are written as-is).
pub fn choose_format(formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    formats
        .iter()
        .find(|f| !f.is_srgb())
        .or(formats.first())
        .copied()
}

/// Where a tier's initialisation failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InitStage {
    BeforeSurface,
    AfterSurface,
}

/// How initialisation ends when no tier succeeds in place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InitEnd {
    Restart(Tier),
    Static,
}

/// What to do after a tier failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fallback {
    TryNext(Tier),
    End(InitEnd),
}

/// `rest` = plan entries after the failed one. Before the surface → try the next tier on the
/// same canvas; after it → restart on a fresh canvas with the next tier; none left → Static.
pub fn after_failure(stage: InitStage, rest: &[Tier]) -> Fallback {
    match (stage, rest.first()) {
        (InitStage::BeforeSurface, Some(t)) => Fallback::TryNext(*t),
        (InitStage::AfterSurface, Some(t)) => Fallback::End(InitEnd::Restart(*t)),
        (_, None) => Fallback::End(InitEnd::Static),
    }
}

/// The `render_start` result code: the [`RuntimeStatus`] code, or `RETRY_T2` for a restart with
/// T2. A restart with WebGPU cannot happen (WebGPU is never after another tier) and is Failed.
pub fn start_code(r: Result<Tier, InitEnd>) -> u32 {
    match r {
        Ok(t) => t.status() as u32,
        Err(InitEnd::Restart(Tier::WebGl2)) => RETRY_T2,
        Err(InitEnd::Static) => RuntimeStatus::Static as u32,
        Err(InitEnd::Restart(Tier::WebGpu)) => RuntimeStatus::Failed as u32,
    }
}

/// Test fault injection; honoured only with feature `probe` of the core.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    WebGpuBeforeSurface,
    WebGpuAfterSurface,
}

#[cfg(test)]
mod tests {
    use super::*;
    use wgpu::TextureFormat as F;

    #[test]
    fn tier_plan_cases() {
        use Tier::*;
        assert_eq!(tier_plan(ForcedMode::None, true), vec![WebGpu, WebGl2]);
        assert_eq!(tier_plan(ForcedMode::None, false), vec![WebGl2]);
        assert_eq!(tier_plan(ForcedMode::T2, true), vec![WebGl2]);
        assert_eq!(tier_plan(ForcedMode::T2, false), vec![WebGl2]);
        assert_eq!(tier_plan(ForcedMode::Static, true), vec![]);
        assert_eq!(tier_plan(ForcedMode::Static, false), vec![]);
        assert_eq!(WebGpu.status(), RuntimeStatus::TierT1);
        assert_eq!(WebGl2.status(), RuntimeStatus::TierT2);
    }

    #[test]
    fn after_failure_and_start_code() {
        use InitStage::*;
        use Tier::*;
        assert_eq!(
            after_failure(BeforeSurface, &[WebGl2]),
            Fallback::TryNext(WebGl2)
        );
        assert_eq!(
            after_failure(AfterSurface, &[WebGl2]),
            Fallback::End(InitEnd::Restart(WebGl2))
        );
        assert_eq!(
            after_failure(BeforeSurface, &[]),
            Fallback::End(InitEnd::Static)
        );
        assert_eq!(
            after_failure(AfterSurface, &[]),
            Fallback::End(InitEnd::Static)
        );
        let codes: Vec<u32> = [
            Ok(WebGpu),
            Ok(WebGl2),
            Err(InitEnd::Restart(WebGl2)),
            Err(InitEnd::Static),
            Err(InitEnd::Restart(WebGpu)),
        ]
        .into_iter()
        .map(start_code)
        .collect();
        assert_eq!(codes, vec![1, 2, RETRY_T2, 3, 4]);
        assert_eq!(RETRY_T2, 256);
    }

    #[test]
    fn choose_format_prefers_linear() {
        assert_eq!(
            choose_format(&[F::Bgra8UnormSrgb, F::Bgra8Unorm]),
            Some(F::Bgra8Unorm)
        );
        assert_eq!(choose_format(&[F::Rgba8UnormSrgb]), Some(F::Rgba8UnormSrgb));
        assert_eq!(choose_format(&[]), None);
    }
}
