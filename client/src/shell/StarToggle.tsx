/**
 * "Star board" toggle in the header of a board page (IA-021, plan #61 Part C §4.6, Appendix C-A
 * §A.13). The press shows the new state at once; further presses are ignored until the request has
 * settled (no disable, so keyboard focus stays). Then Starred is refetched here and in other tabs,
 * and a failure shows a visible message in a live region next to the star.
 */
import { useState } from 'react';
import { ToggleButton } from 'react-aria-components';
import { useApi, useBoardPrefs } from '../app/providers';
import { t } from '../i18n/t';
import { useStarred } from './SidebarBoards';
import styles from './Header.module.css';
import { cx } from '../kit/cx';

export function StarToggle({ tenant, uid }: { tenant: string; uid: string }) {
  const api = useApi();
  const prefs = useBoardPrefs();
  const starred = useStarred(tenant);
  const [pending, setPending] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const isStarred = pending ?? starred.data?.some((r) => r.uid === uid) ?? false;
  const onChange = (next: boolean): void => {
    if (pending !== null) return;
    setFailed(false);
    setPending(next);
    const settle = async (ok: boolean): Promise<void> => {
      await prefs.starredChanged();
      setPending(null);
      setFailed(!ok);
    };
    api.setStarred(tenant, uid, next).then(
      () => settle(true),
      () => settle(false),
    );
  };
  return (
    <>
      <ToggleButton
        aria-label={t('board.star')}
        isSelected={isStarred}
        isDisabled={!starred.isSuccess}
        onChange={onChange}
        className={cx(styles['star'])}
      >
        <span aria-hidden="true">{isStarred ? '★' : '☆'}</span>
      </ToggleButton>
      <span role="status" className={cx(styles['starStatus'])}>
        {failed ? t('board.starFailed') : ''}
      </span>
    </>
  );
}
