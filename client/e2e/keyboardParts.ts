/**
 * The parts of the `e2e:a11y-rooms` keyboard script (#130): five independent tests, each writing the
 * controls it collected and operated and the states it visited to one JSON file. The coverage rule
 * (IA-015) holds over the union of the five files (`scripts/keyboard-coverage.ts`), so a part can run
 * in any CI shard. No imports: the spec, the checker scripts and the reporter share it.
 */
export const KEYBOARD_PARTS = ['K1', 'K2', 'K3', 'K4', 'K5'] as const;
export type KeyboardPart = (typeof KEYBOARD_PARTS)[number];

/**
 * The parts in the single test's loop order (before #130 split it): L1–L22, L23–L24 b-1,
 * L24 b-3…L26, L27, L28–L33.
 */
export const SINGLE_TEST_ORDER: readonly KeyboardPart[] = ['K1', 'K3', 'K4', 'K2', 'K5'];

/** The tag every part carries; `@kbd-a` and `@kbd-b` pick the parts of the two keyboard shards. */
export const KEYBOARD_TAG = '@kbd';

/** `K3 board list…` → 'K3'; anything else → undefined. */
export function partOfTitle(title: string): KeyboardPart | undefined {
  const m = /^(K[1-5]) /.exec(title);
  return m === null ? undefined : (m[1] as KeyboardPart);
}

/** The states every full run must visit (the route patterns, `not-found` and `session-error`). */
export const REQUIRED_STATES: readonly string[] = [
  '/t/:tenant/boards',
  '/t/:tenant/board/:uid',
  '/t/:tenant/explore/metrics',
  '/t/:tenant/explore/logs',
  '/t/:tenant/admin',
  '/t/:tenant/dev/gallery',
  '/signed-out',
  'not-found',
  'session-error',
];

const BOARD = '/t/:tenant/board/:uid + none ›';
const onBoard = (k: string): string => `/t/:tenant/board/:uid + ${k}`;

/**
 * Keys a part's drains treat as done because an earlier part (`SINGLE_TEST_ORDER`) operates them,
 * as the single test's drains did. Never added to the part's `operated`; the coverage checker
 * fails a key no earlier part operated (`keyboard-skip-unbacked`) or the part did not collect
 * (`keyboard-skip-unused`).
 */
