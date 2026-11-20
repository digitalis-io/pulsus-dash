import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApi } from './api';
import { App } from './app/App';
import { createQueryClient } from './app/queryClient';
import { createAppRouter, type RouterDeps } from './app/router';
import { browserTimeZone } from './i18n/format';
import { createClock } from './state/clock';
import {
  applyTheme,
  prefersLightNow,
  readThemePref,
  resolveTheme,
  safeStorage,
} from './theme/theme';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/global.css';

applyTheme(resolveTheme(readThemePref(safeStorage()), prefersLightNow()));

// React Aria injects an inline <style> (touch-action for pressable elements) unless an element with
// this id exists. The CSP forbids inline styles, so the rule is in global.css and this marks it.
const pressStyle = document.createElement('meta');
pressStyle.id = 'react-aria-pressable-style';
document.head.append(pressStyle);

const deps: RouterDeps = {
  api: createApi(),
  queryClient: createQueryClient(),
  clock: createClock(),
  timeZone: browserTimeZone(),
};
const router = createAppRouter(deps, { kind: 'browser' });

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');
createRoot(root).render(
  <StrictMode>
    <App deps={deps} router={router} />
  </StrictMode>,
);
