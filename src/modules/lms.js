import { readFile } from 'node:fs/promises';

import { launchProfile } from '../lib/browser.js';
import { CookieJar, readSetCookies } from '../lib/cookies.js';
import { CliError, invalidArgument } from '../lib/errors.js';
import { enforceActionCooldown, paceRequest } from '../lib/rate-limit.js';
import { loadState, saveState } from '../lib/state.js';
import {
  extractMoodleConfig,
  formatQuizAsText,
  isLmsAuthenticatedHtml,
  parseCalendarEventsAjax,
  parseCourseSectionsAndTasks,
  parseEnrolledCoursesAjax,
  parseLmsCategories,
  parseLmsSearchCourses,
  parseQuizOverviewHtml,
  parseQuizQuestionsHtml
} from '../parsers/lms-parser.js';

const LMS_BASE_URL = (process.env.SYSU_LMS_BASE_URL || 'https://lms.sysu.edu.cn').replace(/\/+$/, '');
const LMS_LOGIN_HINT = 'Run `sysu-cli lms login` to authenticate with lms.sysu.edu.cn in the browser.';

class LmsClient {
  constructor({ baseUrl = LMS_BASE_URL, jar, sesskey = null, session = null, mockTable = null } = {}) {
    this.baseUrl = baseUrl;
    this.jar = jar ?? new CookieJar();
    this.sesskey = sesskey;
    this.session = session;
    this.mockTable = mockTable;
  }

  static async create({ requireAuth = true } = {}) {
    if (process.env.SYSU_BACKEND === 'mock') {
      if (requireAuth && process.env.SYSU_MOCK_LOGGED_OUT === '1') {
        throw new CliError('LOGIN_REQUIRED', 'Mock LMS session is logged out.', { hint: LMS_LOGIN_HINT });
      }
      const file = process.env.SYSU_MOCK_FILE;
      const mockTable = file ? JSON.parse(await readFile(file, 'utf8')) : {};
      return new LmsClient({
        jar: new CookieJar(),
        sesskey: 'mock-sesskey',
        mockTable
      });
    }

    const session = (await loadState()) ?? {};
    const jar = new CookieJar(session.cookies ?? []);
    const client = new LmsClient({
      jar,
      sesskey: session.lmsSesskey ?? null,
      session
    });

    if (requireAuth && !client.sesskey) {
      await client.ensureAuthenticated();
    }

    return client;
  }

  async persistSession() {
    if (!this.session) return;
    this.session = {
      ...this.session,
      cookies: this.jar.toJSON(),
      ...(this.sesskey ? { lmsSesskey: this.sesskey } : {})
    };
    await saveState(this.session).catch(() => {});
  }

  async ensureAuthenticated() {
    if (this.mockTable) return;

    // 1. Check /my/courses.php or follow CAS SSO
    const myRes = await this.fetchRaw('/my/courses.php', { followRedirects: true });
    if (isLmsAuthenticatedHtml(myRes.text)) {
      const cfg = extractMoodleConfig(myRes.text);
      if (cfg?.sesskey) {
        this.sesskey = cfg.sesskey;
        await this.persistSession();
      }
      return;
    }

    // 2. Try CAS login flow using existing CAS cookies
    const casRes = await this.fetchRaw('/login/index.php?authCAS=CAS', { followRedirects: true });
    if (isLmsAuthenticatedHtml(casRes.text)) {
      const cfg = extractMoodleConfig(casRes.text);
      if (cfg?.sesskey) {
        this.sesskey = cfg.sesskey;
        await this.persistSession();
        return;
      }
    }

    throw new CliError('LOGIN_REQUIRED', 'SYSU LMS session is not authenticated or has expired.', {
      hint: LMS_LOGIN_HINT
    });
  }

  async fetchRaw(pathOrUrl, { method = 'GET', headers = {}, body, followRedirects = true } = {}) {
    await paceRequest('lms', 400);
    let url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;

    let currentMethod = method.toUpperCase();
    let currentBody = body;

    for (let hop = 0; hop < 10; hop += 1) {
      const cookieHeader = this.jar.header(url);
      let res;
      try {
        res = await fetch(url, {
          method: currentMethod,
          redirect: 'manual',
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            ...headers
          },
          body: currentBody,
          signal: AbortSignal.timeout(15000)
        });
      } catch (error) {
        throw new CliError('NETWORK_ERROR', `Failed to reach ${url}: ${error.message}`, {
          hint: 'Check network or VPN connectivity to lms.sysu.edu.cn.',
          cause: error
        });
      }

      this.jar.store(url, readSetCookies(res.headers));
      const loc = res.headers.get('location');
      if (followRedirects && loc && res.status >= 300 && res.status < 400) {
        url = new URL(loc, url).href;
        if (res.status === 301 || res.status === 302 || res.status === 303) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        continue;
      }

      const text = await res.text();
      const cfg = extractMoodleConfig(text);
      if (cfg?.sesskey && isLmsAuthenticatedHtml(text)) {
        this.sesskey = cfg.sesskey;
      }
      return {
        status: res.status,
        url,
        location: loc ? new URL(loc, url).href : null,
        text
      };
    }

