import type { StubSeed } from '../api/StubApi';
import { defaultSeed } from '../api/stubData';
import type { Role } from '../api/types';

/** The default seed with some fields replaced (deep copies). */
export function seedWith(
  o: { tenants?: string[]; role?: Role; boards?: StubSeed['boards'] } = {},
): StubSeed {
  const s = structuredClone(defaultSeed);
  if (o.tenants !== undefined)
    s.session.tenants = s.session.tenants.filter((t) => o.tenants?.includes(t.slug));
  if (o.role !== undefined) s.session.user.role = o.role;
  if (o.boards !== undefined) s.boards = o.boards;
  return s;
}