export const DRAIN_SKIP: Readonly<Record<KeyboardPart, readonly string[]>> = {
  K1: [],
  K3: [],
  // Operated by K3 (L24 b-1).
  K4: ['Request rate', 'Error ratio', 'Errors', 'Request latency'].map(
    (t) => `${BOARD} link "Open in Explore: ${t}"`,
  ),
  K2: [
    // Operated by K3 and K4.
    `${BOARD} button "Add panel"`,
    // Operated by K3 (L24 b-1).
    `${BOARD} button "Share"`,
    // Operated by K4 (L24 b-3).
    `${BOARD} button "Full screen: Edge p99"`,
    // The coverage-gap rule (#130 plan §3.1): every other key K2 operates that an earlier part
    // operates too, so K2's drains explore no more than L27's did in the single test.
    // Operated by K3.
    onBoard('none › button "Last" #2'),
    onBoard('none › button "Max" #2'),
    onBoard('none › button "Mean" #2'),
    onBoard('none › button "Series" #2'),
    // Operated by K3 and K4.
    onBoard('dialog "Discard unsaved changes?" › button "Discard changes"'),
    onBoard('dialog "Discard unsaved changes?" › button "Keep editing"'),
    onBoard('dialog "Edit panel" › button "Above the value Worse when"'),
    onBoard('dialog "Edit panel" › button "Add threshold"'),
    onBoard('dialog "Edit panel" › button "Degraded State"'),
    onBoard('dialog "Edit panel" › button "Done"'),
    onBoard('dialog "Edit panel" › button "Heatmap Visualisation"'),
    onBoard('dialog "Edit panel" › button "Legend table"'),
    onBoard('dialog "Edit panel" › button "Line Visualisation"'),
    onBoard('dialog "Edit panel" › button "LogQL Query language"'),
    onBoard('dialog "Edit panel" › button "Logs Visualisation"'),
    onBoard('dialog "Edit panel" › button "PromQL Query language"'),
    onBoard('dialog "Edit panel" › button "Remove panel"'),
    onBoard('dialog "Edit panel" › button "Remove threshold 1"'),
    onBoard('dialog "Edit panel" › button "Remove threshold 2"'),
    onBoard('dialog "Edit panel" › button "Run query"'),
    onBoard('dialog "Edit panel" › button "Stat Visualisation"'),
    onBoard('dialog "Edit panel" › button "Table Legend"'),
    onBoard('dialog "Edit panel" › button "Watch State"'),
    onBoard('dialog "Edit panel" › combobox "Metric"'),
    onBoard('dialog "Edit panel" › slider "Crosshair: Request rate"'),
    onBoard('dialog "Edit panel" › textbox "Label"'),
    onBoard('dialog "Edit panel" › textbox "Label" #2'),
    onBoard('dialog "Edit panel" › textbox "Query"'),
    onBoard('dialog "Edit panel" › textbox "Title"'),
    onBoard('dialog "Edit panel" › textbox "Value"'),
    onBoard('dialog "Edit panel" › textbox "Value" #2'),
    onBoard('dialog "Legend" › option "Table"'),
    onBoard('dialog "Query language" › option "LogQL"'),
    onBoard('dialog "Query language" › option "PromQL"'),
    onBoard('dialog "Visualisation" › option "Heatmap"'),
    onBoard('dialog "Visualisation" › option "Line"'),
    onBoard('dialog "Visualisation" › option "Logs"'),
    onBoard('dialog "Visualisation" › option "Stat"'),
    onBoard('dialog "Worse when" › option "Above the value"'),
    onBoard(
      'listbox "Suggestions" › option "http_request_duration_seconds_bucket histogram · HTTP request duration."',
    ),
    onBoard('menu "Panel menu: Errors" › menuitem "Edit panel"'),
    onBoard('menu "Panel menu: Request latency" › menuitem "Edit panel"'),
    onBoard('menu "Panel menu: Request rate" › menuitem "Edit panel"'),
    onBoard('none › button "Done"'),
    onBoard('none › button "Edit board"'),
    onBoard('none › button "Filter"'),
    onBoard('none › button "Panel menu: Errors"'),
    onBoard('none › button "Panel menu: Request latency"'),
    onBoard('none › button "Panel menu: Request rate"'),
    // Operated by K4.
    onBoard('dialog "Edit panel" › button "Auto Visualisation"'),
    onBoard('dialog "Variable env" › button "Apply"'),
    onBoard('dialog "Variable env" › button "Clear"'),
    onBoard('dialog "Variable env" › textbox "Value"'),
    onBoard('dialog "Variable region" › button "Apply"'),
    onBoard('dialog "Variable region" › button "Clear"'),
    onBoard('dialog "Variable region" › textbox "Value"'),
    onBoard('dialog "Visualisation" › option "Auto"'),
    onBoard('menu "Panel menu: Edge errors" › menuitem "Edit panel"'),
    onBoard('menu "Panel menu: Edge p99" › menuitem "Duplicate"'),
    onBoard('menu "Panel menu: Edge p99" › menuitem "Edit panel"'),
    onBoard('menu "Panel menu: Edge p99" › menuitem "Remove"'),
    onBoard('none › button "Add section"'),
    onBoard('none › button "Discard"'),
    onBoard('none › button "Full screen: Edge errors"'),
    onBoard('none › button "Full screen: Pods"'),
    onBoard('none › button "Last"'),
    onBoard('none › button "Max"'),
    onBoard('none › button "Mean"'),
    onBoard('none › button "Move or resize: Edge errors"'),
    onBoard('none › button "Move or resize: Pods"'),
    onBoard('none › button "Panel menu: Edge errors"'),
    onBoard('none › button "Panel menu: Edge p99"'),
    onBoard('none › button "Panel menu: Pods"'),
    onBoard('none › button "Save"'),
    onBoard('none › button "Series"'),
    onBoard('none › checkbox "Save current time range"'),
    onBoard('none › link "Open in Explore: Edge errors"'),
  ],
  K5: [
    // Operated by K3 and K4 (L25).
    `${BOARD} button "Share"`,
    // The coverage-gap rule (#130 plan §3.1), from a webkit run: every other key K5 operates that
    // an earlier part operates too, so K5's drains explore no more than L28–L33's did in the
    // single test.
    // Operated by K1 and K3.
    onBoard('none › link "Boards"'),
    onBoard('none › link "Open in Explore: Error ratio"'),
    onBoard('none › link "Open in Explore: Errors"'),
    onBoard('none › link "Open in Explore: Request rate"'),
    // Operated by K1 and K3 and K4.
    onBoard('none › link "Skip to main content"'),
    // Operated by K2.
    onBoard('dialog "Edit panel" › button "Bars Visualisation"'),
    onBoard('dialog "Visualisation" › option "Bars"'),
    onBoard('none › button "Variable env: prod"'),
    onBoard('none › link "Open in Explore: Pods"'),
    // Operated by K3.
    onBoard('dialog "Edit panel" › button "Degraded State" #2'),
    onBoard('none › link "Open in Explore: Request latency"'),
    // Operated by K3 and K4.
    onBoard('dialog "Add filter" › button "Add"'),
    onBoard('dialog "Add filter" › button "Cancel"'),
    onBoard('dialog "Add filter" › textbox "Label"'),
    onBoard('dialog "Add filter" › textbox "Value"'),
    onBoard('dialog "Discard unsaved changes?" › button "Discard changes"'),
    onBoard('dialog "Discard unsaved changes?" › button "Keep editing"'),
    onBoard('dialog "Edit panel" › button "Add threshold"'),
    onBoard('dialog "Edit panel" › button "Degraded State"'),
    onBoard('dialog "Edit panel" › button "Failing State"'),
    onBoard('dialog "Edit panel" › button "Remove threshold 1"'),
    onBoard('dialog "Edit panel" › button "Remove threshold 2"'),
    onBoard('dialog "Edit panel" › button "Watch State"'),
    onBoard('dialog "Edit panel" › button "stub_metric{series="0"} 85.4"'),
    onBoard('dialog "Edit panel" › button "stub_metric{series="1"} 114"'),
    onBoard('dialog "Edit panel" › button "stub_metric{series="2"} 93.3"'),
    onBoard('dialog "Edit panel" › slider "Crosshair: Request latency"'),
    onBoard('dialog "Edit panel" › slider "Crosshair: Request rate"'),
    onBoard('dialog "Edit panel" › textbox "Label"'),
    onBoard('dialog "Edit panel" › textbox "Label" #2'),
    onBoard('dialog "Edit panel" › textbox "Value"'),
    onBoard('dialog "Edit panel" › textbox "Value" #2'),
    onBoard('dialog "Error ratio" › button "Close"'),
    onBoard('dialog "Errors" › button "Close"'),
    onBoard('dialog "Request latency" › button "Close"'),
    onBoard('dialog "Request latency" › slider "Crosshair: Request latency"'),
    onBoard('dialog "Request rate" › button "Close"'),
    onBoard('dialog "Request rate" › button "Last"'),
    onBoard('dialog "Request rate" › button "Max"'),
    onBoard('dialog "Request rate" › button "Mean"'),
    onBoard('dialog "Request rate" › button "Series"'),
    onBoard('dialog "Request rate" › button "stub_metric{series="0"}"'),
    onBoard('dialog "Request rate" › button "stub_metric{series="1"}"'),
    onBoard('dialog "Request rate" › button "stub_metric{series="2"}"'),
    onBoard('dialog "Request rate" › slider "Crosshair: Request rate"'),
    onBoard('dialog "Share board" › button "Copy link"'),
    onBoard('dialog "Share board" › checkbox "Keep relative"'),
    onBoard('dialog "State" › option "Degraded"'),
    onBoard('dialog "State" › option "Failing"'),
    onBoard('dialog "State" › option "Watch"'),
    onBoard('menu "Panel menu: Error ratio" › menuitem "Copy query"'),
    onBoard('menu "Panel menu: Error ratio" › menuitem "Duplicate"'),
    onBoard('menu "Panel menu: Error ratio" › menuitem "Edit panel"'),
    onBoard('menu "Panel menu: Error ratio" › menuitem "Open in Explore"'),
    onBoard('menu "Panel menu: Error ratio" › menuitem "Remove"'),
    onBoard('menu "Panel menu: Errors" › menuitem "Copy query"'),
    onBoard('menu "Panel menu: Errors" › menuitem "Duplicate"'),
    onBoard('menu "Panel menu: Errors" › menuitem "Open in Explore"'),
    onBoard('menu "Panel menu: Errors" › menuitem "Remove"'),
    onBoard('menu "Panel menu: Request latency" › menuitem "Copy query"'),
    onBoard('menu "Panel menu: Request latency" › menuitem "Duplicate"'),
    onBoard('menu "Panel menu: Request latency" › menuitem "Open in Explore"'),
    onBoard('menu "Panel menu: Request latency" › menuitem "Remove"'),
    onBoard('menu "Panel menu: Request rate" › menuitem "Copy query"'),
    onBoard('menu "Panel menu: Request rate" › menuitem "Duplicate"'),
    onBoard('menu "Panel menu: Request rate" › menuitem "Open in Explore"'),
    onBoard('menu "Panel menu: Request rate" › menuitem "Remove"'),
    onBoard('none › button "Add panel"'),
    onBoard('none › button "Done"'),
    onBoard('none › button "Filter"'),
    onBoard('none › button "Full screen: Error ratio"'),
    onBoard('none › button "Full screen: Errors"'),
    onBoard('none › button "Full screen: Request latency"'),
    onBoard('none › button "Full screen: Request rate"'),
    onBoard('none › button "Last"'),
    onBoard('none › button "Latency"'),
    onBoard('none › button "Max"'),
    onBoard('none › button "Mean"'),
    onBoard('none › button "Panel menu: Error ratio"'),
    onBoard('none › button "Series"'),
    onBoard('none › button "stub_metric{series="0"}"'),
    onBoard('none › button "stub_metric{series="1"}"'),
    onBoard('none › button "stub_metric{series="2"}"'),
    onBoard('none › slider "Crosshair: Request rate"'),
    // Operated by K3 and K4 and K2.
    onBoard('dialog "Edit panel" › button "Above the value Worse when"'),
    onBoard('dialog "Edit panel" › button "Done"'),
    onBoard('dialog "Edit panel" › button "Heatmap Visualisation"'),
    onBoard('dialog "Edit panel" › button "Legend table"'),
    onBoard('dialog "Edit panel" › button "Line Visualisation"'),
    onBoard('dialog "Edit panel" › button "LogQL Query language"'),
    onBoard('dialog "Edit panel" › button "Logs Visualisation"'),
    onBoard('dialog "Edit panel" › button "PromQL Query language"'),
    onBoard('dialog "Edit panel" › button "Remove panel"'),
    onBoard('dialog "Edit panel" › button "Run query"'),
    onBoard('dialog "Edit panel" › button "Stat Visualisation"'),
    onBoard('dialog "Edit panel" › button "Table Legend"'),
    onBoard('dialog "Edit panel" › combobox "Metric"'),
    onBoard('dialog "Edit panel" › textbox "Query"'),
    onBoard('dialog "Edit panel" › textbox "Title"'),
    onBoard('dialog "Legend" › option "Table"'),
    onBoard('dialog "Query language" › option "LogQL"'),
    onBoard('dialog "Query language" › option "PromQL"'),
    onBoard('dialog "Visualisation" › option "Heatmap"'),
    onBoard('dialog "Visualisation" › option "Line"'),
    onBoard('dialog "Visualisation" › option "Logs"'),
    onBoard('dialog "Visualisation" › option "Stat"'),
    onBoard('dialog "Worse when" › option "Above the value"'),
    onBoard('listbox "Suggestions" › combobox "Metric"'),
    onBoard(
      'listbox "Suggestions" › option "http_request_duration_seconds_bucket histogram · HTTP request duration."',
    ),
    onBoard('menu "Panel menu: Errors" › menuitem "Edit panel"'),
    onBoard('menu "Panel menu: Request latency" › menuitem "Edit panel"'),
    onBoard('menu "Panel menu: Request rate" › menuitem "Edit panel"'),
    onBoard('none › button "Edit board"'),
    onBoard('none › button "Panel menu: Errors"'),
    onBoard('none › button "Panel menu: Request latency"'),
    onBoard('none › button "Panel menu: Request rate"'),
    // Operated by K4.
    onBoard('dialog "Edge errors" › button "Close"'),
    onBoard('dialog "Edge p99" › button "Close"'),
    onBoard('dialog "Pods" › button "Close"'),
    onBoard('dialog "Variable env" › button "Apply"'),
    onBoard('dialog "Variable env" › textbox "Value"'),
    onBoard('dialog "Variable region" › button "Apply"'),
    onBoard('dialog "Variable region" › button "Clear"'),
    onBoard('dialog "Variable region" › textbox "Value"'),
    onBoard('menu "Panel menu: Edge errors" › menuitem "Copy query"'),
    onBoard('menu "Panel menu: Edge errors" › menuitem "Duplicate"'),
    onBoard('menu "Panel menu: Edge errors" › menuitem "Open in Explore"'),
    onBoard('menu "Panel menu: Edge errors" › menuitem "Remove"'),
    onBoard('menu "Panel menu: Edge p99" › menuitem "Copy query"'),
    onBoard('menu "Panel menu: Pods" › menuitem "Copy query"'),
    onBoard('menu "Panel menu: Pods" › menuitem "Duplicate"'),
    onBoard('menu "Panel menu: Pods" › menuitem "Edit panel"'),
    onBoard('menu "Panel menu: Pods" › menuitem "Remove"'),
    onBoard('none › button "Add panel to Latency"'),
    onBoard('none › button "Add section"'),
    onBoard('none › button "Discard"'),
    onBoard('none › button "Full screen: Edge errors"'),
    onBoard('none › button "Full screen: Edge p99"'),
    onBoard('none › button "Full screen: Pods"'),
    onBoard('none › button "Move or resize: Error ratio"'),
    onBoard('none › button "Move or resize: Errors"'),
    onBoard('none › button "Move or resize: Request latency"'),
    onBoard('none › button "Move or resize: Request rate"'),
    onBoard('none › button "Panel menu: Pods"'),
    onBoard('none › button "Remove section Latency"'),
    onBoard('none › button "Save"'),
    onBoard('none › button "Variable env: not set"'),
    onBoard('none › button "Variable region: not set"'),
    onBoard('none › checkbox "Save current time range"'),
    onBoard('none › link "Open in Explore: Edge errors"'),
    onBoard('none › slider "Crosshair: Request latency"'),
    onBoard('none › textbox "Section 1 title"'),
    // Operated by K4 and K2.
    onBoard('dialog "Edit panel" › button "Auto Visualisation"'),
    onBoard('dialog "Visualisation" › option "Auto"'),
    onBoard('menu "Panel menu: Edge errors" › menuitem "Edit panel"'),
    onBoard('menu "Panel menu: Edge p99" › menuitem "Duplicate"'),
    onBoard('menu "Panel menu: Edge p99" › menuitem "Edit panel"'),
    onBoard('menu "Panel menu: Edge p99" › menuitem "Remove"'),
    onBoard('none › button "Panel menu: Edge errors"'),
    onBoard('none › button "Panel menu: Edge p99"'),
  ],
};

/** `keys` of `state` whose `${state} › ${k}` is neither in `operated` nor in `done`, in order. */
export function drainPending(
  keys: readonly string[],
  state: string,
  operated: ReadonlySet<string>,
  done: ReadonlySet<string>,
): string[] {
  return keys.filter((k) => {
    const key = `${state} › ${k}`;
    return !operated.has(key) && !done.has(key);
  });
}

/** Under the project's outputDir (test-results/), which Playwright empties at run start. */
export const COVERAGE_DIR = 'keyboard-coverage';

export const coverageFileName = (project: string, part: KeyboardPart): string =>
  `${project}-${part}.json`;

/** One part's file. Every list is sorted; keys are `state › role "name"`. */
export interface PartCoverage {
  version: 1;
  project: string;
  part: KeyboardPart;
  collected: string[];
  operated: string[];
  /** Route states. */
  visited: string[];
}
