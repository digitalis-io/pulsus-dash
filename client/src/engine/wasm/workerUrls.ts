/** The engine worker scripts (plan #68 C1 §3.5): the only URLs the `pulsus-engine` policy admits. */
export { default as RENDER_URL } from './render.worker.ts?worker&url';
export { default as POOL_URL } from './pool.worker.ts?worker&url';
