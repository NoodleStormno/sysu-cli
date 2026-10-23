import { readFile } from 'node:fs/promises';

import { launchProfile } from '../lib/browser.js';
import { CookieJar } from '../lib/cookies.js';
import { CliError, invalidArgument } from '../lib/errors.js';
import { paceRequest } from '../lib/rate-limit.js';
import { loadState, saveState } from '../lib/state.js';

const USC_BASE_URL = (process.env.SYSU_USC_BASE_URL || 'https://usc.sysu.edu.cn/fwdt/gzld').replace(/\/+$/, '');
const PAY_BASE_URL = (process.env.SYSU_PAY_BASE_URL || 'https://pay.sysu.edu.cn/client/api').replace(/\/+$/, '');
const USC_LOGIN_HINT = 'Run `sysu-cli usc login` to authenticate with usc.sysu.edu.cn and pay.sysu.edu.cn in the browser.';

async function uscRequest(path, { method = 'GET' } = {}) {
  if (process.env.SYSU_BACKEND === 'mock') {
    if (process.env.SYSU_MOCK_LOGGED_OUT === '1') {
      throw new CliError('LOGIN_REQUIRED', 'Mock USC session is logged out.', { hint: USC_LOGIN_HINT });
    }
    const file = process.env.SYSU_MOCK_FILE;
    const table = file ? JSON.parse(await readFile(file, 'utf8')) : {};
    const key = `USC ${method.toUpperCase()} ${path}`;
    const fallbackKey = `USC ${method.toUpperCase()} ${path.split('?')[0]}`;
    const hit = table[key] ?? table[fallbackKey];
    if (hit === undefined) {
      throw new CliError('UPSTREAM_ERROR', `No mock USC fixture for "${key}"`);
    }
    return hit;
  }

  const session = await loadState();
  if (!session?.uscToken) {
    throw new CliError('LOGIN_REQUIRED', 'SYSU USC token is missing. Please log in to usc.sysu.edu.cn first.', {
      hint: USC_LOGIN_HINT
    });
  }

  await paceRequest('usc', 400);
  const sep = path.includes('?') ? '&' : '?';
  const url = `${USC_BASE_URL}${path.startsWith('/') ? path : `/${path}`}${sep}_t=${Date.now()}`;
  const jar = new CookieJar(session.cookies ?? []);
  const cookieHeader = jar.header(url);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json, text/plain, */*',
        Authorization: session.uscToken,
        'X-Access-Token': session.uscToken,
        'X-Version': 'v3',
        'X-Sign': String(Date.now()),
        'X-Tenant-Id': '0',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) sysu-cli/0.3',
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new CliError('NETWORK_ERROR', `Failed to reach USC (${url}): ${error.message}`, {
      hint: 'Check campus network or VPN connectivity to usc.sysu.edu.cn.',
      cause: error
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw new CliError('LOGIN_REQUIRED', `USC session expired (HTTP ${res.status}).`, {
      hint: USC_LOGIN_HINT
    });
  }

  const payload = await res.json().catch(() => null);
  if (!payload || payload.code === 401 || /Token失效|重新登录/.test(String(payload.message ?? ''))) {
    throw new CliError('LOGIN_REQUIRED', payload?.message || 'USC token expired.', {
      hint: USC_LOGIN_HINT
    });
  }
  return payload;
}

export async function uscLogin({ browser, timeoutSec = 240 } = {}) {
  const existing = (await loadState()) ?? {};
  const { context, browser: chosen } = await launchProfile({
    browser: browser ?? existing.browser,
    headless: false
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://usc.sysu.edu.cn/fwdt/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    const deadline = Date.now() + timeoutSec * 1000;
    let uscToken = null;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new CliError('AUTH_LOGIN_INCOMPLETE', 'Browser window was closed before USC login completed.', {
          hint: USC_LOGIN_HINT
        });
      }
      if (page.url().includes('usc.sysu.edu.cn')) {
        uscToken = await page
          .evaluate(() => {
            try {
              return localStorage.getItem('home_token');
            } catch {
              return null;
            }
          })
          .catch(() => null);
        if (uscToken) break;
      }
      await page.waitForTimeout(1000);
    }

    if (!uscToken) {
      throw new CliError('AUTH_LOGIN_TIMEOUT', `Timed out after ${timeoutSec}s waiting for usc.sysu.edu.cn token.`, {
        hint: USC_LOGIN_HINT
      });
    }

    // Warm up pay.sysu.edu.cn CAS session in the same browser context
    await page.goto('https://pay.sysu.edu.cn/client/api/client/auth/netId/login', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    }).catch(() => {});
    await page.waitForTimeout(1000);

    const cookies = await context.cookies();
    const uscUpdatedAt = new Date().toISOString();
    await saveState({
      ...existing,
      browser: chosen.id,
      cookies,
      uscToken,
      uscUpdatedAt
    });

    return {
      authenticated: true,
      browser: chosen.id,
      uscUpdatedAt
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function listUscServices({ search, page = 1, pageSize = 20, raw = false } = {}) {
  const keyword = String(search ?? '').trim();
  const path = keyword
    ? `/gateway/api/searchServicePage?key=${encodeURIComponent(keyword)}&pageNo=${page}&pageSize=${pageSize}`
    : `/gateway/api/queryServicePage?pageNo=${page}&pageSize=${pageSize}`;
  const payload = await uscRequest(path);
  const records = payload?.result?.records ?? payload?.result?.list ?? (Array.isArray(payload?.result) ? payload.result : []);

  const services = records.map((r) => ({
    id: String(r.id ?? r.serviceId ?? ''),
    name: String(r.serviceName ?? r.name ?? r.title ?? ''),
    department: String(r.deptName ?? r.departmentName ?? ''),
    category: String(r.typeName ?? r.categoryName ?? ''),
    summary: String(r.serviceIntro ?? r.description ?? '').replace(/<[^>]+>/g, '').trim()
  }));

  return {
    searchFilter: keyword || null,
    page: Number(page),
    pageSize: Number(pageSize),
    total: Number(payload?.result?.total ?? services.length),
    count: services.length,
    services,
    ...(raw ? { raw: payload } : {})
  };
}

export async function listUscTasks({ type = 'todo', page = 1, pageSize = 20, raw = false } = {}) {
  const normalized = String(type || 'todo').toLowerCase();
  const endpointMap = {
    todo: '/gateway/api/todolist',
    done: '/gateway/api/donelist',
    complete: '/gateway/api/completelist'
  };
  const endpoint = endpointMap[normalized];
  if (!endpoint) {
    throw invalidArgument(`Invalid --type "${type}". Supported: todo, done, complete.`);
  }

  const payload = await uscRequest(`${endpoint}?pageNo=${page}&pageSize=${pageSize}`);
  const records = payload?.result?.records ?? payload?.result?.list ?? (Array.isArray(payload?.result) ? payload.result : []);

  const tasks = records.map((r) => ({
    id: String(r.id ?? r.procInstId ?? r.taskId ?? ''),
    title: String(r.title ?? r.serviceName ?? r.procDefName ?? ''),
    status: String(r.statusName ?? r.status ?? normalized),
    applicant: String(r.applyUserName ?? r.createBy ?? ''),
    createdAt: String(r.createTime ?? r.applyTime ?? ''),
    updatedAt: String(r.updateTime ?? r.endTime ?? '')
  }));

  return {
    type: normalized,
    total: Number(payload?.result?.total ?? tasks.length),
    count: tasks.length,
    tasks,
    ...(raw ? { raw: payload } : {})
  };
}

export async function listUnpaidFees({ raw = false } = {}) {
  if (process.env.SYSU_BACKEND === 'mock') {
    if (process.env.SYSU_MOCK_LOGGED_OUT === '1') {
      throw new CliError('LOGIN_REQUIRED', 'Mock pay session is logged out.', { hint: USC_LOGIN_HINT });
    }
    const file = process.env.SYSU_MOCK_FILE;
    const table = file ? JSON.parse(await readFile(file, 'utf8')) : {};
    const payload = table['PAY GET /client/necessary/list'];
    if (!payload) {
      throw new CliError('UPSTREAM_ERROR', 'No mock pay fixture for PAY GET /client/necessary/list');
    }
    const list = Array.isArray(payload.data) ? payload.data : [];
    return {
      count: list.length,
      items: list,
      ...(raw ? { raw: payload } : {})
    };
  }

  const session = await loadState();
  if (!session?.cookies?.length) {
    throw new CliError('LOGIN_REQUIRED', 'SYSU payment hall session is missing.', { hint: USC_LOGIN_HINT });
  }

  await paceRequest('pay', 400);
  const jar = new CookieJar(session.cookies);
  const url = `${PAY_BASE_URL}/client/necessary/list`;
  const cookieHeader = jar.header(url);
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) sysu-cli/0.3',
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000)
  });

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new CliError('LOGIN_REQUIRED', 'SYSU payment hall (pay.sysu.edu.cn) session expired.', {
      hint: USC_LOGIN_HINT
    });
  }

  const payload = await res.json().catch(() => null);
  if (!payload || payload.code === 401 || payload.state === 401) {
    throw new CliError('LOGIN_REQUIRED', payload?.message || 'SYSU payment hall login required.', {
      hint: USC_LOGIN_HINT
    });
  }

  const items = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.result) ? payload.result : []);
  return {
    count: items.length,
    items,
    ...(raw ? { raw: payload } : {})
  };
}
