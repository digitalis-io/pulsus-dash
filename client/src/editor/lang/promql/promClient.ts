import type { EditorState } from '@codemirror/state';
import type { CompleteStrategy, PrometheusClient } from '@prometheus-io/codemirror-promql';
import type { PromSource } from '../types';

export interface RawMatcher {
  readonly type: number;
  readonly name: string;
  readonly value: string;
  readonly nameText: string;
  readonly valueText: string;
}
export interface MatcherContext {
  readonly matchers: readonly RawMatcher[];
  readonly edited: number;
}
export const NO_MATCHERS: MatcherContext = { matchers: [], edited: -1 };
const ni = (): never => {
  throw new Error('not implemented');
};
export function matcherContextAt(_state: EditorState, _pos: number): MatcherContext {
  return ni();
}
export function selectorOf(
  _metric: string | undefined,
  _matchers: readonly RawMatcher[],
  _edited: number,
): string | null {
  return ni();
}
export function decodeLabelName(_nameText: string): string | null {
  return ni();
}
export function toPrometheusClient(_source: PromSource, _ctx: MatcherContext): PrometheusClient {
  return ni();
}
export function promqlCompleteStrategy(_source: PromSource): CompleteStrategy {
  return ni();
}
