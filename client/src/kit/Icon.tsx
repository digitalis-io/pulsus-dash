/**
 * Line icons copied in as SVG files (ADR-0014 §1; `src/icons/`, ISC). Drawn as a CSS mask over
 * `currentcolor`, so icons follow the text colour in both themes without inline SVG markup.
 */
import styles from './Icon.module.css';

export type IconName =
  | 'activity'
  | 'layout-dashboard'
  | 'chart-line'
  | 'scroll-text'
  | 'settings'
  | 'panel-left-close'
  | 'panel-left-open'
  | 'clock'
  | 'refresh-cw'
  | 'chevron-down'
  | 'chevron-right'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'info'
  | 'log-out'
  | 'link'
  | 'calendar'
  | 'check'
  | 'plus'
  | 'maximize-2'
  | 'ellipsis'
  | 'move'
  | 'x'
  | 'share-2'
  | 'square-arrow-out-up-right'
  | 'copy'
  | 'pencil'
  | 'panel-right-close'
  | 'panel-right-open'
  | 'arrow-up-right'
  | 'git-branch'
  | 'flame'
  | 'box'
  | 'filter';

const CLASS: Readonly<Record<IconName, string | undefined>> = {
  activity: styles['activity'],
  'layout-dashboard': styles['layoutDashboard'],
  'chart-line': styles['chartLine'],
  'scroll-text': styles['scrollText'],
  settings: styles['settings'],
  'panel-left-close': styles['panelLeftClose'],
  'panel-left-open': styles['panelLeftOpen'],
  clock: styles['clock'],
  'refresh-cw': styles['refreshCw'],
  'chevron-down': styles['chevronDown'],
  'chevron-right': styles['chevronRight'],
  sun: styles['sun'],
  moon: styles['moon'],
  monitor: styles['monitor'],
  info: styles['info'],
  'log-out': styles['logOut'],
  link: styles['link'],
  calendar: styles['calendar'],
  check: styles['check'],
  plus: styles['plus'],
  'maximize-2': styles['maximize2'],
  ellipsis: styles['ellipsis'],
  move: styles['move'],
  x: styles['x'],
  'share-2': styles['share2'],
  'square-arrow-out-up-right': styles['squareArrowOutUpRight'],
  copy: styles['copy'],
  pencil: styles['pencil'],
  'panel-right-close': styles['panelRightClose'],
  'panel-right-open': styles['panelRightOpen'],
  'arrow-up-right': styles['arrowUpRight'],
  'git-branch': styles['gitBranch'],
  flame: styles['flame'],
  box: styles['box'],
  filter: styles['filter'],
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const cls = [styles['icon'], CLASS[name], className].filter(Boolean).join(' ');
  return <span className={cls} aria-hidden="true" />;
}
