/**
 * The engine worker scripts (plan #68 C1 §3.5; plan #68 C2d2, ADR-0033): the only URLs the
 * `pulsus-engine` policy admits: the render and pool workers and the ST render worker.
 */
export { default as RENDER_URL } from './render.worker.ts?worker&url';
export { default as POOL_URL } from './pool.worker.ts?worker&url';
export { default as RENDER_ST_URL } from './render-st.worker.ts?worker&url';
