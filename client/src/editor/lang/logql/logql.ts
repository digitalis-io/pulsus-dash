/** LogQL as a `QueryLanguage` (plan #66 Part A §3.7). Stub: not implemented yet. */
import type { QueryLanguage } from '../types';

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export const logql: QueryLanguage = {
  lang: 'logql',
  editor: notImplemented,
  shape: notImplemented,
  diagnosticsOf: notImplemented,
  detect: notImplemented,
};
