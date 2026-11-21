/** Board URL parameters (plan #61 Part C §3.6). Stub. */
import type { ContextSearch, SearchParamPair } from './contextSearch';

export const VAR_PREFIX = 'var-';
export const FILTER_PARAM = 'f';
export const COLLAPSE_PARAM = 'collapse';
export const EXPAND_PARAM = 'expand';
export const MAX_FILTERS = 20;
export const MAX_PARAM_VALUE = 200;
export const MAX_REQUEST_TARGET = 4096;
export const SHARE_RESERVE = 96;
export const FILTER_LABEL = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/;
export const SECTION_ID = /^[a-z0-9-]{1,40}$/;

export interface BoardFilter {
  readonly key: string;
  readonly value: string;
}
export interface SectionOverrides {
  readonly collapse: ReadonlySet<string>;
  readonly expand: ReadonlySet<string>;
}
export interface BoardParams {
  readonly vars: ReadonlyMap<string, string>;
  readonly filters: readonly BoardFilter[];
  readonly sections: SectionOverrides;
}
export type ParamError =
  | 'filter.keyInvalid'
  | 'filter.valueRequired'
  | 'filter.valueTooLong'
  | 'filter.tooMany'
  | 'url.tooLong';

export function readBoardParams(rest: readonly SearchParamPair[]): BoardParams {
  rest;
  return { vars: new Map(), filters: [], sections: { collapse: new Set(), expand: new Set() } };
}

export function withVar(
  rest: readonly SearchParamPair[],
  name: string,
  value: string | null,
): SearchParamPair[] {
  name;
  value;
  return [...rest];
}

export function withFilter(
  rest: readonly SearchParamPair[],
  key: string,
  value: string | null,
): SearchParamPair[] {
  key;
  value;
  return [...rest];
}

export function withSectionOverride(
  rest: readonly SearchParamPair[],
  id: string,
  collapsed: boolean | null,
  sectionIds: readonly string[],
): SearchParamPair[] {
  id;
  collapsed;
  sectionIds;
  return [...rest];
}

export function withoutSectionOverrides(rest: readonly SearchParamPair[]): SearchParamPair[] {
  return [...rest];
}

export function checkFilterKey(key: string): ParamError | null {
  key;
  return null;
}

export function checkParamValue(value: string): ParamError | null {
  value;
  return null;
}

export function requestTargetBytes(pathname: string, search: string): number {
  pathname;
  search;
  return 0;
}

export function overrideReserve(sectionIds: readonly string[]): number {
  sectionIds;
  return 0;
}

export function fitsUrlBudget(
  pathname: string,
  context: ContextSearch,
  rest: readonly SearchParamPair[],
  sectionIds: readonly string[],
): boolean {
  pathname;
  context;
  rest;
  sectionIds;
  return true;
}
