/**
 * A board section (plan #61 Part C §4.2, Appendix C-A §A.11; SRF-016, T07-012): a heading whose
 * button discloses the section's grid, the panel count and, in Edit mode, the title field, Add
 * panel and Remove section. A collapsed section renders no grid, so its panels mount no frame and
 * never query.
 */
import { useId, type ReactNode } from 'react';
import type { SectionSpec } from '../../api/types';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { Icon } from '../../kit/Icon';
import { TextField } from '../../kit/TextField';
import styles from './Board.module.css';

export interface BoardSectionProps {
  section: SectionSpec;
  index: number;
  mode: 'view' | 'edit';
  collapsed: boolean;
  /** A save or Discard's reload is in flight: the Edit controls are read-only. */
  busy: boolean;
  /** The message of the `/sections/<index>/title` error, if any. */
  titleError: string | null;
  onToggle: () => void;
  onTitle: (title: string) => void;
  onAddPanel: () => void;
  onRemove: () => void;
  /** The section grid; rendered only when not collapsed. */
  children: ReactNode;
}

function countText(n: number): string {
  if (n === 0) return t('section.count.none');
  if (n === 1) return t('section.count.one');
  return t('section.count.many', { n });
}

export function BoardSection({
  section,
  index,
  mode,
  collapsed,
  busy,
  titleError,
  onToggle,
  onTitle,
  onAddPanel,
  onRemove,
  children,
}: BoardSectionProps) {
  const id = useId();
  const headingId = `${id}-heading`;
  const gridId = `${id}-grid`;
  const edit = mode === 'edit';
  const title = section.title === '' ? t('section.untitled') : section.title;
  return (
    <section
      aria-labelledby={headingId}
      data-section={section.id}
      data-collapsed={collapsed ? '' : undefined}
      className={cx(styles['section'])}
    >
      <div className={cx(styles['sectionHeader'])}>
        <h2 id={headingId} className={cx(styles['sectionTitle'])}>
          <Button
            variant="ghost"
            aria-expanded={!collapsed}
            aria-controls={gridId}
            isDisabled={edit && busy}
            onPress={onToggle}
            className={cx(styles['sectionToggle'])}
          >
            <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
            {title}
          </Button>
        </h2>
        <span className={cx(styles['sectionCount'])}>{countText(section.panels.length)}</span>
        {edit && (
          <div className={cx(styles['sectionActions'])}>
            <TextField
              label={t('section.titleField', { n: index + 1 })}
              value={section.title}
              onChange={onTitle}
              isReadOnly={busy}
              error={titleError}
            />
            <Button
              aria-label={t('section.addPanel', { title })}
              isDisabled={busy}
              onPress={onAddPanel}
            >
              <Icon name="plus" />
              {t('board.addPanel')}
            </Button>
            <Button
              aria-label={t('section.remove', { title })}
              isDisabled={busy}
              onPress={onRemove}
            >
              {t('section.removeVisible')}
            </Button>
          </div>
        )}
      </div>
      {!collapsed && <div id={gridId}>{children}</div>}
    </section>
  );
}
