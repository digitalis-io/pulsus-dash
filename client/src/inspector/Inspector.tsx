/**
 * The Inspector sheet (T25-003, T25-008, T25-011, T25-013, T25-015; plan #192 §4.4): a floating
 * translucent sheet over the content column that never reflows it. Its sections are fixed, in
 * order: header, value, details, labels, members (if any), pivots, query and actions. The sheet
 * opens with a 200 ms fade and slide; a new target crossfades its content over 150 ms (the outgoing
 * layer is inert); a close fades out over 150 ms. Under reduced motion nothing animates, and every
 * change is instant. It collapses to a 40 px tab.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useNavigate } from 'react-router';
import { formatClockMs } from '../i18n/format';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { Icon, type IconName } from '../kit/Icon';
import { useTimeZone } from '../state/timeZone';
import { StateEncoding } from '../theme/stateEncoding';
import styles from './Inspector.module.css';
import {
  membersView,
  NO_MEMBERS_STATE,
  pressFewer,
  pressMore,
  type MemberFacts,
  type MemberList,
  type MembersState,
  type MemberSection,
} from './members';
import type { InspectorModel, Pivot } from './types';

/** The crossfade and the close (T25 §4.4): `motion.fast`. */
const FADE_MS = 150;
/** "Couldn't copy" shows this long (T25-015). */
const COPY_FAILED_MS = 4_000;

export interface InspectorProps {
  readonly ref?: Ref<HTMLElement | null>;
  readonly model: InspectorModel | null;
  /**
   * The tenant: when it changes, every layer goes at once (no close fade, no outgoing layer), so
   * nothing of the last tenant shows (T25 §8).
   */
  readonly scope: string;
  /** +1 per inspect. */
  readonly seq: number;
  /** The `seq` of a keyboard open, whose heading takes focus; null otherwise. */
  readonly focusHeading: number | null;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onClose: () => void;
  readonly onEditQuery: () => void;
  readonly resolveMembers: (panelId: string, runId: string) => MemberList | null;
}

/** Reduced motion, read per event (VL-016). */
function reducedMotion(): boolean {
  try {
    return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

interface Layer {
  readonly seq: number;
  readonly model: InspectorModel;
}

interface Layers {
  readonly scope: string;
  readonly current: Layer | null;
  readonly leaving: Layer | null;
  readonly closing: boolean;
}

const noLayers = (scope: string): Layers => ({
  scope,
  current: null,
  leaving: null,
  closing: false,
});

const PIVOT_ICON: Readonly<Record<Pivot['id'], IconName>> = {
  explore: 'chart-line',
  logs: 'scroll-text',
  traces: 'git-branch',
  profiles: 'flame',
  entity: 'box',
  labelFilter: 'filter',
};

/** The layers to show for `model` and `seq`, from the last ones (a render-time state update). */
function nextLayers(l: Layers, model: InspectorModel | null, seq: number, scope: string): Layers {
  if (l.scope !== scope) {
    return model === null
      ? noLayers(scope)
      : { scope, current: { seq, model }, leaving: null, closing: false };
  }
  if (model === null) {
    if (l.current === null || l.closing) return l;
    return reducedMotion()
      ? noLayers(scope)
      : { scope, current: l.current, leaving: null, closing: true };
  }
  if (l.current === null || l.closing) {
    return { scope, current: { seq, model }, leaving: null, closing: false };
  }
  if (l.current.seq !== seq) {
    // A third target drops the older outgoing layer at once: at most two layers.
    return {
      scope,
      current: { seq, model },
      leaving: reducedMotion() ? null : l.current,
      closing: false,
    };
  }
  return l.current.model === model ? l : { ...l, current: { seq, model } };
}

export function Inspector({
  ref,
  model,
  scope,
  seq,
  focusHeading,
  collapsed,
  onToggleCollapsed,
  onClose,
  onEditQuery,
  resolveMembers,
}: InspectorProps) {
  const [layers, setLayers] = useState<Layers>(() => noLayers(scope));
  const next = nextLayers(layers, model, seq, scope);
  if (next !== layers) setLayers(next);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  /** Focus was inside the sheet when it collapsed or expanded: it moves to the other button. */
  const toggled = useRef(false);
  const leaving = next.leaving;
  const closing = next.closing;

  // The outgoing layer goes after its fade (or at its `transitionend`); a close unmounts after its own.
  useEffect(() => {
    if (leaving === null) return;
    const id = setTimeout(() => {
      setLayers((l) => (l.leaving === leaving ? { ...l, leaving: null } : l));
    }, FADE_MS);
    return () => {
      clearTimeout(id);
    };
  }, [leaving]);
  useEffect(() => {
    if (!closing) return;
    const id = setTimeout(() => {
      setLayers((l) => (l.closing ? noLayers(l.scope) : l));
    }, FADE_MS);
    return () => {
      clearTimeout(id);
    };
  }, [closing]);

  // A keyboard open focuses the heading, also from the collapsed tab (T25-008).
  useLayoutEffect(() => {
    if (focusHeading !== null) headingRef.current?.focus();
  }, [focusHeading]);

  useLayoutEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    (collapsed ? expandRef : collapseRef).current?.focus();
  }, [collapsed]);

  const current = next.current;
  if (current === null) return null;
  const toggle = (): void => {
    const aside = (expandRef.current ?? collapseRef.current)?.closest('aside');
    toggled.current = aside?.contains(document.activeElement) === true;
    onToggleCollapsed();
  };

  return (
    <aside
      ref={ref}
      className={cx(styles['sheet'])}
      aria-labelledby={collapsed ? undefined : headingId}
      aria-label={collapsed ? current.model.heading : undefined}
      data-inspector=""
      data-collapsed={collapsed ? '' : undefined}
      data-closing={closing ? '' : undefined}
      aria-hidden={closing ? true : undefined}
      inert={closing}
    >
      {collapsed ? (
        <button
          ref={expandRef}
          type="button"
          className={cx(styles['iconButton'], styles['tab'])}
          aria-label={t('inspector.expand')}
          onClick={toggle}
        >
          <Icon name="panel-right-open" />
        </button>
      ) : (
        <>
          <div className={cx(styles['body'])}>
            {leaving !== null && (
              <Content
                key={leaving.seq}
                model={leaving.model}
                leaving
                onDone={() => {
                  setLayers((l) => (l.leaving === leaving ? { ...l, leaving: null } : l));
                }}
              />
            )}
            <Content
              key={current.seq}
              model={current.model}
              leaving={false}
              headingId={headingId}
              headingRef={headingRef}
              onEditQuery={onEditQuery}
              resolveMembers={resolveMembers}
              chrome={
                <div className={cx(styles['chrome'])}>
                  <button
                    ref={collapseRef}
                    type="button"
                    className={cx(styles['iconButton'])}
                    aria-label={t('inspector.collapse')}
                    onClick={toggle}
                  >
                    <Icon name="panel-right-close" />
                  </button>
                  <button
                    type="button"
                    className={cx(styles['iconButton'])}
                    aria-label={t('inspector.close')}
                    onClick={onClose}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              }
            />
          </div>
        </>
      )}
    </aside>
  );
}

