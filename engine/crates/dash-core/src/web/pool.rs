//! The rayon pool on pool workers (plan #68 C1 §3.3, §4.1; T03 §4.2): `pool_start` installs the
//! global pool with a spawn handler that hands each thread's `ThreadBuilder` to the main thread
//! as a pointer (`spawn(ptr)` → `spawn-pool{ptr}`); the main thread starts a pool worker on the
//! same module and memory, which calls `pool_run(ptr)` and runs that thread for good.

use wasm_bindgen::prelude::*;

/// Installs the global pool of `threads` threads (once per page).
#[wasm_bindgen]
pub fn pool_start(threads: u32, spawn: &js_sys::Function) -> Result<(), JsError> {
    let spawn = spawn.clone();
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads.max(1) as usize)
        .spawn_handler(move |thread| {
            let ptr = Box::into_raw(Box::new(thread)) as usize as u32;
            spawn
                .call1(&JsValue::NULL, &JsValue::from(ptr))
                .map(|_| ())
                .map_err(|_| std::io::Error::other("spawn-pool"))
        })
        .build_global()
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Runs the pool thread `ptr` (from `pool_start`) on this pool worker; returns only when the
/// pool ends.
#[wasm_bindgen]
pub fn pool_run(ptr: u32) {
    // SAFETY: `ptr` came from `Box::into_raw` in `pool_start`'s spawn handler, which gives each
    // `ThreadBuilder` to exactly one pool worker (`spawn-pool{ptr}` → `pool{ptr}`), so it is
    // valid, of this type, and taken back here exactly once.
    let thread = unsafe { Box::from_raw(ptr as usize as *mut rayon::ThreadBuilder) };
    thread.run();
}
