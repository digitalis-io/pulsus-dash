/** "Star board" toggle in the header of a board page (IA-021); updates the Starred group. */
import { useQueryClient } from '@tanstack/react-query';
import { ToggleButton } from 'react-aria-components';
import { useApi } from '../app/providers';
import { t } from '../i18n/t';
import { useStarred } from './SidebarBoards';
import styles from './Header.module.css';
import { cx } from '../kit/cx';

export function StarToggle({ tenant, uid }: { tenant: string; uid: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const starred = useStarred(tenant);
  const isStarred = starred.data?.some((r) => r.uid === uid) ?? false;
  const onChange = (next: boolean): void => {
    const settled = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['starred', tenant] });
    };
    api.setStarred(tenant, uid, next).then(settled, settled);
  };
  return (
    <ToggleButton
      aria-label={t('board.star')}
      isSelected={isStarred}
      isDisabled={!starred.isSuccess}
      onChange={onChange}
      className={cx(styles['star'])}
    >
      <span aria-hidden="true">{isStarred ? '★' : '☆'}</span>
    </ToggleButton>
  );
}