interface ContentProps {
  readonly model: InspectorModel;
  readonly leaving: boolean;
  readonly headingId?: string;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly onEditQuery?: () => void;
  readonly resolveMembers?: (panelId: string, runId: string) => MemberList | null;
  readonly onDone?: () => void;
  /** The collapse and close buttons, after the heading in the tab order (T25-008). */
  readonly chrome?: ReactNode;
}

/** One layer of the sheet's body: every section of one target. */
function Content({
  model: m,
  leaving,
  headingId,
  headingRef,
  onEditQuery,
  resolveMembers,
  onDone,
  chrome,
}: ContentProps) {
  const [copyFailed, setCopyFailed] = useState(false);
  const failTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (failTimer.current !== null) clearTimeout(failTimer.current);
    },
    [],
  );
  const copy = (text: string): void => {
    const failed = (): void => {
      setCopyFailed(true);
      if (failTimer.current !== null) clearTimeout(failTimer.current);
      failTimer.current = setTimeout(() => {
        failTimer.current = null;
        setCopyFailed(false);
      }, COPY_FAILED_MS);
    };
    // On the gesture only (T08-021, T25-015); no clipboard is a refusal too.
    try {
      navigator.clipboard.writeText(text).catch(failed);
    } catch {
      failed();
    }
  };
  return (
    <div
      className={cx(styles['layer'])}
      data-inspector-content=""
      data-leaving={leaving ? '' : undefined}
      inert={leaving}
      aria-hidden={leaving ? true : undefined}
      onTransitionEnd={(e) => {
        if (leaving && e.target === e.currentTarget) onDone?.();
      }}
    >
      <header className={cx(styles['section'], styles['header'])} data-section="header">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className={cx(styles['title'])}
          title={m.heading}
        >
          {m.heading}
        </h2>
        {m.subheading !== '' && <p className={cx(styles['subheading'])}>{m.subheading}</p>}
        {chrome}
      </header>
      <ValueSection model={m} onCopy={copy} copyFailed={copyFailed} />
      <section className={cx(styles['section'])} data-section="details">
        <h3 className={cx(styles['sectionTitle'])}>{t('inspector.section.details')}</h3>
        <dl className={cx(styles['facts'])}>
          {m.facts.map((f) => (
            <div key={f.label} className={cx(styles['row'])} data-fact="">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className={cx(styles['section'])} data-section="labels">
        <h3 className={cx(styles['sectionTitle'])}>{t('inspector.section.labels')}</h3>
        <LabelList labels={m.labels} />
        {m.extraLabels.map((x) => (
          <div key={x.title} className={cx(styles['extra'])}>
            <h4 className={cx(styles['sectionTitle'])}>
              {x.title === 'Metadata'
                ? t('inspector.section.metadata')
                : t('inspector.section.parsed')}
            </h4>
            <LabelList labels={x.labels} />
          </div>
        ))}
      </section>
      {m.members !== null && (
        <MembersSection members={m.members} resolve={resolveMembers ?? (() => null)} />
      )}
      <PivotsSection pivots={m.pivots} />
      <section className={cx(styles['section'])} data-section="query">
        <h3 className={cx(styles['sectionTitle'])}>
          {t('inspector.section.query')}
          {m.query !== null && <span className={cx(styles['lang'])}>{m.query.lang}</span>}
        </h3>
        {m.query === null ? (
          <p className={cx(styles['empty'])}>{t('inspector.noQuery')}</p>
        ) : (
          <div className={cx(styles['query'])}>
            <code className={cx(styles['queryText'])}>{m.query.text}</code>
            <button
              type="button"
              className={cx(styles['iconButton'], styles['small'])}
              aria-label={t('inspector.copyQuery')}
              onClick={() => {
                if (m.query !== null) copy(m.query.text);
              }}
            >
              <Icon name="copy" />
            </button>
            <button
              type="button"
              className={cx(styles['iconButton'], styles['small'])}
              aria-label={t('inspector.editQuery')}
              onClick={onEditQuery}
            >
              <Icon name="pencil" />
            </button>
          </div>
        )}
      </section>
      <ActionsSection model={m} />
    </div>
  );
}

function ValueSection({
  model: m,
  onCopy,
  copyFailed,
}: {
  model: InspectorModel;
  onCopy: (text: string) => void;
  copyFailed: boolean;
}) {
  // `2.84 s`: the number large, its unit small and muted (T25 §4.4).
  const split =
    m.primaryKind === 'value' && m.primary !== t('inspector.noValue')
      ? /^(.*\S) (\S+)$/.exec(m.primary)
      : null;
  const state = m.primaryState === null ? null : StateEncoding[m.primaryState];
  return (
    <section className={cx(styles['section'])} data-section="value">
      <div className={cx(styles['valueRow'])}>
        {m.primaryKind === 'line' ? (
          <LogLine text={m.primary} />
        ) : (
          <p
            className={cx(styles['value'], state?.className)}
            data-inspector-value=""
            data-state={m.primaryState ?? undefined}
          >
            {state !== null && (
              <span className={cx(styles['glyph'])} aria-hidden="true">
                {state.glyph}
              </span>
            )}
            {split === null ? (
              m.primary
            ) : (
              <>
                {split[1]}
                <span className={cx(styles['unit'])}> {split[2]}</span>
              </>
            )}
          </p>
        )}
        <button
          type="button"
          className={cx(styles['iconButton'], styles['small'])}
          aria-label={t('inspector.copyValue')}
          onClick={() => {
            onCopy(m.copyValue);
          }}
        >
          <Icon name="copy" />
        </button>
      </div>
      <p className={cx(styles['copyFailed'])} role="status">
        {copyFailed ? t('inspector.copyFailed') : ''}
      </p>
    </section>
  );
}

/** A log line: a tab stop only when it overflows its 120 px and scrolls (WCAG 2.1.1). */
function LogLine({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (el.scrollHeight > el.clientHeight) el.tabIndex = 0;
    else el.removeAttribute('tabindex');
  }, [text]);
  return (
    <pre ref={ref} className={cx(styles['line'])} data-inspector-value="">
      {text}
    </pre>
  );
}

function LabelList({ labels }: { labels: readonly (readonly [string, string])[] }) {
  if (labels.length === 0) {
    return <p className={cx(styles['empty'])}>{t('inspector.noLabels')}</p>;
  }
  return (
    <dl className={cx(styles['labels'])}>
      {labels.map(([k, v]) => (
        <div key={k} className={cx(styles['row'])}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function memberText(f: MemberFacts, tz: string): string {
  return `${formatClockMs(f.fromMs, tz)} – ${formatClockMs(f.toMs, tz)} ${f.text}`;
}

function MembersSection({
  members,
  resolve,
}: {
  members: MemberSection;
  resolve: (panelId: string, runId: string) => MemberList | null;
}) {
  const tz = useTimeZone();
  const [s, setS] = useState<MembersState>(NO_MEMBERS_STATE);
  const v = membersView(members, s);
  const list = (
    which: 'texts' | 'runs',
    title: string,
    items: readonly string[],
    more: number | null,
    fewer: boolean,
  ) => (
    <div className={cx(styles['members'])}>
      <h4 className={cx(styles['sectionTitle'])}>{title}</h4>
      <ul className={cx(styles['memberList'])} data-open={fewer ? '' : undefined}>
        {items.map((x, i) => (
          <li key={`${String(i)}:${x}`}>{x}</li>
        ))}
      </ul>
      {more !== null && (
        <button
          type="button"
          className={cx(styles['textButton'])}
          onClick={() => {
            setS((x) => pressMore(members, x, which, resolve));
          }}
        >
          {t('inspector.members.more', { n: more })}
        </button>
      )}
      {fewer && (
        <button
          type="button"
          className={cx(styles['textButton'])}
          onClick={() => {
            setS((x) => pressFewer(x, which));
          }}
        >
          {t('inspector.members.fewer')}
        </button>
      )}
    </div>
  );
  return (
    <section className={cx(styles['section'])} data-section="members">
      <h3 className={cx(styles['sectionTitle'])}>{t('inspector.section.members')}</h3>
      {list('texts', t('inspector.members.texts'), v.texts.items, v.texts.more, v.texts.fewer)}
      {v.runs !== null &&
        list(
          'runs',
          t('inspector.members.runs'),
          v.runs.items.map((f) => memberText(f, tz)),
          v.runs.more,
          v.runs.fewer,
        )}
      {v.stale && <p className={cx(styles['note'])}>{t('inspector.members.stale')}</p>}
    </section>
  );
}

function PivotsSection({ pivots }: { pivots: readonly Pivot[] }) {
  const navigate = useNavigate();
  const base = useId();
  const reasonId = (p: Pivot): string => `${base}-${p.id}`;
  const onClick = (e: MouseEvent<HTMLAnchorElement>, href: string): void => {
    // ⌘/Ctrl or another button: the browser's own new tab (INT-036 interim).
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    void navigate(href);
  };
  const enabled = pivots.filter((p) => p.href !== null);
  const disabled = pivots.filter((p) => p.href === null);
  return (
    <section className={cx(styles['section'])} data-section="pivots">
      <h3 className={cx(styles['sectionTitle'])}>{t('inspector.section.pivots')}</h3>
      {enabled.map((p) => (
        <div key={p.id} className={cx(styles['pivot'])}>
          <a
            href={p.href ?? undefined}
            className={cx(styles['chip'])}
            data-pivot={p.id}
            onClick={(e) => {
              if (p.href !== null) onClick(e, p.href);
            }}
          >
            <Icon name={PIVOT_ICON[p.id]} />
            {p.label}
            <Icon name="arrow-up-right" className={cx(styles['out'])} />
          </a>
          {p.context.map((line) => (
            <p key={line} className={cx(styles['context'])}>
              {line}
            </p>
          ))}
        </div>
      ))}
      {disabled.length > 0 && (
        <div className={cx(styles['chips'])}>
          {disabled.map((p) => (
            <span
              key={p.id}
              role="link"
              aria-disabled="true"
              // A disabled pivot stays focusable, described by its reason (T25-008).
              tabIndex={0}
              aria-describedby={reasonId(p)}
              className={cx(styles['chip'], styles['chipDisabled'])}
              data-pivot={p.id}
            >
              <Icon name={PIVOT_ICON[p.id]} />
              {p.label}
            </span>
          ))}
        </div>
      )}
      {disabled.map((p) => (
        <p key={p.id} id={reasonId(p)} className={cx(styles['reason'])}>
          {t('inspector.reasonLine', { label: p.label, reason: p.reason ?? '' })}
        </p>
      ))}
    </section>
  );
}

function ActionsSection({ model: m }: { model: InspectorModel }) {
  const base = useId();
  return (
    <section className={cx(styles['section'])} data-section="actions">
      <h3 className={cx(styles['sectionTitle'])}>{t('inspector.section.actions')}</h3>
      <div className={cx(styles['chips'])}>
        {m.actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className={cx(styles['action'])}
            aria-disabled={a.reason === null ? undefined : true}
            aria-describedby={a.reason === null ? undefined : `${base}-${a.id}`}
            data-action={a.id}
          >
            {a.label}
          </button>
        ))}
      </div>
      {m.actions.map((a) =>
        a.reason === null ? null : (
          <p key={a.id} id={`${base}-${a.id}`} className={cx(styles['reason'])}>
            {t('inspector.reasonLine', { label: a.label.replace(' ✦', ''), reason: a.reason })}
          </p>
        ),
      )}
    </section>
  );
}
