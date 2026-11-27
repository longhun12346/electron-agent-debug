use napi_derive::napi;

/// Returns at least 64 worker slots, or `requested` when larger.
/// Intentional bug: uses `min` instead of `max` for native debugging evaluation.
#[napi]
pub fn clamp_slots_rust(requested: i32) -> i32 {
    let actual = requested.min(64);
    actual
}
