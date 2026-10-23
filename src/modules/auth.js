import { rm } from 'node:fs/promises';

import { launchProfile } from '../lib/browser.js';
import { CliError, LOGIN_HINT } from '../lib/errors.js';
import { JWXT_BASE, JWXT_ORIGIN, createClient } from '../lib/jwxt.js';
import { profilesDir, statePath } from '../lib/paths.js';
import { deleteState, loadState, saveState } from '../lib/state.js';

export const CAS_ENTRY_URL = `${JWXT_BASE}/api/sso/cas/login?pattern=student-login`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 25 * 1000;

/**
 * Open a headed browser on the JWXT CAS entry. The user logs in (NetID +
 * captcha, or WeCom QR) themselves; we only wait until JWXT reports a session
 * and then export the cookies. Passwords never pass through sysu-cli.
 */
export async function login({ browser, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  if (process.env.SYSU_BACKEND === 'mock') {
    return { loggedIn: true, browser: 'mock', statePath: statePath(), backend: 'mock' };
  }
  const launched = await launchProfile({ browser, headless: false });
  const { context } = launched;
  process.stderr.write(`Opened ${launched.browser.label}. Finish SYSU unified-auth login in the window (timeout ${Math.round(timeoutMs / 1000)}s).\n`);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CAS_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const outcome = await waitForSession(context, page, timeoutMs);
    if (outcome === 'closed') {
      throw new CliError('AUTH_LOGIN_INCOMPLETE', 'The browser was closed before JWXT reported a logged-in session.', {
        hint: 'Run `sysu-cli auth login` again and keep the window open until it closes by itself.'
      });
    }
    if (outcome === 'timeout') {
      throw new CliError('AUTH_LOGIN_TIMEOUT', `Login did not finish within ${Math.round(timeoutMs / 1000)} seconds.`, {
        hint: 'Run `sysu-cli auth login` again (use `--timeout <seconds>` for more time).'
      });
    }
    const saved = await exportSession(context, launched.browser.id);
    return { loggedIn: true, browser: launched.browser.id, statePath: saved.file, cookieCount: saved.count };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Re-enter JWXT through CAS in a headless browser using the persistent
 * profile. This succeeds only while the unified-auth (CAS) session in the
 * profile is still valid; it never fills credentials.
 */
export async function refresh({ browser } = {}) {
  if (process.env.SYSU_BACKEND === 'mock') {
    return { loggedIn: true, refreshed: true, backend: 'mock' };
  }
  const launched = await launchProfile({ browser, headless: true });
  const { context } = launched;
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CAS_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const outcome = await waitForSession(context, page, REFRESH_TIMEOUT_MS);
    if (outcome !== 'authenticated') {
      throw new CliError('LOGIN_REQUIRED', 'The saved unified-auth session has expired; interactive login is needed.', {
        hint: 'Run `sysu-cli auth login` and complete login in the opened browser.',
        details: { finalHost: safeHost(page.url()) }
      });
    }
    const saved = await exportSession(context, launched.browser.id);
    return { loggedIn: true, refreshed: true, browser: launched.browser.id, cookieCount: saved.count };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function status() {
  const state = process.env.SYSU_BACKEND === 'mock' ? {} : await loadState();
  if (!state) {
    return { loggedIn: false, reason: 'session-missing', statePath: statePath(), hint: LOGIN_HINT };
  }
  const client = await createClient();
  if (!client.hasSession()) {
    return { loggedIn: false, reason: 'session-missing', statePath: statePath(), hint: LOGIN_HINT };
  }
  try {
    const result = await client.loginStatus();
    return {
      loggedIn: result.loggedIn,
      reason: result.loggedIn ? 'jwxt-session-active' : 'jwxt-session-expired',
      ...(state.savedAt ? { savedAt: state.savedAt } : {}),
      ...(result.loggedIn ? {} : { hint: LOGIN_HINT })
    };
  } finally {
    await client.persist().catch(() => {});
  }
}

export async function logout() {
  const hadState = Boolean(await loadState());
  await deleteState();
  try {
    await rm(profilesDir(), { recursive: true, force: true });
  } catch (cause) {
    throw new CliError('AUTH_LOGOUT_FAILED', 'Could not remove the sysu-cli browser profiles.', {
      hint: 'Close any sysu-cli browser window and retry `sysu-cli auth logout`.',
      cause
    });
  }
  return { loggedOut: true, hadSession: hadState };
}

async function waitForSession(context, page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let closed = false;
  context.once('close', () => { closed = true; });

  while (Date.now() < deadline) {
    if (closed || page.isClosed()) return 'closed';
    // Only probe once the browser is back on JWXT, so we never interfere with
    // the CAS page or its captcha.
    if (safeHost(page.url()) === new URL(JWXT_ORIGIN).host) {
      try {
        const response = await context.request.get(`${JWXT_BASE}/api/login/status?_t=${Date.now()}`, {
          headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
          maxRedirects: 0,
          timeout: 10000
        });
        if (response.ok()) {
          const json = await response.json().catch(() => null);
          if (json?.data) return 'authenticated';
        }
      } catch {
        // keep waiting
      }
    }
    await sleep(1500);
  }
  return 'timeout';
}

async function exportSession(context, browserId) {
  const storage = await context.storageState();
  const cookies = storage.cookies.filter((cookie) => /(^|\.)sysu\.edu\.cn$/i.test(cookie.domain.replace(/^\./, '')));
  const file = await saveState({ browser: browserId, savedAt: new Date().toISOString(), cookies, origins: [] });
  return { file, count: cookies.length };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