    throw new CliError('UPSTREAM_ERROR', `Exceeded redirect hops for ${pathOrUrl}.`);
  }

  async getHtml(pathOrUrl, { requireAuth = true } = {}) {
    if (this.mockTable) {
      const cleanPath = pathOrUrl.startsWith(this.baseUrl)
        ? pathOrUrl.slice(this.baseUrl.length)
        : pathOrUrl;
      const key = `LMS GET ${cleanPath}`;
      const fallbackKey = `LMS GET ${cleanPath.split('&')[0]}`;
      const hit = this.mockTable[key] ?? this.mockTable[fallbackKey];
      if (hit === undefined) {
        throw new CliError('UPSTREAM_ERROR', `No mock LMS fixture for "${key}"`);
      }
      return typeof hit === 'string' ? hit : JSON.stringify(hit);
    }

    let res = await this.fetchRaw(pathOrUrl, { followRedirects: true });
    if (requireAuth && (res.url.includes('cas.sysu.edu.cn') || res.url.includes('/login/index.php'))) {
      await this.ensureAuthenticated();
      res = await this.fetchRaw(pathOrUrl, { followRedirects: true });
    }
    if (requireAuth && (res.url.includes('cas.sysu.edu.cn') || res.url.includes('/login/index.php'))) {
      throw new CliError('LOGIN_REQUIRED', 'SYSU LMS redirected to login page.', {
        hint: LMS_LOGIN_HINT
      });
    }
    if (this.jar.dirty) {
      await this.persistSession();
    }
    return res.text;
  }

  async callAjax(methodname, args = {}) {
    if (this.mockTable) {
      const key = `LMS AJAX ${methodname}`;
      const hit = this.mockTable[key];
      if (hit === undefined) {
        throw new CliError('UPSTREAM_ERROR', `No mock LMS AJAX fixture for "${key}"`);
      }
      return hit;
    }

    if (!this.sesskey) {
      await this.ensureAuthenticated();
    }

    const invokeOnce = async () => {
      const url = `/lib/ajax/service.php?sesskey=${encodeURIComponent(this.sesskey)}&info=${encodeURIComponent(methodname)}`;
      const res = await this.fetchRaw(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ index: 0, methodname, args }])
      });
      let parsed;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        return { error: true, rawText: res.text };
      }
      if (Array.isArray(parsed) && parsed[0]) {
        return parsed[0];
      }
      return { error: true, raw: parsed };
    };

    let result = await invokeOnce();
    if (result?.error) {
      await this.ensureAuthenticated();
      result = await invokeOnce();
    }

    if (result?.error) {
      throw new CliError(
        'UPSTREAM_ERROR',
        `LMS AJAX method "${methodname}" failed: ${result?.exception?.message || 'Unknown error'}`,
        { details: result }
      );
    }

    return result.data;
  }
}

