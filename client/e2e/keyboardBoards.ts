/**
 * Keyboard loops L23–L31 (plan #61 Part B, Appendix B-A §A.5; Part C, Appendix C-A §A.3): the board list and its dialogs, the
 * board in View and Edit mode, the panel tools, Share, the layout buttons, the panel editor dialog
 * and its selects, the guard and the conflict dialog. Each loop asserts its behaviours, then drains its
 * states. Run inside the one keyboard test, so the final coverage check covers them.
 */
import { expect, test } from '@playwright/test';
import { enc, ORIGIN } from './helpers.ts';
import type { Script } from './keyboardScript.ts';

const EDGE = 'Edge gateway, eu-west-1: p99 latency by pod and region after the last deploy';
const B1_PANELS = ['Request rate', 'Error ratio', 'Errors', 'Request latency'];
const B3_PANELS = ['Edge p99', 'Edge errors', 'Pods'];

export async function boardLoops(s: Script): Promise<void> {
  const { page, h } = s;
  const { press, type } = h;
  // Plan #61 Part B, Appendix B-A §A.5: the board list, the board in View and Edit, and their
  // overlays. Each loop asserts its behaviours, then the drains operate whatever is left.
  const backToList = async (): Promise<void> => {
    await s.on('link "Boards"');
    await expect.poll(() => s.path()).toBe('/t/demo/boards');
  };
  const table = page.getByRole('table', { name: 'All boards' });
  const rowTitles = async (): Promise<string[]> =>
    (await table.getByRole('rowgroup').last().getByRole('row').all()).length === 0
      ? []
      : table.getByRole('rowgroup').last().getByRole('link').allTextContents();
  const status = page.getByRole('status', { name: 'Save status' });
  const panelCount = page.locator('[data-panel]');
  // The panel editor dialog (#90): a modal; Escape closes it.
  const editor = page.getByRole('dialog', { name: 'Edit panel' });
  const closeEditor = async (): Promise<void> => {
    await press('Escape');
    await expect(editor).toBeHidden();
  };
  const gridOf = (title: string) =>
    page
      .locator('[data-panel]')
      .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) })
      .getAttribute('data-grid');

  await test.step('L23 Board list', async () => {
    await s.goto('/t/demo/boards');
    let before = await s.linkKeys();
    await s.on('button "New board"');
    const nb = page.getByRole('dialog', { name: 'New board' });
    await expect(nb).toBeVisible();
    await s.replaceText('textbox "Name"', 'Keyboard board');
    await s.on('button "Create"');
    await expect.poll(() => s.path()).toBe('/t/demo/board/b-4');
    await s.ready();
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await s.on('button "Done"');
    await s.shellAfter(before, async () => {
      await expect.poll(() => s.path()).toBe('/t/demo/board/b-4');
    });
    before = await s.linkKeys();
    await backToList();
    await s.shellAfter(before, backToList);
    await s.on('button "New board"');
    await expect(nb).toBeVisible();
    await s.on('button "Cancel"');
    await expect(nb).toBeHidden();

    const rename = page.getByRole('dialog', { name: 'Rename board' });
    const del = page.getByRole('dialog', { name: 'Delete board?' });
    // On a board page reached from a renamed link: the renamed Starred and Recent links are new
    // keys on the board route too; operate each (each opens a board), then back to the list.
    const renamedOnBoard = async (): Promise<void> => {
      for (let guard = 0; guard < 20; guard++) {
        const key = (await s.linkKeys()).find((k) => /^link ".* 2"(?: #\d+)?$/.test(k));
        if (key === undefined) break;
        const state = await h.state();
        await s.on(key);
        expect([...h.operated()]).toContain(`${state} › ${key}`);
        await s.ready();
      }
      if (s.path() !== '/t/demo/boards') await backToList();
    };
    for (const title of await rowTitles()) {
      // The Delete item of the menu under the title it has before the rename.
      await s.menuItem(`button "Actions for ${title}"`, 1);
      await expect(del).toBeVisible();
      await s.on('button "Cancel"');
      await expect(del).toBeHidden();
      before = await s.linkKeys();
      await s.menuItem(`button "Actions for ${title}"`, 0);
      await expect(rename).toBeVisible();
      await s.focus('textbox "Name"');
      await press('End');
      await type(' 2');
      await s.on('button "Save"');
      await expect(rename).toBeHidden();
      await expect.poll(rowTitles).toContain(`${title} 2`);
      await s.shellAfter(before, renamedOnBoard);
      await s.menuItem(`button "Actions for ${title} 2"`, 0);
      await expect(rename).toBeVisible();
      await s.on('button "Cancel"');
      await s.menuItem(`button "Actions for ${title} 2"`, 1);
      await expect(del).toBeVisible();
      await s.on('button "Cancel"');
      await expect(del).toBeHidden();
    }
    for (const title of await rowTitles()) {
      await s.menuItem(`button "Actions for ${title}"`, 1);
      await s.on('button "Delete"');
      await expect.poll(rowTitles).not.toContain(title);
    }
    await expect(page.getByText('No boards yet')).toBeVisible();

    await s.drain('list', () => s.goto('/t/demo/boards'));
    await s.drain('New board', async () => {
      await s.goto('/t/demo/boards');
      await s.on('button "New board"');
    });
    for (const title of ['Service overview', 'Checkout latency', EDGE]) {
      for (const [i, name] of [
        [0, 'Rename'],
        [1, 'Delete'],
      ] as const) {
        await s.drain(`${name} ${title}`, async () => {
          await s.goto('/t/demo/boards');
          await s.menuItem(`button "Actions for ${title}"`, i);
        });
      }
      await s.drain(`Actions ${title}`, async () => {
        await s.goto('/t/demo/boards');
        await s.on(`button "Actions for ${title}"`);
      });
    }
  });

  await test.step('L24 View tools', async () => {
    for (const [uid, titles] of [
      ['b-1', B1_PANELS],
      ['b-3', B3_PANELS],
    ] as const) {
      const url = `/t/demo/board/${uid}`;
      await s.goto(url);
      await s.shellAfter(await s.linkKeys(), () => s.goto(url));
      for (const title of titles) {
        await s.goto(url);
        await s.on(`link "Open in Explore: ${title}"`);
        await expect.poll(() => s.path()).toMatch(/^\/t\/demo\/explore\/(metrics|logs)$/);
        expect(s.search()['q']).toBeTruthy();
        await s.goto(url);
        const full = page.getByRole('button', { name: `Full screen: ${title}` });
        await s.on(`button "Full screen: ${title}"`);
        const d = page.getByRole('dialog', { name: title });
        await expect(d).toBeVisible();
        if ((await d.getByRole('slider').count()) > 0) {
          await s.focus(`slider "Crosshair: ${title}"`);
          await press('End');
          await press('Escape');
        }
        await s.on('button "Close"');
        await expect(d).toBeHidden();
        await expect(full).toBeFocused();
        await s.menuItem(`button "Panel menu: ${title}"`, 1);
        await expect.poll(() => page.evaluate(() => window.__copied.at(-1) ?? '')).not.toBe('');
        await s.menuItem(`button "Panel menu: ${title}"`, 0);
        await expect(editor).toBeVisible();
        // The preview's crosshair (#90), named after the panel: End sets it, Escape clears it.
        await editor.locator('[data-preview-host] > *').first().waitFor();
        if ((await editor.getByRole('slider').count()) > 0) {
          await s.focus(`slider "Crosshair: ${title}"`);
          await press('End');
          await press('Escape');
          await expect(editor).toBeVisible();
        }
        await closeEditor();
        await expect(page.getByRole('button', { name: `Panel menu: ${title}` })).toBeFocused();
      }
      // #90: Add panel opens the modal editor, which a drain replays from its entry state. The View
      // drain starts in View, so Edit board and Add panel are operated here, from Edit: the View
      // drain then stays in View, and the Edit drains of L26 (entered in Edit) take the rest.
      await s.goto(url);
      await s.on('button "Edit board"');
      await s.on('button "Add panel"');
      await closeEditor();
      await s.drain(`${uid} view`, () => s.goto(url));
      for (const title of titles) {
        await s.drain(`${uid} full screen ${title}`, async () => {
          await s.goto(url);
          await s.on(`button "Full screen: ${title}"`);
        });
        await s.drain(`${uid} panel menu ${title}`, async () => {
          await s.goto(url);
          await s.on(`button "Panel menu: ${title}"`);
        });
      }
    }
    await s.goto('/t/demo/board/b-2');
    await s.shellAfter(await s.linkKeys(), () => s.goto('/t/demo/board/b-2'));
    await s.drain('b-2 view', () => s.goto('/t/demo/board/b-2'));
  });

  await test.step('L25 Toolbar', async () => {
    const url = '/t/demo/board/b-1?from=now-1h&to=now&refresh=off';
    await s.goto(url);
    await s.on('button "Share"');
    const share = page.getByRole('dialog', { name: 'Share board' });
    await expect(share).toBeVisible();
    await s.on('checkbox "Keep relative"', 'Space');
    await s.on('checkbox "Keep relative"', 'Space');
    await s.on('button "Copy link"');
    const copied = await page.evaluate(() => window.__copied.at(-1) ?? '');
    expect(copied).toContain(`${ORIGIN}/t/demo/board/b-1?from=${enc('2026-11-19T12:03:00.000Z')}`);
    await press('Escape');
    await expect(share).toBeHidden();
    await s.on('button "Edit board"');
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await press('Shift+E');
    await expect(page.getByRole('button', { name: 'Edit board' })).toBeVisible();
    await press('Shift+E');
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await s.drain('share', async () => {
      await s.goto(url);
      await s.on('button "Share"');
    });
  });

  await test.step('L26 Edit layout', async () => {
    const url = '/t/demo/board/b-3';
    await s.goto(url);
    await s.on('button "Edit board"');
    await s.focus('button "Move or resize: Pods"', { max: 160 });
    for (let i = 0; i < 6; i++) await press('ArrowRight');
    for (let i = 0; i < 2; i++) await press('Shift+ArrowDown');
    expect(await gridOf('Pods')).toBe('6,8,6,10');
    await s.on('button "Add panel"');
    await expect(editor).toBeVisible();
    await closeEditor();
    await expect(page.getByRole('button', { name: 'Panel menu: Untitled panel' })).toBeFocused();
    await expect(panelCount).toHaveCount(4);
    for (const title of ['Edge p99', 'Edge errors', 'Untitled panel']) {
      await s.focus(`button "Move or resize: ${title}"`, { max: 160 });
      for (const key of [
        'ArrowRight',
        'ArrowLeft',
        'ArrowDown',
        'ArrowUp',
        'Shift+ArrowRight',
        'Shift+ArrowLeft',
        'Shift+ArrowDown',
        'Shift+ArrowUp',
      ]) {
        await press(key);
      }
    }
    await s.on('checkbox "Save current time range"', 'Space');
    await press('Space');
    await press('ControlOrMeta+S');
    await expect(status).toHaveText('Saved');
    await s.on('button "Add panel"');
    await closeEditor();
    await s.focus('button "Save"', { max: 160 });
    const state = await h.state();
    await press('Enter');
    await expect(status).toHaveText('Saved');
    expect([...h.operated()]).toContain(`${state} › button "Save"`);
    expect(state).toBe('/t/:tenant/board/:uid + none');
    await s.on('button "Add panel"');
    await closeEditor();
    await s.on('button "Discard"');
    await expect(page.getByRole('button', { name: 'Edit board' })).toBeVisible();
    await expect(panelCount).toHaveCount(5);
    await s.on('button "Edit board"');
    await s.on('button "Done"');
    await expect(page.getByRole('button', { name: 'Edit board' })).toBeVisible();

    for (const uid of ['b-1', 'b-2', 'b-3']) {
      const u = `/t/demo/board/${uid}`;
      const edit = async (): Promise<void> => {
        await s.goto(u);
        await s.on('button "Edit board"');
      };
      await s.drain(`${uid} edit`, edit);
      // The dialog's controls.
      await s.drain(`${uid} edit, added`, async () => {
        await edit();
        await s.on('button "Add panel"');
      });
      // The new panel's tools, behind the closed dialog.
      await s.drain(`${uid} edit, added, closed`, async () => {
        await edit();
        await s.on('button "Add panel"');
        await closeEditor();
      });
      if (uid !== 'b-2') {
        await s.drain(`${uid} edit, editor`, async () => {
          await edit();
          await s.menuItem(/^button "Panel menu: /, 0);
        });
      }
    }
    // Three new panels at once (the L26 sequence saves between adds): their tools are `#2`, `#3`.
    await s.drain('b-3 edit, three added', async () => {
      await s.goto('/t/demo/board/b-3');
      await s.on('button "Edit board"');
      for (let i = 0; i < 3; i++) {
        await s.on('button "Add panel"');
        await closeEditor();
        if (i < 2) {
          await press('ControlOrMeta+S');
          await expect(status).toHaveText('Saved');
        }
      }
    });
  });

  await test.step('L27 Editor', async () => {
    const url = '/t/demo/board/b-3';
    const openEditor = async (): Promise<void> => {
      await s.goto(url);
      await s.on('button "Edit board"');
      await s.menuItem('button "Panel menu: Edge p99"', 0);
      await expect(editor).toBeVisible();
    };
    await openEditor();
    await s.replaceText('textbox "Title"', 'Edge p99 by region');
    await expect(editor.locator('[data-preview-title]')).toHaveText('Edge p99 by region');
    for (const option of ['LogQL', 'PromQL']) {
      await s.on(/^button "\w+ Query language"$/);
      await expect(page.getByRole('listbox')).toBeVisible();
      await press('Home');
      const steps = option === 'PromQL' ? 0 : 1;
      for (let k = 0; k < steps; k++) await press('ArrowDown');
      await press('Enter');
      await expect(page.getByRole('button', { name: `${option} Query language` })).toBeVisible();
    }
    // The preview's crosshair: End sets it, Escape clears it (the dialog stays open).
    await s.focus('slider "Crosshair: Edge p99 by region"');
    await press('End');
    await press('Escape');
    await expect(editor).toBeVisible();
    await s.focus('textbox "Query"');
    await press('End');
    await type(' by (region)');
    const kinds = ['Auto', 'Line', 'Bars', 'Heatmap', 'Stat', 'Logs'];
    for (const [i, kind] of kinds.entries()) {
      await s.on(/^button "\w+ Visualisation"$/);
      await expect(page.getByRole('listbox')).toBeVisible();
      await press('Home');
      for (let k = 0; k < i; k++) await press('ArrowDown');
      await press('Enter');
      await expect(page.getByRole('button', { name: `${kind} Visualisation` })).toBeVisible();
    }
    // The last trigger name is operated too: open it and close it.
    await s.on('button "Logs Visualisation"');
    await press('Escape');
    await s.on('button "Done"');
    await expect(editor).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Panel menu: Edge p99 by region' }),
    ).toBeFocused();
    await expect(page.getByRole('heading', { level: 3, name: 'Edge p99 by region' })).toBeVisible();
    await s.menuItem('button "Panel menu: Edge errors"', 0);
    await s.on('button "Remove panel"');
    await expect(page.getByRole('button', { name: 'Add panel', exact: true })).toBeFocused();
    await expect(panelCount).toHaveCount(2);

    // The renamed panel's tools are new keys.
    await s.drain('b-3 renamed panel', async () => {
      await openEditor();
      await s.replaceText('textbox "Title"', 'Edge p99 by region');
      await closeEditor();
    });
    for (const which of ['Query language', 'Visualisation']) {
      await s.drain(`${which} list box`, async () => {
        await openEditor();
        await s.on(new RegExp(`^button "\\w+ ${which}"$`));
        await expect(page.getByRole('listbox')).toBeVisible();
      });
    }
  });

  await test.step('L28 Guard and conflict', async () => {
    const url = '/t/demo/board/b-3';
    const guard = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    const dirty = async (): Promise<void> => {
      await s.goto(url);
      await s.on('button "Edit board"');
      await s.on('button "Add panel"');
      await closeEditor();
      await expect(panelCount).toHaveCount(4);
    };
    await dirty();
    await s.on('link "Boards"', 'Enter', { back: true });
    await expect(guard).toBeVisible();
    await s.on('button "Keep editing"');
    await expect(guard).toBeHidden();
    expect(s.path()).toBe('/t/demo/board/b-3');
    await expect(panelCount).toHaveCount(4);
    await s.on('link "Boards"', 'Enter', { back: true });
    await expect(guard).toBeVisible();
    await s.on('button "Discard changes"');
    await expect.poll(() => s.path()).toBe('/t/demo/boards');

    const conflict = page.getByRole('dialog', { name: 'This board was changed' });
    const conflicted = async (): Promise<void> => {
      await s.goto(url);
      await page.evaluate(() => {
        localStorage.setItem('pulsus-dash.stub.conflictSave', '1');
      });
      await s.on('button "Edit board"');
      await s.on('button "Add panel"');
      await expect(panelCount).toHaveCount(4);
      await press('ControlOrMeta+S');
      await expect(conflict).toBeVisible();
    };
    await conflicted();
    await expect(conflict).toContainText('Someone saved version 2 after you opened it.');
    await s.on('button "Save mine as a new version"');
    await expect(editor.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
    await closeEditor();
    await expect(panelCount).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await conflicted();
    await s.on('button "Discard mine and load theirs"');
    await expect(editor).toBeHidden();
    await expect(panelCount).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    await s.drain('guard', async () => {
      await dirty();
      await s.on('link "Boards"', 'Enter', { back: true });
      await expect(guard).toBeVisible();
    });
    await s.drain('conflict', conflicted);
    await page.evaluate(() => {
      localStorage.removeItem('pulsus-dash.stub.conflictSave');
    });
  });

  // Plan #61 Part C, Appendix C-A §A.3: sections, variable chips and filters.
  const section = (title: string) =>
    page.locator('[data-section]').filter({
      has: page
        .getByRole('heading', { level: 2 })
        .getByRole('button', { name: title, exact: true }),
    });

  await test.step('L29 Sections', async () => {
    const url = '/t/demo/board/b-1';
    await s.goto(url);
    await s.shellAfter(await s.linkKeys(), () => s.goto(url));
    const latency = page.getByRole('button', { name: 'Latency', exact: true });
    await s.on('button "Latency"');
    await expect(latency).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('heading', { level: 3, name: 'Request latency' })).toHaveCount(0);
    await expect(section('Latency').getByText('1 panel')).toBeVisible();
    await expect.poll(() => s.search()['collapse']).toBe('s-1');
    await press('Enter');
    await expect(latency).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => s.search()['collapse']).toBeUndefined();

    await s.on('button "Edit board"');
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await s.on('button "Add section"');
    await expect(page.getByRole('button', { name: 'Untitled section', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Section 2 title' })).toBeVisible();
    await s.replaceText('textbox "Section 2 title"', 'Keyboard section');
    await expect(page.getByRole('button', { name: 'Keyboard section', exact: true })).toBeVisible();
    await s.on('button "Add panel to Keyboard section"');
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    await closeEditor();
    await expect(page.getByRole('button', { name: 'Panel menu: Untitled panel' })).toBeFocused();
    // After the close: `section()` finds the section by its heading button, which the modal hides.
    await expect(section('Keyboard section').locator('[data-panel]')).toHaveCount(1);
    const kb = page.getByRole('button', { name: 'Keyboard section', exact: true });
    await s.on('button "Keyboard section"');
    await expect(kb).toHaveAttribute('aria-expanded', 'false');
    await press('Enter');
    await expect(kb).toHaveAttribute('aria-expanded', 'true');
    await s.focus('textbox "Section 1 title"');
    await press('End');
    await s.on('button "Add panel to Latency"');
    await expect(editor).toBeVisible();
    await closeEditor();
    await expect(section('Latency').locator('[data-panel]')).toHaveCount(2);
    await s.on('button "Remove section Keyboard section"');
    await expect(section('Keyboard section')).toHaveCount(0);
    await press('ControlOrMeta+S');
    await expect(status).toHaveText('Saved');
    await s.drain('b-1 edit sections', async () => {
      await s.goto(url);
      await s.on('button "Edit board"');
      await s.on('button "Add section"');
    });
    // Done from a clean Edit state: no guard opens (L28 covers the guard).
    await s.goto(url);
    await s.on('button "Edit board"');
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await s.on('button "Done"');
    await expect(page.getByRole('button', { name: 'Edit board' })).toBeVisible();
  });

  await test.step('L30 Variables', async () => {
    const url = '/t/demo/board/b-3';
    await s.goto(url);
    await s.shellAfter(await s.linkKeys(), () => s.goto(url));
    await s.on('button "Variable region: not set"');
    const region = page.getByRole('dialog', { name: 'Variable region' });
    await expect(region).toBeVisible();
    await s.replaceText('textbox "Value"', 'eu-west-1');
    await s.on('button "Apply"');
    await expect(region).toBeHidden();
    await expect.poll(() => s.search()['var-region']).toBe('eu-west-1');
    await expect(page.getByRole('button', { name: 'Variable region: eu-west-1' })).toBeFocused();
    await press('Enter');
    await expect(region).toBeVisible();
    await s.on('button "Clear"');
    await expect(page.getByRole('button', { name: 'Variable region: not set' })).toBeVisible();

    const env = page.getByRole('dialog', { name: 'Variable env' });
    const search = page.url();
    await s.on('button "Variable env: not set"');
    await expect(env).toBeVisible();
    await press('Escape');
    await expect(env).toBeHidden();
    expect(page.url()).toBe(search);
    await expect(page.getByRole('button', { name: 'Variable env: not set' })).toBeFocused();
    await press('Enter');
    await expect(env).toBeVisible();
    await s.replaceText('textbox "Value"', 'prod');
    await s.on('button "Apply"');
    await expect(page.getByRole('button', { name: 'Variable env: prod' })).toBeVisible();
    await s.on('button "Variable env: prod"');
    await s.on('button "Apply"');
    await expect(env).toBeHidden();
    await s.drain('b-3 variable dialog', async () => {
      await s.goto(url);
      await s.on('button "Variable region: not set"');
    });
  });

  await test.step('L31 Filters', async () => {
    const url = '/t/demo/board/b-1';
    await s.goto(url);
    await s.on('button "Filter"');
    const add = page.getByRole('dialog', { name: 'Add filter' });
    await expect(add).toBeVisible();
    await s.replaceText('textbox "Label"', '9x');
    await s.replaceText('textbox "Value"', 'checkout');
    await s.on('button "Add"');
    await expect(add.getByText(/^Use a label name: /)).toBeVisible();
    await expect(add).toBeVisible();
    await s.replaceText('textbox "Label"', 'service');
    await s.on('button "Add"');
    await expect(add).toBeHidden();
    const chip = page.getByRole('button', { name: 'Filter service: checkout' });
    await expect(chip).toBeVisible();
    await expect.poll(() => s.search()['f']).toBe('service=checkout');
    await s.on('button "Filter service: checkout"');
    const edit = page.getByRole('dialog', { name: 'Filter service' });
    await expect(edit).toBeVisible();
    await s.replaceText('textbox "Value"', 'payments');
    await s.on('button "Apply"');
    await expect(page.getByRole('button', { name: 'Filter service: payments' })).toBeVisible();
    await press('Enter');
    await expect(edit).toBeVisible();
    await s.on('button "Remove filter"');
    await expect(page.getByRole('button', { name: /^Filter service: / })).toHaveCount(0);
    await s.on('button "Filter"');
    await expect(add).toBeVisible();
    await s.on('button "Cancel"');
    await expect(add).toBeHidden();

    const deep =
      '/t/demo/board/b-3?from=now-1h&to=now&refresh=off&f=service%3Dcheckout&var-env=prod';
    await s.goto(deep);
    await s.on('button "Share"');
    await s.on('checkbox "Keep relative"', 'Space');
    await s.on('button "Copy link"');
    await expect
      .poll(() => page.evaluate(() => window.__copied.at(-1) ?? ''))
      .toMatch(/&f=service%3Dcheckout&var-env=prod$/);
    await press('Escape');

    await s.drain('b-1 add filter', async () => {
      await s.goto(url);
      await s.on('button "Filter"');
    });
    await s.drain('b-3 filter dialog', async () => {
      await s.goto(deep);
      await s.on('button "Filter service: checkout"');
    });
    await s.drain('b-3 view with params', () => s.goto(deep));
  });
}
