/**
 * The page shown when a route fails to load (§4.3 of plan #57). Retry is the first focusable
 * control: it drops the cached session and revalidates; on success the shell renders and focus
 * moves to `main`.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRevalidator } from 'react-router';
import { useShellFocusRequest } from '../app/providers';
import { t } from '../i18n/t';
import { Button } from '../kit/Button';
import { usePageTitle } from '../shell/PageTitle';
import styles from './pages.module.css';
import { cx } from '../kit/cx';

export function ErrorPage({ kind }: { kind: 'session' | 'generic' }) {
  const title = kind === 'session' ? t('error.session') : t('error.generic');
  usePageTitle(title);
  const queryClient = useQueryClient();
  const revalidator = useRevalidator();
  const focus = useShellFocusRequest();
  const retry = (): void => {
    queryClient.removeQueries({ queryKey: ['session'] });
    focus.request();
    void revalidator.revalidate();
  };
  return (
    <main id="main" tabIndex={-1} className={cx(styles['standalone'])}>
      <h1 className={cx(styles['standaloneTitle'])}>{title}</h1>
      <p className={cx(styles['muted'])}>
        {kind === 'session' ? t('error.sessionDetail') : t('error.genericDetail')}
      </p>
      <Button variant="primary" onPress={retry}>
        {t('error.retry')}
      </Button>
    </main>
  );
}
