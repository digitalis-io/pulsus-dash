/**
 * A geomap panel's body (plan #234 Part 3 §4.10; T24-095): the lazy `GeoMapFrame` chunk inside a
 * panel-local error boundary, so a failed import leaves every other panel usable. A host-chunk
 * rejection (the boundary) and a scene-chunk failure (`onLoadFailed`, §4.4a) show one state in the
 * panel's error style, focused when focus was in the panel and announced politely: at the first
 * attempt "Map couldn't load" with Retry, which remounts the boundary, the lazy host and its frame
 * so both imports run again (no cache-busting URL); after that, an engine that keeps the failed
 * module needs the page reloaded: the Reload text and button.
 */
import {
  Component,
  lazy,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type JSX,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import type { GeoMapFrameHostProps } from '../../charts/GeoMapFrame';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { EmptyState } from '../../kit/EmptyState';
import styles from './Board.module.css';

/** The host chunk's import and the page reload, replaceable in tests. */
export const geoMapChunk = {
  load: (): Promise<{ default: ComponentType<GeoMapFrameHostProps> }> =>
    import('../../charts/GeoMapFrame'),
  reload: (): void => {
    globalThis.location.reload();
  },
};

interface BoundaryProps {
  readonly onError: () => void;
  readonly children: ReactNode;
}

/** Catches the lazy host's rejection; the one failure state is the parent's. */
class ChunkBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onError();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** A new lazy host: its first render imports the chunk (again). */
function hostChunk(): LazyExoticComponent<ComponentType<GeoMapFrameHostProps>> {
  return lazy(() => geoMapChunk.load());
}

export function GeoMapBody(p: Omit<GeoMapFrameHostProps, 'onLoadFailed'>): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Focus was in the panel when the load failed: the state takes it. */
  const focusIn = useRef(false);
  // A fresh lazy per attempt: Retry imports the chunk again.
  const [Lazy, setLazy] = useState(hostChunk);
  const fail = (): void => {
    const root = rootRef.current;
    const panel = root?.closest('[data-panel-id]') ?? root;
    focusIn.current = panel?.contains(document.activeElement) === true;
    setFailed(true);
  };
  useLayoutEffect(() => {
    if (!failed || !focusIn.current) return;
    focusIn.current = false;
    rootRef.current?.querySelector<HTMLElement>('[data-geo-load-action]')?.focus();
  }, [failed]);

  return (
    <div ref={rootRef} className={cx(styles['geoBody'])} data-geo-body="">
      {failed ? (
        <EmptyState title={t('error.generic')}>
          <div className={cx(styles['panelError'])}>
            <p
              role="status"
              aria-live="polite"
              className={cx(styles['panelErrorDetail'])}
              data-geo-load-failed=""
            >
              {attempt === 0 ? t('geo.load.failed') : t('geo.load.failedReload')}
            </p>
            {attempt === 0 ? (
              <Button
                variant="secondary"
                data-geo-load-action=""
                onPress={() => {
                  setLazy(hostChunk);
                  setFailed(false);
                  setAttempt((n) => n + 1);
                }}
              >
                {t('geo.state.retry')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                data-geo-load-action=""
                onPress={() => {
                  geoMapChunk.reload();
                }}
              >
                {t('geo.load.reload')}
              </Button>
            )}
          </div>
        </EmptyState>
      ) : (
        <ChunkBoundary key={attempt} onError={fail}>
          <Suspense
            fallback={
              <p className={cx(styles['message'])} role="status" aria-busy="true">
                {t('panel.loading')}
              </p>
            }
          >
            <Lazy {...p} onLoadFailed={fail} />
          </Suspense>
        </ChunkBoundary>
      )}
    </div>
  );
}