export async function lmsLogin({ browser, timeoutSec = 240 } = {}) {
  const existing = (await loadState()) ?? {};

  // First try silent CAS SSO if existing cookies are present
  if (Array.isArray(existing.cookies) && existing.cookies.length > 0 && process.env.SYSU_BACKEND !== 'mock') {
    try {
      const client = new LmsClient({
        jar: new CookieJar(existing.cookies),
        session: existing
      });
      await client.ensureAuthenticated();
      if (client.sesskey) {
        const lmsUpdatedAt = new Date().toISOString();
        await saveState({
          ...existing,
          cookies: client.jar.toJSON(),
          lmsSesskey: client.sesskey,
          lmsUpdatedAt
        });
        return {
          authenticated: true,
          mode: 'cas-sso',
          lmsUpdatedAt
        };
      }
    } catch {
      // Fall through to interactive browser login
    }
  }

  const { context, browser: chosen } = await launchProfile({
    browser: browser ?? existing.browser,
    headless: false
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${LMS_BASE_URL}/login/index.php?authCAS=CAS`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(() => {});

    const deadline = Date.now() + timeoutSec * 1000;
    let lmsSesskey = null;

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new CliError('AUTH_LOGIN_INCOMPLETE', 'Browser window was closed before LMS login completed.', {
          hint: LMS_LOGIN_HINT
        });
      }
      const currentUrl = page.url();
      if (currentUrl.includes('lms.sysu.edu.cn') && !currentUrl.includes('/login/')) {
        const info = await page
          .evaluate(() => {
            try {
              const hasLogout = Boolean(document.querySelector('a[href*="/login/logout.php"]'));
              const isGuest = document.body?.innerText?.includes('您正在用访客帐号访问');
              const sesskey = window.M?.cfg?.sesskey || null;
              return { hasLogout, isGuest, sesskey };
            } catch {
              return null;
            }
          })
          .catch(() => null);

        if (info?.hasLogout && !info?.isGuest && info?.sesskey) {
          lmsSesskey = info.sesskey;
          break;
        }
      }
      await page.waitForTimeout(1000);
    }

    if (!lmsSesskey) {
      throw new CliError('AUTH_LOGIN_TIMEOUT', `Timed out after ${timeoutSec}s waiting for lms.sysu.edu.cn login.`, {
        hint: LMS_LOGIN_HINT
      });
    }

    const cookies = await context.cookies();
    const lmsUpdatedAt = new Date().toISOString();
    await saveState({
      ...existing,
      browser: chosen.id,
      cookies,
      lmsSesskey,
      lmsUpdatedAt
    });

    return {
      authenticated: true,
      mode: 'browser',
      browser: chosen.id,
      lmsUpdatedAt
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function listLmsCategories({ raw = false } = {}) {
  const client = await LmsClient.create({ requireAuth: false });
  const html = await client.getHtml('/course/index.php', { requireAuth: false });
  const categories = parseLmsCategories(html);
  return {
    count: categories.length,
    categories,
    ...(raw ? { raw: html } : {})
  };
}

export async function searchLmsCourses({ query, raw = false } = {}) {
  const q = String(query ?? '').trim();
  if (!q) {
    throw invalidArgument('Missing --query <keyword> for `sysu-cli lms search`.');
  }
  const client = await LmsClient.create({ requireAuth: false });
  const html = await client.getHtml(`/course/search.php?search=${encodeURIComponent(q)}`, { requireAuth: false });
  const courses = parseLmsSearchCourses(html);
  return {
    query: q,
    count: courses.length,
    courses,
    ...(raw ? { raw: html } : {})
  };
}

export async function listLmsCourses({ status = 'all', search, raw = false } = {}) {
  const classification = String(status || 'all').toLowerCase();
  if (!['all', 'inprogress', 'past', 'future'].includes(classification)) {
    throw invalidArgument('Invalid --status <all|inprogress|past|future> for `sysu-cli lms courses`.');
  }

  const client = await LmsClient.create({ requireAuth: true });
  const ajaxData = await client.callAjax('core_course_get_enrolled_courses_by_timeline_classification', {
    offset: 0,
    limit: 100,
    classification,
    sort: 'fullname'
  });

  let courses = parseEnrolledCoursesAjax(ajaxData);
  if (search) {
    const q = String(search).trim().toLowerCase();
    courses = courses.filter(
      (c) => c.fullname.toLowerCase().includes(q) || c.shortname.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)
    );
  }

  return {
    status: classification,
    searchFilter: search ?? null,
    count: courses.length,
    courses,
    ...(raw ? { raw: ajaxData } : {})
  };
}

export async function listLmsDeadlines({ days = 30, raw = false } = {}) {
  const numDays = Number(days ?? 30);
  if (!Number.isFinite(numDays) || numDays <= 0) {
    throw invalidArgument('Invalid --days <number> for `sysu-cli lms deadlines`.');
  }

  const client = await LmsClient.create({ requireAuth: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const ajaxData = await client.callAjax('core_calendar_get_action_events_by_timesort', {
    limitnum: 50,
    timesortfrom: nowSec - 86400 * 3,
    timesortto: nowSec + Math.round(numDays * 86400)
  });

  const deadlines = parseCalendarEventsAjax(ajaxData);
  return {
    days: numDays,
    count: deadlines.length,
    deadlines,
    ...(raw ? { raw: ajaxData } : {})
  };
}

async function openUrlsInBrowser(urls = [], { browser } = {}) {
  if (urls.length === 0) return { openedCount: 0, urls: [] };
  if (process.env.SYSU_BACKEND === 'mock') {
    return { openedCount: urls.length, urls };
  }

  await enforceActionCooldown('lms.open', 3000);
  const existing = (await loadState()) ?? {};
  const { context, browser: chosen } = await launchProfile({
    browser: browser ?? existing.browser,
    headless: false
  });

  if (Array.isArray(existing.cookies) && existing.cookies.length > 0) {
    await context.addCookies(existing.cookies).catch(() => {});
  }

  for (let i = 0; i < urls.length; i += 1) {
    const page = i === 0 ? (context.pages()[0] ?? await context.newPage()) : await context.newPage();
    await page.goto(urls[i], { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    if (i + 1 < urls.length) {
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  return {
    openedCount: urls.length,
    browser: chosen.id,
    urls
  };
}

export async function listLmsTasks({
  course,
  type = 'all',
  todo = false,
  section,
  open = false,
  limit = 5,
  browser,
  raw = false
} = {}) {
  const courseId = String(course ?? '').trim();
  if (!courseId || !/^\d+$/.test(courseId)) {
    throw invalidArgument('Missing or invalid --course <courseId> for `sysu-cli lms tasks` (e.g. --course 59).');
  }

  const client = await LmsClient.create({ requireAuth: false });
  let html;
  if (section !== undefined && section !== null) {
    html = await client.getHtml(`/course/view.php?id=${courseId}&section=${encodeURIComponent(section)}`, {
      requireAuth: false
    });
  } else {
    html = await client.getHtml(`/course/view.php?id=${courseId}`, { requireAuth: false });
    if (html.includes('lms.sysu.edu.cn/enrol/index.php') || html.includes('此课程目前并不对学生开放')) {
      // Retry with authenticated session
      await client.ensureAuthenticated();
      html = await client.getHtml(`/course/view.php?id=${courseId}`, { requireAuth: true });
    }
  }

  const initial = parseCourseSectionsAndTasks(html, {
    sectionNumberFallback: section !== undefined ? Number(section) : null
  });

  let allSections = [...initial.sections];
  let allTasks = [...initial.tasks];

  // If course uses one-section-per-page (coursedisplay=1) and user didn't filter to a single section,
  // fetch the linked sections that had 0 inline activities on the main page (capped at 12 sections).
  if (section === undefined && initial.linkedSections.length > 0) {
    const sectionsNeedingFetch = initial.linkedSections.filter((ls) => {
      const existingSec = initial.sections.find((s) => s.sectionNumber === ls.sectionNumber);
      return !existingSec || existingSec.taskCount === 0;
    });

    for (const ls of sectionsNeedingFetch.slice(0, 12)) {
      const secHtml = await client.getHtml(`/course/view.php?id=${courseId}&section=${ls.sectionNumber}`, {
        requireAuth: false
      });
      const parsedSec = parseCourseSectionsAndTasks(secHtml, { sectionNumberFallback: ls.sectionNumber });
      const mergedTasks = parsedSec.tasks.map((t) => ({
        ...t,
        sectionNumber: ls.sectionNumber,
        sectionName: ls.sectionName || t.sectionName
      }));
      allTasks.push(...mergedTasks);

      const idx = allSections.findIndex((s) => s.sectionNumber === ls.sectionNumber);
      const secEntry = {
        sectionNumber: ls.sectionNumber,
        sectionName: ls.sectionName,
        taskCount: mergedTasks.length,
        tasks: mergedTasks
      };
      if (idx >= 0) allSections[idx] = secEntry;
      else allSections.push(secEntry);
    }
  }

  // Deduplicate tasks by cmid
  const seenCmid = new Set();
  let filteredTasks = allTasks.filter((t) => {
    if (seenCmid.has(t.cmid)) return false;
    seenCmid.add(t.cmid);
    return true;
  });

  const typeFilter = String(type || 'all').toLowerCase();
  if (typeFilter !== 'all') {
    filteredTasks = filteredTasks.filter(
      (t) => t.type === typeFilter || t.category === typeFilter
    );
  }

  if (todo) {
    filteredTasks = filteredTasks.filter((t) => t.completed === false);
  }

  const urls = filteredTasks.map((t) => t.url).filter(Boolean);
  let opened = null;
  if (open) {
    const maxOpen = Math.min(Math.max(Number(limit) || 5, 1), 10);
    opened = await openUrlsInBrowser(urls.slice(0, maxOpen), { browser });
  }

  return {
    courseId,
    courseTitle: initial.courseTitle,
    typeFilter,
    todoOnly: Boolean(todo),
    sectionFilter: section !== undefined ? Number(section) : null,
    taskCount: filteredTasks.length,
    urls,
    tasks: filteredTasks,
    ...(opened ? { opened } : {}),
    ...(raw ? { rawSections: allSections } : {})
  };
}

export async function getLmsQuiz({ id, attempt, start = false, raw = false } = {}) {
  const rawInput = String(id ?? '').trim();
  if (!rawInput) {
    throw invalidArgument('Missing --id <quizCmid or quizUrl> for `sysu-cli lms quiz`.');
  }

  const client = await LmsClient.create({ requireAuth: false });

  // Determine whether input is a direct attempt/review URL, a view.php URL, or a numeric cmid
  let overview = null;
  let targetUrl = null;
  let cmid = null;

  if (/^\d+$/.test(rawInput)) {
    cmid = rawInput;
  } else if (rawInput.includes('/mod/quiz/attempt.php') || rawInput.includes('/mod/quiz/review.php')) {
    targetUrl = rawInput;
    cmid = rawInput.match(/[?&]cmid=(\d+)/)?.[1] ?? null;
  } else {
    cmid = rawInput.match(/[?&]id=(\d+)/)?.[1] ?? null;
  }

  if (!targetUrl) {
    if (!cmid) {
      throw invalidArgument(`Could not parse quiz cmid from "${rawInput}". Pass --id <cmid> (e.g. --id 196).`);
    }
    let viewHtml = await client.getHtml(`/mod/quiz/view.php?id=${cmid}`, { requireAuth: false });
    if (viewHtml.includes('<title>重定向</title>') || viewHtml.includes('/login/index.php')) {
      await client.ensureAuthenticated();
      viewHtml = await client.getHtml(`/mod/quiz/view.php?id=${cmid}`, { requireAuth: true });
    }
    overview = parseQuizOverviewHtml(viewHtml);

    if (attempt) {
      const matched = overview.attempts.find((a) => a.attemptId === String(attempt));
      targetUrl = matched
        ? matched.url
        : `${LMS_BASE_URL}/mod/quiz/attempt.php?attempt=${encodeURIComponent(attempt)}&cmid=${encodeURIComponent(cmid)}`;
    } else {
      const inProgress = overview.attempts.find((a) => a.mode === 'attempt');
      const finished = overview.attempts[overview.attempts.length - 1];
      if (inProgress) {
        targetUrl = inProgress.url;
      } else if (finished) {
        targetUrl = finished.url.includes('showall=') ? finished.url : `${finished.url}&showall=1`;
      } else if (start && overview.canStartAttempt) {
        const sesskey = overview.sesskey || client.sesskey;
        const startRes = await client.fetchRaw('/mod/quiz/startattempt.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ cmid: String(cmid), sesskey: String(sesskey ?? '') }).toString(),
          followRedirects: true
        });
        targetUrl = startRes.url;
      }
    }
  }

  if (!targetUrl) {
    return {
      cmid,
      quizTitle: overview?.title ?? '',
      intro: overview?.intro ?? '',
      rules: overview?.rules ?? [],
      attempts: overview?.attempts ?? [],
      canStartAttempt: Boolean(overview?.canStartAttempt),
      questionCount: 0,
      questions: [],
      text: overview
        ? `# ${overview.title}\n${overview.intro || ''}\n${(overview.rules || []).join('\n')}\n(当前尚无作答记录；如需开始作答并提取题目，请追加 --start 参数)`.trim()
        : ''
    };
  }

  const relativeOrFull = targetUrl.startsWith(LMS_BASE_URL)
    ? targetUrl.slice(LMS_BASE_URL.length)
    : targetUrl;
  const firstPageHtml = await client.getHtml(relativeOrFull, { requireAuth: false });
  const firstParsed = parseQuizQuestionsHtml(firstPageHtml);
  const allQuestions = [...firstParsed.questions];

  // Fetch extra pages if multi-page quiz attempt (capped at 15 pages)
  for (const extra of firstParsed.extraPageUrls.slice(0, 15)) {
    const extraPath = extra.url.startsWith(LMS_BASE_URL)
      ? extra.url.slice(LMS_BASE_URL.length)
      : extra.url;
    const pageHtml = await client.getHtml(extraPath, { requireAuth: false });
    const parsedPage = parseQuizQuestionsHtml(pageHtml);
    for (const q of parsedPage.questions) {
      if (!allQuestions.some((existing) => existing.questionId === q.questionId)) {
        allQuestions.push(q);
      }
    }
  }

  const quizTitle = overview?.title || firstParsed.pageTitle;
  const text = formatQuizAsText(quizTitle, allQuestions);

  return {
    cmid,
    quizTitle,
    ...(overview?.intro ? { intro: overview.intro } : {}),
    ...(overview?.rules?.length ? { rules: overview.rules } : {}),
    attemptUrl: targetUrl,
    questionCount: allQuestions.length,
    questions: allQuestions,
    text,
    ...(raw ? { rawHtml: firstPageHtml } : {})
  };
}
