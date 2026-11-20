import { useMatches, useParams } from 'react-router';

/** The deepest matched route id and the tenant slug of the current shell page. */
export function useShellRoute(): {
  routeId: string | undefined;
  tenant: string;
  uid: string | undefined;
} {
  const matches = useMatches();
  const params = useParams();
  return { routeId: matches.at(-1)?.id, tenant: params['tenant'] ?? '', uid: params['uid'] };
}
