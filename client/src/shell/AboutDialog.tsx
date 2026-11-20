/** "About Pulsus Dash": version, build and licence. */
import { t } from '../i18n/t';
import { Button } from '../kit/Button';
import { ModalDialog } from '../kit/Dialog';
import styles from './UserMenu.module.css';
import { cx } from '../kit/cx';

const GIT_SHA_LENGTH = 12;

export function buildId(sha: string | undefined): string {
  return sha === undefined || sha === '' ? t('about.dev') : sha.slice(0, GIT_SHA_LENGTH);
}

export function AboutDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ModalDialog title={t('about.title')} isOpen={isOpen} onOpenChange={onOpenChange}>
      <p className={cx(styles['aboutLine'])}>{t('about.version', { version: __APP_VERSION__ })}</p>
      <p className={cx(styles['aboutLine'])}>
        {t('about.build', { sha: buildId(import.meta.env.VITE_GIT_SHA) })}
      </p>
      <p className={cx(styles['aboutLine'])}>{t('about.licence')}</p>
      <div className={cx(styles['aboutActions'])}>
        <Button
          variant="primary"
          onPress={() => {
            onOpenChange(false);
          }}
        >
          {t('about.close')}
        </Button>
      </div>
    </ModalDialog>
  );
}
