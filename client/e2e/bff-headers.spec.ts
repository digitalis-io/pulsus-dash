import { expect, test } from '@playwright/test';
import { CSP } from '../config/headers.ts';
import { NEEDS_BFF, PREVIEW } from './bff.ts';
import { waitReady } from './helpers.ts';

/** The document headers of plan #59 B.4 other than the CSP (T18-002). */
const DOCUMENT_HEADERS: Readonly<Record<string, string>> = {
  'reporting-endpoints': 'csp="/api/dash/v1/csp-report"',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy':
    'camera=(), geolocation=(), microphone=(self), usb=(), payment=(), gamepad=(self)',
  'cache-control': 'no-cache',
  'content-type': 'text/html; charset=utf-8',
};

test.describe('e2e:bff-headers', () => {
  test.skip(PREVIEW, NEEDS_BFF);

  test('the BFF serves documents and assets with the T18-002 headers', async ({
    page,
    request,
  }) => {
    const doc = await request.get('/', { headers: { Accept: 'text/html' } });
    expect(doc.status()).toBe(200);
    const h = doc.headers();
    expect(h['content-security-policy']).toBe(CSP);
    for (const [k, v] of Object.entries(DOCUMENT_HEADERS)) expect(h[k], k).toBe(v);
    const index = await doc.text();

    const scripts: string[] = [];
    page.on('request', (r) => {
      if (/^\/assets\/[^/]+\.js$/.test(new URL(r.url()).pathname)) scripts.push(r.url());
    });
    await page.goto('/t/demo/boards');
    await waitReady(page, '/t/demo/boards');
    const first = scripts[0];
    expect(first, 'no /assets/*.js request from the page').toBeDefined();
    const asset = await request.get(first ?? '', { headers: { 'Accept-Encoding': 'br' } });
    expect(asset.status()).toBe(200);
    expect(asset.headers()['content-encoding']).toBe('br');
    expect(asset.headers()['cache-control']).toContain('immutable');

    const deep = await request.get('/t/demo/boards', { headers: { Accept: 'text/html' } });
    expect(deep.status()).toBe(200);
    expect(await deep.text()).toBe(index);

    const api = await request.get('/api/nope', { headers: { Accept: 'text/html' } });
    expect(api.status()).toBe(404);
    expect(await api.json()).toEqual({ error: { code: 'not_found', message: 'not found' } });
  });
});
