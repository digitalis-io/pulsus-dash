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
import { applyPlatform } from './theme/platform';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/global.css';

applyTheme(resolveTheme(readThemePref(safeStorage()), prefersLightNow()));

// The platform UI face (VL-010, ADR-0035): on a failure the root keeps Inter.
try {
  applyPlatform(document.documentElement, navigator);
} catch (e) {
  console.warn(`pulsus platform face: ${e instanceof Error ? e.message : String(e)}`);
}

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

// Fault builds with `?probe=1` (plan #68 D2 §5): the e2e suite refetches and clears the queries
// through `__dashProbeQueries` (a release build has neither this block nor the global).
if (
  import.meta.env.VITE_ENGINE_FAULTS === '1' &&
  new URLSearchParams(location.search).get('probe') === '1'
) {
  (globalThis as { __dashProbeQueries?: unknown }).__dashProbeQueries = deps.queryClient;
}

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');
createRoot(root).render(
  <StrictMode>
    <App deps={deps} router={router} />
  </StrictMode>,
);
