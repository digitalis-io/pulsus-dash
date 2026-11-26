//! unit:engine-recovery-policy (plan #68 C1 §4.3, review r1 #2, #3): device loss while idle,
//! repeated loss within 60 s, a failed restore and a restore on another tier.
use dash_core::recovery::{LossAction, LossPolicy, Restored, restore_events, restored};
use dash_gpu::Tier;
use serde_json::{Value, json};

fn parse(events: &[String]) -> Vec<Value> {
    events
        .iter()
        .map(|e| serde_json::from_str(e).unwrap_or(Value::Null))
        .collect()
}

#[test]
fn a_second_loss_within_60_s_is_fatal() {
    let mut p = LossPolicy::default();
    assert_eq!(p.on_lost(1_000.0), LossAction::Restore);
    assert_eq!(p.on_lost(60_999.0), LossAction::Fatal);
    let mut q = LossPolicy::default();
    assert_eq!(q.on_lost(1_000.0), LossAction::Restore);
    assert_eq!(
        q.on_lost(61_000.0),
        LossAction::Restore,
        "60 s later is a first loss again"
    );
}

#[test]
fn a_failed_restore_is_fatal() {
    assert_eq!(restored(Tier::T1, None), Restored::Failed);
    assert_eq!(
        parse(&restore_events(&[1, 2], Restored::Failed)),
        [json!({"t": "fatal", "reason": "device-lost"})]
    );
}

#[test]
fn the_same_tier_redraws_in_place() {
    assert_eq!(restored(Tier::T2, Some(Tier::T2)), Restored::Same);
    assert!(restore_events(&[1, 2], Restored::Same).is_empty());
}

#[test]
fn a_t1_loss_with_only_t2_left_moves_the_frames_to_canvas_2d() {
    let r = restored(Tier::T1, Some(Tier::T2));
    assert_eq!(r, Restored::TierChanged(Tier::T2));
    assert_eq!(
        parse(&restore_events(&[3, 5], r)),
        [
            json!({"t": "tier", "tier": "t2"}),
            json!({"t": "failed", "id": 3, "reason": "tier"}),
            json!({"t": "failed", "id": 5, "reason": "tier"}),
        ]
    );
}
