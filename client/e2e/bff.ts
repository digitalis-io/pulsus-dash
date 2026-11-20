/** Shared by the specs that need the BFF servers of plan #59 §3.7. */

/** True under `E2E_SERVER=preview`, where only `vite preview` runs. */
export const PREVIEW = process.env['E2E_SERVER'] === 'preview';
export const NEEDS_BFF = 'needs the BFF servers (unset E2E_SERVER)';

/** The http-mode BFF and the Vite dev server. */
export const HTTP_BFF = 'http://localhost:4174';
export const DEV_SERVER = 'http://localhost:5174';

/** The version `make e2e-build` stamps on both binaries. */
export const E2E_VERSION = '0.1.0-e2e';
