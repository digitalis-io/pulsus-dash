/**
 * The log stream harness (development and stub builds only; plan #66 Part B, B.2): `LogStream`
 * over the synthetic log API, prefilled to a configured size, for `e2e:log-stream` and
 * `bench:log-scroll`. A test sets `window.__logStreamBenchConfig` before the page loads; the page
 * exposes `window.__logStreamBench` (this module only).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { t } from '../i18n/t';
import { MAX_ENTRIES } from '../logs/logBuffer';
import { LogPager, PAGE_LIMIT, type EndStatus } from '../logs/logPager';
import { LogStream, type LogStreamHandle, type ResliceCause } from '../logs/LogStream';
import { DEFAULT_VIEW, type ViewLimits } from '../logs/slice';
import { usePageTitle } from '../shell/PageTitle';
import { useShellRoute } from '../shell/useShellRoute';
import { createSynthLogApi, type SynthLogApi } from './logSynth';
import styles from './LogStreamBenchPage.module.css';

/** Set by a test with `page.addInitScript` before the page loads; absent → BENCH_CONFIG. */
interface LogStreamBenchConfig {
  readonly total: number;
  readonly prefillTo: number;
  readonly capEntries: number;
  readonly latencyMs: number;
  readonly view?: ViewLimits;
  readonly wrap?: boolean;
  readonly lineLength?: number;
  readonly wrapEstimate?: 'bound' | 'row';
}

type Counts = Record<ResliceCause, number>;

interface TopRow {
  readonly ord: number;
  readonly top: number;
}

interface ResliceRecord {
  readonly cause: ResliceCause;
  readonly scrolling: boolean;
  readonly before: TopRow | null;
}

declare global {
  interface Window {
    __logStreamBenchConfig?: Partial<LogStreamBenchConfig>;
    __logStreamBench?: {
      scrollToOrd(ord: number): void;
      loadTail(): Promise<void>;
      state(): {
        firstOrd: number;
        endOrd: number;
        held: number;
        tail: EndStatus;
        calls: number;
        writes: number;
        reslices: Counts;
        reslicesScrolling: Counts;
      };
      /** The ordinal and the top offset (px, relative to the scroller) of the first row whose
       *  top is at or below the scroller's top. */
      topRow(): TopRow | null;
      /** Every re-slice that wrote, with `topRow()` when it was decided. */
      reslicesLog(): ResliceRecord[];
      /** `performance.now()` of each `scrollTop` write `LogStream` made. */
      writesAt(): number[];
      /** Swaps the stream for the control scroller `[data-log-control]` and back (B.3 phase 2). */
      showControl(on: boolean): void;
    };
  }
}

const BENCH_CONFIG: LogStreamBenchConfig = {
  total: 2_000_000,
  prefillTo: 1_000_000,
  capEntries: MAX_ENTRIES,
  latencyMs: 50,
};
const QUERY = '{service_name="synth"}';
const FROM_MS = 1767225600000;
const TO_MS = 1767312000000;

/** The control scroller's 2 × 10⁶ px of empty height (B.3 phase 2), through CSSOM. */
const CONTROL_PX = 2_000_000;
const controlHeight = (el: HTMLDivElement | null): void => {
  if (el !== null) el.style.height = `${String(CONTROL_PX)}px`;
};

const zero = (): Counts => ({ edge: 0, extent: 0, hard: 0, wrap: 0, scrollTo: 0 });

function topRow(): TopRow | null {
  const scroller = document.querySelector('[data-log-scroller]');
  if (scroller === null) return null;
  const top = scroller.getBoundingClientRect().top;
  let best: TopRow | null = null;
  for (const el of scroller.querySelectorAll<HTMLElement>('[data-ord]')) {
    const y = el.getBoundingClientRect().top - top;
    if (y >= -0.5 && (best === null || y < best.top))
      best = { ord: Number(el.dataset['ord']), top: y };
  }
  return best;
}

interface Run {
  readonly pager: LogPager;
  readonly synth: SynthLogApi;
}

