/**
 * A rayon pool worker (plan #68 C1 §3.3, T03 §4.2): instantiates the engine on the render
 * worker's shared memory and runs one pool thread for good (`pool_run` parks in `Atomics.wait`
 * between jobs, which a worker may do).
 */
import init, { pool_run } from 'virtual:dash-engine';
import type { PoolMessage } from './protocol';

interface Scope {
  addEventListener(type: 'message', cb: (e: MessageEvent<PoolMessage>) => void): void;
}

(self as unknown as Scope).addEventListener('message', (e) => {
  const m = e.data;
  void init({ module_or_path: m.module, memory: m.memory }).then(() => {
    pool_run(m.ptr);
  });
});
