/**
 * The user menu (D9): identity, theme (Dark, Light, System), About and Sign out (VL-001). Sign out
 * is hidden when the session cannot sign out (the fixed local principal, D12).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button as AriaButton, MenuTrigger } from 'react-aria-components';
import { useNavigate } from 'react-router';
import { useApi, useSession } from '../app/providers';
import type { Role } from '../api/types';
import { t, type MessageId } from '../i18n/t';
import { Button } from '../kit/Button';
import { Icon, type IconName } from '../kit/Icon';
import { Menu, MenuItem, MenuSection } from '../kit/Menu';
import { Popover } from '../kit/Popover';
import { THEME_PREFS, type ThemePref } from '../theme/theme';
import { useTheme } from '../theme/useTheme';
import { AboutDialog } from './AboutDialog';
import styles from './UserMenu.module.css';
import { cx } from '../kit/cx';

const ROLE_LABEL: Readonly<Record<Role, MessageId>> = {
  admin: 'role.admin',
  editor: 'role.editor',
  viewer: 'role.viewer',
};

const THEME: Readonly<Record<ThemePref, { label: MessageId; icon: IconName }>> = {
  dark: { label: 'theme.dark', icon: 'moon' },
  light: { label: 'theme.light', icon: 'sun' },
  system: { label: 'theme.system', icon: 'monitor' },
};

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => w !== '')
    .slice(0, 2)
    .map((w) => w.slice(0, 1).toUpperCase())
    .join('');
}

/**
 * The avatar button's accessible name. It starts with the visible initials (WCAG 2.5.3, label in
 * name). If the name has no initials, it falls back to the menu's name.
 */
export function userMenuButtonLabel(name: string): string {
  const i = initials(name);
  return i === '' ? t('user.menu', { name }) : t('user.menuButton', { initials: i, name });
}

export function UserMenu() {
  const session = useSession();
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pref, setPref } = useTheme();
  const [about, setAbout] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { user } = session;

  // Only a confirmed sign-out clears the cached session and leaves the shell. A rejected one keeps
  // everything as it was and shows a recoverable alert with Retry.
  const signOut = (): void => {
    setSignOutFailed(false);
    api.signOut().then(
      () => {
        queryClient.clear();
        void navigate('/signed-out');
      },
      () => {
        setSignOutFailed(true);
      },
    );
  };

  return (
    <>
      <MenuTrigger>
        <AriaButton
          ref={triggerRef}
          aria-label={userMenuButtonLabel(user.name)}
          className={cx(styles['avatar'])}
        >
          <span aria-hidden="true">{initials(user.name)}</span>
        </AriaButton>
        <Popover placement="bottom end">
          <div className={cx(styles['identity'])}>
            <p className={cx(styles['name'])}>{user.name}</p>
            <p className={cx(styles['email'])}>{user.email}</p>
            <p className={cx(styles['role'])}>{t(ROLE_LABEL[user.role])}</p>
          </div>
          {/* MenuTrigger labels this menu by the trigger (aria-labelledby), which overrides aria-label. */}
          <Menu aria-label={t('user.menu', { name: user.name })}>
            <MenuSection title={t('user.theme')} selectionMode="single" selectedKeys={[pref]}>
              {THEME_PREFS.map((p) => (
                <MenuItem
                  key={p}
                  id={p}
                  icon={<Icon name={THEME[p].icon} />}
                  onAction={() => {
                    setPref(p);
                  }}
                >
                  {t(THEME[p].label)}
                </MenuItem>
              ))}
            </MenuSection>
            <MenuSection>
              <MenuItem
                id="about"
                icon={<Icon name="info" />}
                onAction={() => {
                  setAbout(true);
                }}
              >
                {t('user.about')}
              </MenuItem>
              {session.canSignOut && (
                <MenuItem id="signOut" icon={<Icon name="log-out" />} onAction={signOut}>
                  {t('user.signOut')}
                </MenuItem>
              )}
            </MenuSection>
          </Menu>
        </Popover>
      </MenuTrigger>
      {signOutFailed && (
        <div role="alert" className={cx(styles['alert'])}>
          <p className={cx(styles['alertText'])}>{t('user.signOutFailed')}</p>
          <div className={cx(styles['alertActions'])}>
            <Button
              variant="ghost"
              onPress={() => {
                setSignOutFailed(false);
                triggerRef.current?.focus();
              }}
            >
              {t('user.signOutDismiss')}
            </Button>
            <Button variant="primary" onPress={signOut} autoFocus>
              {t('error.retry')}
            </Button>
          </div>
        </div>
      )}
      <AboutDialog
        isOpen={about}
        serverVersion={session.server?.version ?? null}
        onOpenChange={(open) => {
          setAbout(open);
          // The menu item that opened the dialog is gone; return focus to the menu button.
          if (!open) requestAnimationFrame(() => triggerRef.current?.focus());
        }}
      />
    </>
  );
}
