/**
 * `bench:inp-rooms`, board room (plan #61 Part C §5.3, Appendix C-A §A.6; #90 document 4; #93
 * document 5; PRF-033, T05 §4.3).
 * Scripted pointer and keyboard interactions on the board page; INP per document from the Event
 * Timing entries of every document the script loads. Report only on CI's shared runners (T05-006,
 * D-INP-interim); `INP_GATE=enforce` (the reference lab, and the D13 local proofs) fails any
 * document whose INP is above 200 ms.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { aggregateInp, gateFailures, type InpEntry, type InpStep } from '../scripts/inp.ts';
import { boardEditorScenario, EDITOR_SCENARIO_N } from './boardEditorScenario.ts';
import { CHART_SCENARIO_N, chartGestureScenario } from './chartGestureScenario.ts';

const LIMIT_MS = 200;
const TARGET_MS = 100;
/** Clicks and key presses the script performs in each document (the table below). */
const PLANNED_N: Readonly<Record<number, number>> = {
  // 5 toggle pairs (10) + 3 star pairs (6).
  1: 16,
  // 3 × (open 1 + type "eu" 2 + Apply 1) + 3 × (Filter 1 + label 2 + Value field 1 + "v" 1 + Add 1
  // + open chip 1 + Remove 1).
  2: 36,
  // 3 × (Edit 1 + Add section 1 + Done 1 + Discard changes 1).
  3: 12,
  // The panel editor dialog (#90): Edit board, then 3 × (open, title, language, query,
  // visualisation, Done).
  4: EDITOR_SCENARIO_N,
  // Chart gestures on a board panel (#93): wheel, pinch, value zoom, reset, pan, box, double-click.
  5: CHART_SCENARIO_N,
};

interface InpWindow {
  __inp?: { ready: boolean };
  __inpStep: (label: string, count: number) => void;
  __inpFlush: () => Promise<{
    entries: Omit<InpEntry, 'doc'>[];
    steps: Omit<InpStep, 'doc'>[];
  }>;
}

/** Installed in every document the page loads. */
function collect(): void {
  const inp = {
    ready: true,
    entries: [] as { interactionId: number; startTime: number; duration: number }[],
    steps: [] as { label: string; count: number; t: number }[],
  };
  const keep = (l: PerformanceEntryList): void => {
    for (const e of l as PerformanceEventTiming[])
      if (e.interactionId > 0)
        inp.entries.push({
          interactionId: e.interactionId,
          startTime: e.startTime,
          duration: e.duration,
        });
  };
  const obs = new PerformanceObserver((list) => {
    keep(list.getEntries());
  });
  // `durationThreshold` (Event Timing) is not in TypeScript's DOM types yet.
  obs.observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  Object.assign(window, {
    __inp: inp,
    __inpStep: (label: string, count: number) =>
      inp.steps.push({ label, count, t: performance.now() }),
    /** Two frames and 100 ms, then the observer's queued records; returns and clears them. */
    __inpFlush: async () => {
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100))),
      );
      keep(obs.takeRecords());
      return { entries: inp.entries.splice(0), steps: inp.steps.splice(0) };
    },
  });
}

