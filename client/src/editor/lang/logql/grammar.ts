/**
 * The static LogQL word lists (plan #66 Part A, Appendix A.1): highlighting (`extensions.ts`) and
 * the local completion slot (`complete.ts`) read them; `advance` reads `GROUP_WORDS`.
 */

const frozen = (words: readonly string[]): readonly string[] => Object.freeze([...words]);

/** Range and vector aggregations: highlighted `function`, completed in a function context. */
export const FUNCTIONS: readonly string[] = frozen([
  'count_over_time',
  'rate',
  'rate_counter',
  'bytes_over_time',
  'bytes_rate',
  'avg_over_time',
  'sum_over_time',
  'min_over_time',
  'max_over_time',
  'stdvar_over_time',
  'stddev_over_time',
  'quantile_over_time',
  'first_over_time',
  'last_over_time',
  'absent_over_time',
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'stddev',
  'stdvar',
  'topk',
  'bottomk',
  'sort',
  'sort_desc',
  'label_replace',
  'vector',
]);

/** `unwrap` conversions: highlighted `function`, not completed. */
export const CONVERSIONS: readonly string[] = frozen([
  'bytes',
  'duration',
  'duration_seconds',
  'ip',
]);

/** Highlighted `keyword`. */
export const KEYWORDS: readonly string[] = frozen([
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'bool',
  'offset',
  'and',
  'or',
  'unless',
]);

/** Pipeline stages: highlighted `keyword`, completed in a stage context. */
export const STAGES: readonly string[] = frozen([
  'json',
  'logfmt',
  'pattern',
  'regexp',
  'unpack',
  'line_format',
  'label_format',
  'decolorize',
  'drop',
  'keep',
  'unwrap',
]);

/** A `(` after one of these opens a grouping frame. */
export const GROUP_WORDS: readonly string[] = frozen([
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
]);