export function LogStreamBenchPage(): JSX.Element {
  usePageTitle(t('logStreamBench.title'));
  const { tenant } = useShellRoute();
  const [config] = useState<LogStreamBenchConfig>(() => ({
    ...BENCH_CONFIG,
    ...window.__logStreamBenchConfig,
  }));
  const [direction, setDirection] = useState<'backward' | 'forward'>('backward');
  const [runId, setRunId] = useState(0);
  const [wrap, setWrap] = useState(config.wrap ?? false);
  const [run, setRun] = useState<Run | null>(null);
  const [prefilled, setPrefilled] = useState(false);
  const [control, setControl] = useState(false);
  const stream = useRef<LogStreamHandle>(null);
  const counters = useRef({
    writes: 0,
    writesAt: [] as number[],
    reslices: zero(),
    reslicesScrolling: zero(),
    log: [] as ResliceRecord[],
  });

  useEffect(() => {
    const synth = createSynthLogApi({
      total: config.total,
      lineLength: config.lineLength ?? 100,
      latencyMs: 0,
    });
    const pager = new LogPager(
      synth,
      { tenant, query: QUERY, fromMs: FROM_MS, toMs: TO_MS, widthPx: 1000, direction },
      { entries: config.capEntries },
    );
    const live = { on: true };
    const isLive = (): boolean => live.on;
    void (async () => {
      // Published after a microtask: the effect only starts the run.
      await Promise.resolve();
      if (!isLive()) return;
      setRun({ pager, synth });
      setPrefilled(false);
      await pager.start();
      const going = (): boolean => {
        const s = pager.getState();
        return (
          isLive() &&
          pager.buffer.length + PAGE_LIMIT <= config.prefillTo &&
          !s.atEnd &&
          s.tail.status !== 'error' &&
          s.tail.status !== 'drift'
        );
      };
      while (going()) await pager.loadTail();
      if (!isLive()) return;
      synth.latencyMs = config.latencyMs;
      setPrefilled(true);
    })();
    return () => {
      live.on = false;
      pager.dispose();
    };
  }, [config, direction, runId, tenant]);

  useEffect(() => {
    if (run === null) return undefined;
    const c = counters.current;
    window.__logStreamBench = {
      scrollToOrd: (ord) => {
        stream.current?.scrollToOrd(ord);
      },
      loadTail: () => run.pager.loadTail(),
      state: () => {
        const s = run.pager.getState();
        return {
          firstOrd: s.firstOrd,
          endOrd: s.endOrd,
          held: run.pager.buffer.length,
          tail: s.tail.status,
          calls: run.synth.calls.length,
          writes: c.writes,
          reslices: { ...c.reslices },
          reslicesScrolling: { ...c.reslicesScrolling },
        };
      },
      topRow,
      reslicesLog: () => [...c.log],
      writesAt: () => [...c.writesAt],
      showControl: setControl,
    };
    return () => {
      delete window.__logStreamBench;
    };
  }, [run]);

  return (
    <div className={styles['page']} data-prefilled={prefilled ? 'true' : 'false'}>
      {control ? (
        // A static scroller of the stream's size: the browser's floor for the same gesture.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region is a tab stop
        <div className={styles['control']} data-log-control="" tabIndex={0}>
          <div ref={controlHeight} />
        </div>
      ) : run === null || !prefilled ? null : (
        <LogStream
          ref={stream}
          pager={run.pager}
          label={t('logStreamBench.list')}
          wrap={wrap}
          onWrapChange={setWrap}
          onDirectionChange={setDirection}
          onRerun={() => {
            setRunId((n) => n + 1);
          }}
          view={config.view ?? DEFAULT_VIEW}
          wrapEstimate={config.wrapEstimate ?? 'bound'}
          onScrollWrite={() => {
            counters.current.writes += 1;
            counters.current.writesAt.push(performance.now());
          }}
          onReslice={(cause, scrolling) => {
            const c = counters.current;
            c.reslices[cause] += 1;
            if (scrolling) c.reslicesScrolling[cause] += 1;
            c.log.push({ cause, scrolling, before: topRow() });
          }}
        />
      )}
    </div>
  );
}
