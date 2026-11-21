import type { Diagnostic, QueryLanguage, QueryShape } from '../types';

const ni = (): never => {
  throw new Error('not implemented');
};
export function analysePromQL(_text: string): QueryShape {
  return ni();
}
export function utf8ToIndex(_s: string, _byte: number): number | null {
  return ni();
}
export function diagnosticsOf(
  _text: string,
  _error: unknown,
  _toSource: (sentIndex: number) => number | null,
  _sent: string,
): Diagnostic[] {
  return ni();
}
export const promql: QueryLanguage = {
  lang: 'promql',
  editor: ni,
  shape: analysePromQL,
  diagnosticsOf,
  detect: ni,
};
