/**
 * The board list dialogs (plan #61 Part B §4.5): New board, Rename and Delete. Each keeps its input
 * and stays open on a failure, and disables its primary button while its request runs. Rename and
 * Delete read the board first, so they always send the current etag.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../app/providers';
import {
  BoardConflictError,
  isApiError,
  type Board,
  type BoardSpec,
  type BoardSummary,
  type FieldError,
} from '../../api/types';
import { fieldMessage } from '../../boards/fieldMessages';
import { checkBoardSpec } from '../../boards/spec';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { ModalDialog } from '../../kit/Dialog';
import { TextField } from '../../kit/TextField';
import { cx } from '../../kit/cx';
import styles from './BoardsPage.module.css';

/** The message of the `/title` field error, if any. */
function titleError(fields: readonly FieldError[]): string | null {
  const f = fields.find((x) => x.pointer === '/title');
  return f === undefined ? null : fieldMessage(f.messageKey);
}

function Actions({
  onCancel,
  primary,
  onPrimary,
  busy,
}: {
  onCancel: () => void;
  primary: string;
  onPrimary: () => void;
  busy: boolean;
}) {
  return (
    <div className={cx(styles['dialogActions'])}>
      <Button onPress={onCancel}>{t('boards.cancel')}</Button>
      <Button variant="primary" onPress={onPrimary} isDisabled={busy}>
        {primary}
      </Button>
    </div>
  );
}

function Failure({ text }: { text: string | null }) {
  return (
    <p role="alert" className={cx(styles['failure'])}>
      {text ?? ''}
    </p>
  );
}

export function NewBoardDialog({
  tenant,
  onClose,
  onCreated,
}: {
  tenant: string;
  onClose: () => void;
  onCreated: (board: Board) => void;
}) {
  const api = useApi();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = (): void => {
    const spec: BoardSpec = { title: name, panels: [], sections: [] };
    const fields = checkBoardSpec(spec);
    setError(titleError(fields));
    setFailure(null);
    if (fields.length > 0) return;
    setBusy(true);
    api.createBoard(tenant, spec).then(
      (board) => {
        setBusy(false);
        onCreated(board);
      },
      (e: unknown) => {
        setBusy(false);
        if (isApiError(e, 'invalid') && titleError(e.fields) !== null) {
          setError(titleError(e.fields));
        } else setFailure(t('boards.failed'));
      },
    );
  };

  return (
    <ModalDialog
      title={t('boards.newTitle')}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <form
        className={cx(styles['form'])}
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <TextField
          label={t('boards.name')}
          value={name}
          onChange={setName}
          error={error}
          autoFocus
          autoComplete="off"
        />
        <Failure text={failure} />
        <Actions onCancel={onClose} primary={t('boards.create')} onPrimary={create} busy={busy} />
      </form>
    </ModalDialog>
  );
}

export function RenameBoardDialog({
  tenant,
  board,
  onClose,
  onGone,
}: {
  tenant: string;
  board: BoardSummary;
  onClose: () => void;
  onGone: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState(board.title);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = (): void => {
    setError(null);
    setFailure(null);
    setBusy(true);
    api
      .getBoard(tenant, board.uid)
      .then((head) => {
        const spec: BoardSpec = { ...head.spec, title: name };
        const fields = checkBoardSpec(spec);
        if (fields.length > 0) {
          setBusy(false);
          setError(titleError(fields) ?? fieldMessage(fields[0]?.messageKey ?? ''));
          return;
        }
        return api.saveBoard(tenant, board.uid, head.etag, spec).then((r) => {
          queryClient.setQueryData(['board', tenant, board.uid], r.board);
          void queryClient.invalidateQueries({ queryKey: ['boards'] });
          setBusy(false);
          onClose();
        });
      })
      .catch((e: unknown) => {
        setBusy(false);
        if (e instanceof BoardConflictError) setFailure(t('boards.renameConflict'));
        else if (isApiError(e, 'notFound')) onGone();
        else if (isApiError(e, 'invalid') && titleError(e.fields) !== null) {
          setError(titleError(e.fields));
        } else setFailure(t('boards.failed'));
      });
  };

  return (
    <ModalDialog
      title={t('boards.renameTitle')}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <form
        className={cx(styles['form'])}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <TextField
          label={t('boards.name')}
          value={name}
          onChange={setName}
          error={error}
          autoFocus
          autoComplete="off"
        />
        <Failure text={failure} />
        <Actions onCancel={onClose} primary={t('boards.save')} onPrimary={save} busy={busy} />
      </form>
    </ModalDialog>
  );
}

export function DeleteBoardDialog({
  tenant,
  board,
  onClose,
}: {
  tenant: string;
  board: BoardSummary;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = (): void => {
    queryClient.removeQueries({ queryKey: ['board', tenant, board.uid] });
    void queryClient.invalidateQueries({ queryKey: ['boards'] });
    onClose();
  };

  const remove = (): void => {
    setFailure(null);
    setBusy(true);
    api
      .getBoard(tenant, board.uid)
      .then((head) => api.deleteBoard(tenant, board.uid, head.etag))
      .then(
        () => {
          setBusy(false);
          done();
        },
        (e: unknown) => {
          setBusy(false);
          if (e instanceof BoardConflictError) setFailure(t('boards.deleteConflict'));
          else if (isApiError(e, 'notFound')) done();
          else setFailure(t('boards.failed'));
        },
      );
  };

  return (
    <ModalDialog
      title={t('boards.deleteTitle')}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <p className={cx(styles['body'])}>{t('boards.deleteBody', { title: board.title })}</p>
      <Failure text={failure} />
      <Actions
        onCancel={onClose}
        primary={t('boards.deleteConfirm')}
        onPrimary={remove}
        busy={busy}
      />
    </ModalDialog>
  );
}
