/**
 * The user menu (D9): identity, theme (Dark, Light, System), About and Sign out (VL-001).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button, MenuTrigger } from 'react-aria-components';
import { useNavigate } from 'react-router';
import { useApi, useSession } from '../app/providers';
import type { Role } from '../api/types';
import { t, type MessageId } from '../i18n/t';
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

export function UserMenu() {
  const session = useSession();
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pref, setPref } = useTheme();
  const [about, setAbout] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { user } = session;

  const signOut = (): void => {
    api.signOut().then(
      () => {
        queryClient.clear();
        void navigate('/signed-out');
      },
      () => {
        queryClient.clear();
        void navigate('/signed-out');
      },
    );
  };

  return (
    <>
      <MenuTrigger>
        <Button
          ref={triggerRef}
          aria-label={t('user.menu', { name: user.name })}
          className={cx(styles['avatar'])}
        >
          <span aria-hidden="true">{initials(user.name)}</span>
        </Button>
        <Popover placement="bottom end">
          <div className={cx(styles['identity'])}>
            <p className={cx(styles['name'])}>{user.name}</p>
            <p className={cx(styles['email'])}>{user.email}</p>
            <p className={cx(styles['role'])}>{t(ROLE_LABEL[user.role])}</p>
          </div>
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
              <MenuItem id="signOut" icon={<Icon name="log-out" />} onAction={signOut}>
                {t('user.signOut')}
              </MenuItem>
            </MenuSection>
          </Menu>
        </Popover>
      </MenuTrigger>
      <AboutDialog
        isOpen={about}
        onOpenChange={(open) => {
          setAbout(open);
          // The menu item that opened the dialog is gone; return focus to the menu button.
          if (!open) requestAnimationFrame(() => triggerRef.current?.focus());
        }}
      />
    </>
  );
}
