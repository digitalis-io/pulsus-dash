/**
 * The page header (D9, IA-016, VL-017): breadcrumb, title and star toggle on the left (the title
 * truncates first); time range picker, refresh control and user menu on the right.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../app/providers';
import { Breadcrumb } from './Breadcrumb';
import { usePageTitleValue } from './PageTitle';
import { RefreshControl } from './RefreshControl';
import { StarToggle } from './StarToggle';
import { TimeRangePicker } from './TimeRangePicker';
import { UserMenu } from './UserMenu';
import { useShellRoute } from './useShellRoute';
import styles from './Header.module.css';
import { cx } from '../kit/cx';

function BoardStar({ tenant, uid }: { tenant: string; uid: string }) {
  const api = useApi();
  const board = useQuery({
    queryKey: ['board', tenant, uid],
    queryFn: ({ signal }) => api.getBoard(tenant, uid, signal),
  });
  return board.isSuccess ? <StarToggle tenant={tenant} uid={uid} /> : null;
}

export function Header() {
  const title = usePageTitleValue();
  const { routeId, tenant, uid } = useShellRoute();
  return (
    <header className={cx(styles['header'])}>
      <div className={cx(styles['left'])}>
        <Breadcrumb routeId={routeId} tenant={tenant} />
        <h1 className={cx(styles['title'])} title={title}>
          {title}
        </h1>
        {routeId === 'board' && uid !== undefined && <BoardStar tenant={tenant} uid={uid} />}
      </div>
      <div className={cx(styles['right'])}>
        <TimeRangePicker />
        <RefreshControl />
        <UserMenu />
      </div>
    </header>
  );
}
