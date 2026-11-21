/**
 * Boards (IA-015, plan #61 Part B §4.5): the organisation's boards in a table, newest first as the
 * API returns them, with New board, Rename and Delete. Board links apply the board's saved time.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MenuTrigger } from 'react-aria-components';
import { Link, useNavigate } from 'react-router';
import { preloadRoute } from '../../app/routeModules';
import type { Board, BoardSummary } from '../../api/types';
import { formatDate, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { EmptyState } from '../../kit/EmptyState';
import { Icon } from '../../kit/Icon';
import { IconButton } from '../../kit/IconButton';
import { Menu, MenuItem } from '../../kit/Menu';
import { Popover } from '../../kit/Popover';
import { usePageTitle } from '../../shell/PageTitle';
import { BOARD_LINK_STATE, useBoards, type BoardLinkState } from '../../shell/SidebarBoards';
import { useShellRoute } from '../../shell/useShellRoute';
import { contextSearchString } from '../../state/contextSearch';
import { useTimeContext } from '../../state/useTimeContext';
import pages from '../pages.module.css';
import { DeleteBoardDialog, NewBoardDialog, RenameBoardDialog } from './BoardDialogs';
import styles from './BoardsPage.module.css';
import { invalidateBoardLists } from '../../boards/queries';

type Open =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'rename'; board: BoardSummary }
  | { kind: 'delete'; board: BoardSummary };

const NEW_BOARD_STATE: BoardLinkState = { applySavedTime: true, edit: true };

export function BoardsPage() {
  usePageTitle(t('boards.title'));
  const { tenant } = useShellRoute();
  const { search, timeZone } = useTimeContext();
  const boards = useBoards(tenant);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<Open>({ kind: 'none' });
  const [notice, setNotice] = useState('');
  const close = (): void => {
    setOpen({ kind: 'none' });
  };
  const boardPath = (uid: string) => ({
    pathname: `/t/${tenant}/board/${uid}`,
    search: contextSearchString(search),
  });

  const onCreated = (board: Board): void => {
    queryClient.setQueryData(['board', tenant, board.uid], board);
    void invalidateBoardLists(queryClient);
    close();
    void navigate(boardPath(board.uid), { state: NEW_BOARD_STATE });
  };

  let body;
  if (boards.isPending)
    body = (
      <p className={cx(pages['muted'])} aria-busy="true">
        {t('boards.loading')}
      </p>
    );
  else if (boards.isError) body = <p className={cx(pages['muted'])}>{t('boards.error')}</p>;
  else if (boards.data.items.length === 0) {
    body = (
      <EmptyState title={t('boards.empty')}>
        <p className={cx(pages['muted'])}>{t('boards.emptyDetail')}</p>
      </EmptyState>
    );
  } else {
    body = (
      <table className={cx(styles['table'])} aria-label={t('boards.list')}>
        <thead>
          <tr>
            <th scope="col" className={cx(styles['name'])}>
              {t('boards.col.name')}
            </th>
            <th scope="col">{t('boards.col.updated')}</th>
            <th scope="col">{t('boards.col.updatedBy')}</th>
            <th scope="col" className={cx(styles['actions'])}>
              <span className={cx(styles['hidden'])}>{t('boards.col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {boards.data.items.map((b) => {
            const ms = Date.parse(b.updatedAt);
            return (
              <tr key={b.uid}>
                <td className={cx(styles['name'])}>
                  <Link
                    to={boardPath(b.uid)}
                    state={BOARD_LINK_STATE}
                    className={cx(pages['rowLink'])}
                    title={b.title}
                    onPointerEnter={() => {
                      preloadRoute('board');
                    }}
                    onFocus={() => {
                      preloadRoute('board');
                    }}
                  >
                    {b.title}
                  </Link>
                </td>
                <td className={cx(styles['meta'])}>
                  {`${formatDate(ms, timeZone)}, ${formatTime(ms, timeZone)}`}
                </td>
                <td className={cx(styles['meta'])}>{b.updatedBy}</td>
                <td className={cx(styles['actions'])}>
                  <MenuTrigger>
                    <IconButton
                      icon="ellipsis"
                      aria-label={t('boards.actions', { title: b.title })}
                    />
                    <Popover placement="bottom end">
                      <Menu aria-label={t('boards.actions', { title: b.title })}>
                        <MenuItem
                          id="rename"
                          onAction={() => {
                            setNotice('');
                            setOpen({ kind: 'rename', board: b });
                          }}
                        >
                          {t('boards.rename')}
                        </MenuItem>
                        <MenuItem
                          id="delete"
                          onAction={() => {
                            setNotice('');
                            setOpen({ kind: 'delete', board: b });
                          }}
                        >
                          {t('boards.delete')}
                        </MenuItem>
                      </Menu>
                    </Popover>
                  </MenuTrigger>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <div className={cx(pages['page'])}>
      <div className={cx(styles['header'])}>
        <Button
          variant="primary"
          onPress={() => {
            setNotice('');
            setOpen({ kind: 'new' });
          }}
        >
          <Icon name="plus" />
          {t('boards.new')}
        </Button>
      </div>
      <p role="status" aria-label={t('boards.status')} className={cx(styles['notice'])}>
        {notice}
      </p>
      {body}
      {boards.isSuccess && boards.data.truncated && (
        <p className={cx(pages['muted'])}>{t('boards.truncated')}</p>
      )}
      {open.kind === 'new' && (
        <NewBoardDialog tenant={tenant} onClose={close} onCreated={onCreated} />
      )}
      {open.kind === 'rename' && (
        <RenameBoardDialog
          tenant={tenant}
          board={open.board}
          onClose={close}
          onGone={() => {
            void invalidateBoardLists(queryClient);
            setNotice(t('boards.gone'));
            close();
          }}
        />
      )}
      {open.kind === 'delete' && (
        <DeleteBoardDialog tenant={tenant} board={open.board} onClose={close} />
      )}
    </div>
  );
}
