import { readFileSync } from 'node:fs';

import { CookieJar, readSetCookies } from './cookies.js';
import { CliError, loginRequired, upstreamChanged } from './errors.js';
import { paceRequest } from './rate-limit.js';
import { loadState, saveState } from './state.js';

export const JWXT_ORIGIN = 'https://jwxt.sysu.edu.cn';
export const JWXT_BASE = `${JWXT_ORIGIN}/jwxt`;
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Thin JSON client for jwxt.sysu.edu.cn that replays the SPA's XHR conventions
 * using cookies captured by `sysu-cli auth login`. No browser is launched here.
 */
export class JwxtClient {
  constructor({ state, fetchImpl, persist = true } = {}) {
    this.state = state ?? null;
    this.jar = new CookieJar(state?.cookies ?? []);
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.persistEnabled = persist;
    this.requests = 0;
  }

  hasSession() {
    return this.jar.cookies.some((cookie) => /sysu\.edu\.cn$/i.test(cookie.domain.replace(/^\./, '')));
  }

  async loginStatus() {
    const json = await this.request('GET', '/api/login/status', { allowAnyCode: true, skipAuthCheck: true });
    return {
      loggedIn: Boolean(json?.data),
      upstreamCode: json?.code ?? null
    };
  }

  async get(path, { query, menuId, referer } = {}) {
    const json = await this.request('GET', path, { query, menuId, referer });
    return json.data;
  }

  async post(path, body, { query, menuId, referer } = {}) {
    const json = await this.request('POST', path, { query, body, menuId, referer });
    return json.data;
  }

  async request(method, path, options = {}) {
    if (!options.skipAuthCheck && !this.hasSession()) {
      throw loginRequired('No saved SYSU session was found.');
    }

    const url = buildUrl(path, options.query);
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': options.referer ?? `${JWXT_BASE}/`,
      'Origin': JWXT_ORIGIN,
      'moduleid': 'null',
      'menuid': options.menuId ?? 'null',
      'lastaccesstime': String(Date.now()),
      'User-Agent': 'Mozilla/5.0 (sysu-cli; +https://github.com/) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
    };
    const cookie = this.jar.header(url);
    if (cookie) headers.Cookie = cookie;
    let body;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json;charset=UTF-8';
      body = JSON.stringify(options.body);
    }

    let response;
    try {
      await paceRequest('jwxt', 250);
      this.requests += 1;
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(Number(process.env.SYSU_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
      });
    } catch (cause) {
      throw new CliError('NETWORK_ERROR', `Request to ${url.pathname} failed: ${cause?.message ?? cause}`, {
        hint: 'Check network access to jwxt.sysu.edu.cn (campus network or SYSU VPN may be required), then retry once.',
        cause
      });
    }

    this.jar.store(url, readSetCookies(response.headers));

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '';
      throw loginRequired('JWXT redirected to unified authentication.', { status: response.status, location: redactLocation(location) });
    }
    if (response.status === 401) {
      throw loginRequired('JWXT rejected the saved session (HTTP 401).');
    }
    if (response.status === 403) {
      throw new CliError('PERMISSION_DENIED', `JWXT returned HTTP 403 for ${url.pathname}.`, {
        hint: 'Confirm this account can open the same page in the JWXT web UI.'
      });
    }
    if (response.status === 429) {
      throw new CliError('RATE_LIMITED', 'JWXT rate-limited this client (HTTP 429).', {
        hint: 'Stop and wait several minutes before retrying. Do not loop.'
      });
    }

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (/cas\.sysu\.edu\.cn|统一身份认证|esc-sso/i.test(text)) {
        throw loginRequired('JWXT returned the unified-auth login page.');
      }
      throw upstreamChanged(`JWXT returned non-JSON content for ${url.pathname} (HTTP ${response.status}).`, {
        status: response.status,
        snippet: text.slice(0, 200)
      });
    }

    if (response.status >= 500) {
      throw new CliError('UPSTREAM_ERROR', `JWXT returned HTTP ${response.status} for ${url.pathname}.`, {
        hint: 'The school system may be busy or under maintenance. Retry later, once.',
        details: { status: response.status, upstreamCode: json?.code, upstreamMessage: json?.message }
      });
    }

    if (!options.allowAnyCode && json && typeof json === 'object' && 'code' in json && Number(json.code) !== 200) {
      const message = String(json.message ?? json.msg ?? '');
      if (Number(json.code) === 401 || /未登录|登录超时|重新登录|token/i.test(message)) {
        throw loginRequired(`JWXT reported: ${message || `code ${json.code}`}`);
      }
      throw new CliError('UPSTREAM_ERROR', `JWXT returned code ${json.code} for ${url.pathname}: ${message || 'no message'}`, {
        hint: 'Verify the arguments (term format is YYYY-N, e.g. 2025-1 = 2025-2026 first semester). Retry at most once.',
        details: { upstreamCode: json.code, upstreamMessage: message }
      });
    }

    return json;
  }

  async persist() {
    if (!this.persistEnabled || !this.jar.dirty || !this.state) return;
    await saveState({ ...this.state, cookies: this.jar.toJSON() });
    this.jar.dirty = false;
  }
}

export async function createClient() {
  if (process.env.SYSU_BACKEND === 'mock') {
    return new JwxtClient({
      state: mockState(),
      fetchImpl: createMockFetch(),
      persist: false
    });
  }
  const state = await loadState();
  return new JwxtClient({ state });
}

/**
 * Run `fn(client)` and persist refreshed cookies afterwards, even on failure.
 */
export async function withClient(fn) {
  const client = await createClient();
  try {
    return await fn(client);
  } finally {
    await client.persist().catch(() => {});
  }
}

export function buildUrl(path, query = {}) {
  const url = new URL(`${JWXT_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  url.searchParams.set('_t', String(Date.now()));
  return url;
}

function redactLocation(location) {
  return location.replace(/([?&](?:ticket|token|code)=)[^&]+/gi, '$1<redacted>');
}

// ---------------------------------------------------------------------------
// Mock backend (SYSU_BACKEND=mock). Fixture file maps "METHOD /path" or
// "METHOD /path?key=value" (without _t) to either a JSON body or
// { "$status": 302, "$headers": {...}, "$body": ... }.
// ---------------------------------------------------------------------------

function mockState() {
  if (process.env.SYSU_MOCK_LOGGED_OUT === '1') {
    return { cookies: [] };
  }
  return {
    browser: 'mock',
    cookies: [{ name: 'JSESSIONID', value: 'mock', domain: 'jwxt.sysu.edu.cn', path: '/', expires: -1 }]
  };
}

function createMockFetch() {
  const file = process.env.SYSU_MOCK_FILE;
  const routes = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return async (url, init = {}) => {
    const target = new URL(url);
    target.searchParams.delete('_t');
    const path = target.pathname.replace(/^\/jwxt/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    const search = target.searchParams.toString();
    const candidates = [
      ...(search ? [`${method} ${path}?${search}`] : []),
      `${method} ${path}`
    ];
    const key = candidates.find((candidate) => Object.hasOwn(routes, candidate));
    if (!key) {
      return new Response(JSON.stringify({ code: 404, message: `mock route missing: ${candidates[0]}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    const route = routes[key];
    if (route && typeof route === 'object' && '$status' in route) {
      const body = route.$body === undefined ? '' : (typeof route.$body === 'string' ? route.$body : JSON.stringify(route.$body));
      return new Response(route.$status >= 300 && route.$status < 400 ? null : body, {
        status: route.$status,
        headers: route.$headers ?? {}
      });
    }
    return new Response(JSON.stringify(route), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}