test.describe('bench:inp-rooms', () => {
  test('bench:inp-rooms board room (report only unless INP_GATE=enforce)', async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    const enforce = process.env['INP_GATE'] === 'enforce';
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.addInitScript(collect);

    const entries: InpEntry[] = [];
    const steps: InpStep[] = [];
    const urls: Record<number, string> = {};
    let doc = 0;

    const flush = async (): Promise<void> => {
      const out = await page.evaluate(() => (window as unknown as InpWindow).__inpFlush());
      for (const e of out.entries) entries.push({ doc, ...e });
      for (const s of out.steps) steps.push({ doc, ...s });
    };
    const open = async (url: string): Promise<void> => {
      if (doc > 0) await flush();
      await page.goto(url);
      doc += 1;
      urls[doc] = url;
      expect(await page.evaluate(() => (window as unknown as InpWindow).__inp?.ready)).toBe(true);
      await page.locator('html[data-shell-ready="true"]').waitFor();
    };
    const step = async (label: string, count: number, act: () => Promise<void>): Promise<void> => {
      await page.evaluate(
        ([l, c]) => {
          (window as unknown as InpWindow).__inpStep(l, c);
        },
        [label, count] as const,
      );
      await act();
    };
    const click = (p: Page, name: string, exact = true) =>
      p.getByRole('button', { name, exact }).click();

    // Document 1: the section toggle and the star.
    await open('/t/demo/board/b-1');
    // Request rate and Error ratio: Request latency, below the fold, does not query (T07-012).
    await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(2);
    const latency = page.getByRole('button', { name: 'Latency', exact: true });
    await step('b-1 section toggle', 10, async () => {
      for (let i = 0; i < 5; i++) {
        await latency.click();
        await expect(latency).toHaveAttribute('aria-expanded', 'false');
        await latency.click();
        await expect(latency).toHaveAttribute('aria-expanded', 'true');
      }
    });
    const star = page.getByRole('button', { name: 'Star board' });
    await expect(star).toBeEnabled();
    const pressed = await star.getAttribute('aria-pressed');
    await step('b-1 star', 6, async () => {
      for (let i = 0; i < 6; i++) {
        await star.click();
        await expect(star).toHaveAttribute(
          'aria-pressed',
          (i % 2 === 0) === (pressed === 'false') ? 'true' : 'false',
        );
      }
    });

    // Document 2: the variable chip and the filter dialog.
    await open('/t/demo/board/b-3');
    for (let i = 0; i < 3; i++) {
      await step('b-3 variable open', 1, async () => {
        await page.getByRole('button', { name: /^Variable region: / }).click();
        await page.getByRole('dialog', { name: 'Variable region' }).waitFor();
      });
      await step('b-3 variable type', 2, () => page.keyboard.type('eu'));
      await step('b-3 variable apply', 1, async () => {
        await click(page, 'Apply');
        await expect(page.getByRole('dialog', { name: 'Variable region' })).toBeHidden();
      });
    }
    for (let i = 0; i < 3; i++) {
      const key = `k${String(i)}`;
      await step('b-3 filter add', 6, async () => {
        await click(page, 'Filter');
        const d = page.getByRole('dialog', { name: 'Add filter' });
        await expect(d.getByRole('textbox', { name: 'Label' })).toBeFocused();
        await page.keyboard.type(key);
        await d.getByRole('textbox', { name: 'Value' }).click();
        await page.keyboard.type('v');
        await d.getByRole('button', { name: 'Add' }).click();
        await expect(d).toBeHidden();
      });
      await step('b-3 filter remove', 2, async () => {
        await click(page, `Filter ${key}: v`);
        const d = page.getByRole('dialog', { name: `Filter ${key}` });
        await d.getByRole('button', { name: 'Remove filter' }).click();
        await expect(d).toBeHidden();
      });
    }

    // Document 3: Edit, Add section, Done.
    await open('/t/demo/board/b-1');
    for (let i = 0; i < 3; i++) {
      await step('b-1 edit', 1, async () => {
        await click(page, 'Edit board');
        await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
        if (i === 0) await expect(page.locator('.react-grid-item')).toHaveCount(4);
      });
      await step('b-1 add section', 1, () => click(page, 'Add section'));
      await step('b-1 done', 2, async () => {
        await click(page, 'Done');
        await page
          .getByRole('dialog', { name: 'Discard unsaved changes?' })
          .getByRole('button', { name: 'Discard changes' })
          .click();
        await expect(page.getByRole('button', { name: 'Edit board' })).toBeVisible();
      });
    }

    // Document 4: the panel editor dialog (#90, plan Appendix B §B.5).
    await open('/t/demo/board/b-1');
    // Request rate and Error ratio: Request latency, below the fold, does not query (T07-012).
    await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(2);
    await boardEditorScenario(page, step);

    // Document 5: chart gestures on the Request rate panel (#93, plan Appendix A §A.3).
    await open('/t/demo/board/b-1');
    // Request rate and Error ratio: Request latency, below the fold, does not query (T07-012).
    await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(2);
    await chartGestureScenario(page, step);
    await flush();

    const r = aggregateInp(entries, steps);
    expect(r.documents).toHaveLength(5);
    for (const d of r.documents) expect(d.n, `document ${String(d.doc)}`).toBe(PLANNED_N[d.doc]);
    expect(pageErrors).toEqual([]);

    const result = {
      documents: r.documents.map((d) => ({ ...d, url: urls[d.doc] ?? '' })),
      worst: r.worst,
      mode: enforce ? 'enforce' : 'report',
      limitMs: LIMIT_MS,
      targetMs: TARGET_MS,
      unit: 'ms',
    };
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/bench-inp-rooms.json', `${JSON.stringify(result, null, 2)}\n`);
    info.annotations.push({ type: 'bench:inp-rooms', description: JSON.stringify(result) });

    const failing = gateFailures(r, LIMIT_MS);
    if (enforce) {
      expect(
        failing,
        failing
          .map(
            (d) =>
              `document ${String(d.doc)}: INP ${String(d.inp)} ms, slowest ${d.slowest?.label ?? 'none'}`,
          )
          .join('; '),
      ).toEqual([]);
    } else {
      for (const d of failing) {
        info.annotations.push({
          type: 'warning',
          description: `INP ${String(d.inp)} ms > ${String(LIMIT_MS)} ms in document ${String(d.doc)} (report only until the reference lab, T05-006)`,
        });
      }
    }
  });
});
