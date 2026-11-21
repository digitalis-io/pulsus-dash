/**
 * The status line of the Explore query card (plan #63 Part C §3.3, §4.2): a refusal or a run error
 * as an alert (with Narrow when the window is the problem), the size note, the waiting note or the
 * outcome as a status, or nothing. `statusView` picks the first that applies.
 */
import type { JSX } from 'react';
import type { Diagnostic } from '../../editor/lang/types';
import { errorView, outcomeText, refusalText } from '../../explore/statusText';
import type { ExploreRun, Refusal } from '../../explore/useExploreRun';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { Icon } from '../../kit/Icon';
import styles from './Explore.module.css';

export type StatusView =
  | { readonly kind: 'none' }
  /** The draft is over 128 KB. */
  | { readonly kind: 'limit'; readonly text: string }
  /** Run is not ready yet. */
  | { readonly kind: 'waiting'; readonly text: string }
  /** A Run was refused. */
  | { readonly kind: 'refused'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string; readonly narrow: boolean }
  | { readonly kind: 'ok'; readonly text: string };

const NONE: StatusView = { kind: 'none' };

export function statusView(i: {
  readonly runRefusal: Refusal | null;
  readonly draftOver: boolean;
  readonly runReady: boolean;
  readonly editorLoaded: boolean;
  readonly run: ExploreRun;
  readonly diagnostics: readonly Diagnostic[];
}): StatusView {
  if (i.runRefusal !== null) return { kind: 'refused', text: refusalText(i.runRefusal) };
  if (i.draftOver) return { kind: 'limit', text: refusalText('queryTooLarge') };
  if (i.run.refusal !== null) return { kind: 'refused', text: refusalText(i.run.refusal) };
  if (i.editorLoaded && !i.runReady) return { kind: 'waiting', text: t('explore.query.waiting') };
  const e = errorView(i.run.error, i.diagnostics);
  if (e !== null) return { kind: 'error', text: e.text, narrow: e.narrow };
  if (i.run.shown !== null) return { kind: 'ok', text: outcomeText(i.run.shown) };
  return NONE;
}

export function QueryStatus({
  view,
  onNarrow,
}: {
  readonly view: StatusView;
  readonly onNarrow: () => void;
}): JSX.Element | null {
  switch (view.kind) {
    case 'none':
      return null;
    case 'refused':
    case 'error':
      return (
        <p role="alert" className={cx(styles['alert'])}>
          <Icon name="info" />
          <span>{view.text}</span>
          {view.kind === 'error' && view.narrow && (
            <Button variant="ghost" onPress={onNarrow}>
              {t('explore.narrow')}
            </Button>
          )}
        </p>
      );
    case 'limit':
    case 'waiting':
    case 'ok':
      return <p role="status">{view.text}</p>;
  }
}
