/**
 * The StubApi planner mirror's shape (plan #112 §3.7, §4.3, A.9): the Lezer shape of the query
 * when the stub type check (the upstream parser's type rules, mirrored on the Lezer tree) passes,
 * else the unknown shape, in UTF-8 byte offsets. Loaded lazily by `StubApi`.
 */
import type { ByteShape } from './plan';

export function stubShape(_text: string): ByteShape {
  throw new Error('not implemented');
}
