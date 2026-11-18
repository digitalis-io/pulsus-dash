//! Backend tier selection (PRF-044) and the fallback ladder (T03 §9.2, T03-025). Stub.

use dash_protocol::status::RuntimeStatus;

/// A GPU backend tier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    WebGpu,
    WebGl2,
}

impl Tier {
    pub fn status(self) -> RuntimeStatus {
        RuntimeStatus::Booting
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
pub fn tier_plan(_forced: ForcedMode, _has_navigator_gpu: bool) -> Vec<Tier> {
    Vec::new()
}

/// First non-sRGB format, else `formats[0]`; `None` if empty.
pub fn choose_format(_formats: &[wgpu::TextureFormat]) -> Option<wgpu::TextureFormat> {
    None
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

/// `rest` = plan entries after the failed one.
pub fn after_failure(_stage: InitStage, _rest: &[Tier]) -> Fallback {
    Fallback::End(InitEnd::Static)
}

/// The `render_start` result code of an initialisation outcome.
pub fn start_code(_r: Result<Tier, InitEnd>) -> u32 {
    0
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
    use dash_protocol::status::RETRY_T2;
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
