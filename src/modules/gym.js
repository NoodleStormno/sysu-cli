import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { launchProfile } from '../lib/browser.js';
import { CookieJar, readSetCookies } from '../lib/cookies.js';
import { CliError, invalidArgument } from '../lib/errors.js';
import { enforceActionCooldown, paceRequest } from '../lib/rate-limit.js';
import { loadState, saveState } from '../lib/state.js';
import {
  computeSlotsHash,
  extractUuidFromJwt,
  generateBookingSignature,
  parseAvailableSlots,
  parseGymBookings,
  parseVenueTypes,
  selectFeeTemplate,
  solveSafelinePow
} from '../parsers/gym-parser.js';

const GYM_BASE_URL = (process.env.SYSU_GYM_BASE_URL || 'https://gym.sysu.edu.cn').replace(/\/+$/, '');
const GYM_LOGIN_HINT = 'Run `sysu-cli gym login` to authenticate with gym.sysu.edu.cn in the browser.';

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeDateStr(value) {
  if (!value) return null;
  if (value instanceof Date) return formatDate(value);
  return String(value).trim();
}

function addDays(baseDateStr, offsetDays) {
  const d = baseDateStr ? new Date(`${baseDateStr}T00:00:00`) : new Date();
  d.setDate(d.getDate() + offsetDays);
  return formatDate(d);
}

class GymClient {
  constructor({ baseUrl = GYM_BASE_URL, jar, token, botToken = null, userUuid, session = null, mockTable = null } = {}) {
    this.baseUrl = baseUrl;
    this.jar = jar ?? new CookieJar();
    this.token = token ?? null;
    this.botToken = botToken;
    this.userUuid = userUuid ?? (token ? extractUuidFromJwt(token) : null);
    this.session = session;
    this.mockTable = mockTable;
    this.serverTimeOffsetMs = 0;
  }

  serverNowMs() {
    return Date.now() + this.serverTimeOffsetMs;
  }

  serverNowSec() {
    return Math.floor(this.serverNowMs() / 1000);
  }

  serverNowIso() {
    return new Date(this.serverNowMs()).toISOString();
  }

  static async create() {
    if (process.env.SYSU_BACKEND === 'mock') {
      if (process.env.SYSU_MOCK_LOGGED_OUT === '1') {
        throw new CliError('LOGIN_REQUIRED', 'Mock gym session is logged out.', { hint: GYM_LOGIN_HINT });
      }
      const file = process.env.SYSU_MOCK_FILE;
      const mockTable = file ? JSON.parse(await readFile(file, 'utf8')) : {};
      return new GymClient({
        jar: new CookieJar(),
        token: 'mock-gym-token',
        userUuid: '00000000-0000-4000-8000-000000000001',
        mockTable
      });
    }

    const session = await loadState();
    if (!session?.gymToken) {
      throw new CliError('LOGIN_REQUIRED', 'SYSU Gym token is missing. Please log in to gym.sysu.edu.cn first.', {
        hint: GYM_LOGIN_HINT
      });
    }

    const cookieToken = (session.cookies ?? []).find((c) => c.name === 'safeline_bot_token' && c.value && c.value !== '0')?.value;

    return new GymClient({
      jar: new CookieJar(session.cookies ?? []),
      token: session.gymToken,
      botToken: session.gymBotToken || cookieToken || null,
      userUuid: session.gymUserUuid ?? extractUuidFromJwt(session.gymToken),
      session
    });
  }

  async persistBotToken(newBotToken) {
    if (!newBotToken || newBotToken === '0' || newBotToken === this.botToken) return;
    this.botToken = newBotToken;
    if (this.session) {
      this.session = {
        ...this.session,
        gymBotToken: newBotToken
      };
      await saveState(this.session).catch(() => {});
    }
  }

  async request(path, { method = 'GET', body } = {}) {
    if (this.mockTable) {
      const key = `GYM ${method.toUpperCase()} ${path}`;
      const fallbackKey = `GYM ${method.toUpperCase()} ${path.split('?')[0]}`;
      const hit = this.mockTable[key] ?? this.mockTable[fallbackKey];
      if (hit === undefined) {
        throw new CliError('UPSTREAM_ERROR', `No mock gym fixture for "${key}"`);
      }
      return hit;
    }

    await paceRequest('gym', 400);
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    let powCookies = '';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const jarCookie = this.jar.header(url);
      const cookieParts = [
        jarCookie,
        this.botToken ? `safeline_bot_token=${this.botToken}` : '',
        'fcc1qhye1y=1',
        powCookies
      ].filter(Boolean);

      const headers = {
        Accept: 'application/json, text/plain, */*',
        Authorization: `Bearer ${this.token}`,
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/`,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...(cookieParts.length ? { Cookie: cookieParts.join('; ') } : {})
      };
      if (body !== undefined && method.toUpperCase() !== 'DELETE') {
        headers['Content-Type'] = 'application/json';
      }

      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(15000)
        });
      } catch (error) {
        throw new CliError('NETWORK_ERROR', `Failed to reach ${url}: ${error.message}`, {
          hint: 'Check campus network or VPN connectivity to gym.sysu.edu.cn.',
          cause: error
        });
      }

      const dateHeader = res.headers.get('date');
      if (dateHeader) {
        const serverMs = Date.parse(dateHeader);
        if (!Number.isNaN(serverMs)) {
          this.serverTimeOffsetMs = serverMs - Date.now();
        }
      }

      const setCookies = readSetCookies(res.headers);
      for (const sc of setCookies) {
        const m = sc.match(/safeline_bot_token=([^;]+)/);
        if (m && m[1] && m[1] !== '0') {
          await this.persistBotToken(m[1]);
        }
      }

      if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
        throw new CliError('LOGIN_REQUIRED', `SYSU Gym session expired or was rejected (HTTP ${res.status}).`, {
          hint: GYM_LOGIN_HINT
        });
      }

      if (res.status === 204) {
        return { ok: true, status: 204 };
      }

      const text = await res.text();

      // SafeLine WAF automatic JS Proof-of-Work challenge handling
      if (text.includes("window.data.type = 'js-challenge'") || text.includes('safeline_bot_challenge_ans')) {
        const chMatch = setCookies.join('; ').match(/safeline_bot_challenge=([^;]+)/);
        const challenge = chMatch?.[1];
        const prefix = text.match(/var\s+prefix\s*=\s*'([^']+)'/)?.[1];
        const bits = Number(text.match(/var\s+leading_zero_bit\s*=\s*(\d+)/)?.[1] ?? 9);
        const suffix = solveSafelinePow(prefix, bits);
        if (challenge && suffix !== null) {
          powCookies = `safeline_bot_challenge=${challenge}; safeline_bot_challenge_ans=${challenge}${suffix}`;
          continue;
        }
      }

      if (/WEB 应用防火墙|Access Forbidden|资源或业务被限制访问/i.test(text)) {
        const botType = text.match(/window\.data\.type\s*=\s*'([^']+)'/)?.[1] ?? 'unknown';
        throw new CliError(
          'LOGIN_REQUIRED',
          `SYSU Gym SafeLine WAF interactive challenge (${botType}) or campus-network restriction triggered.`,
          {
            hint: 'Ensure you are on the SYSU campus network/VPN and run `sysu-cli gym login` to pass the browser verification.'
          }
        );
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new CliError('UPSTREAM_ERROR', `Non-JSON response from gym.sysu.edu.cn (HTTP ${res.status}).`, {
          details: { url, status: res.status, preview: text.slice(0, 200) }
        });
      }
    }

    throw new CliError('UPSTREAM_ERROR', `Exceeded SafeLine WAF JS challenge retries for ${url}.`, {
      hint: GYM_LOGIN_HINT
    });
  }
}

export async function gymLogin({ browser, timeoutSec = 240 } = {}) {
  const existing = (await loadState()) ?? {};
  const { context, browser: chosen } = await launchProfile({
    browser: browser ?? existing.browser,
    headless: false
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${GYM_BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    const deadline = Date.now() + timeoutSec * 1000;
    let gymToken = null;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new CliError('AUTH_LOGIN_INCOMPLETE', 'Browser window was closed before gym login completed.', {
          hint: GYM_LOGIN_HINT
        });
      }
      const currentUrl = page.url();
      if (currentUrl.includes('gym.sysu.edu.cn')) {
        const rawAuth = await page
          .evaluate(() => {
            try {
              return localStorage.getItem('scientia-session-authorization');
            } catch {
              return null;
            }
          })
          .catch(() => null);
        if (rawAuth) {
          try {
            const parsed = JSON.parse(rawAuth);
            if (parsed?.access_token) {
              gymToken = parsed.access_token;
              break;
            }
          } catch {
            // keep waiting
          }
        }
      }
      await page.waitForTimeout(1000);
    }

    if (!gymToken) {
      throw new CliError('AUTH_LOGIN_TIMEOUT', `Timed out after ${timeoutSec}s waiting for gym.sysu.edu.cn authorization token.`, {
        hint: GYM_LOGIN_HINT
      });
    }

    const rawCookies = await context.cookies();
    const cookies = rawCookies.map((c) => (c.domain?.includes('gym.sysu.edu.cn') ? { ...c, path: '/' } : c));
    const botCookie = cookies.find((c) => c.name === 'safeline_bot_token' && c.value && c.value !== '0')?.value;
    const gymUserUuid = extractUuidFromJwt(gymToken);
    const gymUpdatedAt = new Date().toISOString();
    await saveState({
      ...existing,
      browser: chosen.id,
      cookies,
      gymToken,
      ...(botCookie ? { gymBotToken: botCookie } : {}),
      gymUserUuid,
      gymUpdatedAt
    });

    return {
      authenticated: true,
      browser: chosen.id,
      gymUserUuid,
      gymUpdatedAt
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function listGymVenues({ campus, search, raw = false } = {}) {
  const client = await GymClient.create();
  const payload = await client.request('/api/venuetype/all');
  let venues = parseVenueTypes(payload);

  if (campus) {
    const q = String(campus).trim();
    venues = venues.filter((v) => v.campus.includes(q) || v.name.includes(q) || (v.address && v.address.includes(q)));
  }
  if (search) {
    const q = String(search).trim().toLowerCase();
    venues = venues.filter((v) => v.name.toLowerCase().includes(q) || v.description.toLowerCase().includes(q));
  }

  return {
    campusFilter: campus ?? null,
    searchFilter: search ?? null,
    count: venues.length,
    venues,
    ...(raw ? { raw: payload } : {})
  };
}

async function resolveVenueType(client, venueInput) {
  const v = String(venueInput ?? '').trim();
  if (!v) {
    throw invalidArgument('Missing --venue <venueTypeId or venue name>. Run `sysu-cli gym venues` to list venues.');
  }
  const all = parseVenueTypes(await client.request('/api/venuetype/all').catch(() => []));
  const exact = all.find((item) => item.name === v || item.venueTypeId.toLowerCase() === v.toLowerCase());
  if (exact) return exact;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    return { venueTypeId: v, name: v };
  }
  const fuzzy = all.filter((item) => item.name.includes(v));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw invalidArgument(
      `Multiple venues matched "${v}": ${fuzzy.map((x) => `${x.name} (${x.venueTypeId})`).join(', ')}. Please be more specific or pass the UUID.`
    );
  }
  throw invalidArgument(`No gym venue matched "${v}". Run \`sysu-cli gym venues\` to inspect available venues.`);
}

export async function listGymSlots({ venue, date, time, court, availableOnly = false, raw = false } = {}) {
  const client = await GymClient.create();
  const resolved = await resolveVenueType(client, venue);
  const dateStr = normalizeDateStr(date);
  const startDate = dateStr || formatDate(new Date());
  const endDate = dateStr || addDays(startDate, 3);

  const payload = await client.request(
    `/api/venue/available-slots/range?venueTypeId=${encodeURIComponent(resolved.venueTypeId)}&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`
  );
  const courts = parseAvailableSlots(payload, { date: dateStr, time, court, availableOnly }).map((c) => ({
    venueId: c.venueId,
    venueName: c.venueName,
    availableSlotCount: c.availableSlotCount,
    slots: c.slots.map(({ rawSlot, ...rest }) => rest)
  }));

  return {
    venueTypeId: resolved.venueTypeId,
    venueTypeName: resolved.name,
    startDate,
    endDate,
    dateFilter: dateStr ?? null,
    timeFilter: time ?? null,
    courtFilter: court ?? null,
    availableOnly: Boolean(availableOnly),
    courtCount: courts.length,
    totalAvailableSlots: courts.reduce((sum, c) => sum + c.availableSlotCount, 0),
    courts,
    ...(raw ? { raw: payload } : {})
  };
}

export async function getGymMe({ raw = false } = {}) {
  const client = await GymClient.create();
  const today = formatDate(new Date());
  const startDate = addDays(today, -3);
  const endDate = addDays(today, 14);

  const wallet = await client.request('/api/Credit/Me');
  const ordersRaw = await client.request(`/api/BookingRequestVenue?startDate=${startDate}&endDate=${endDate}&waitingList=false`);
  const waitlistRaw = await client.request(`/api/BookingRequestVenue?startDate=${startDate}&endDate=${endDate}&waitingList=true`);

  const bookings = parseGymBookings(ordersRaw);
  const waitlist = parseGymBookings(waitlistRaw);

  return {
    profile: {
      name: wallet?.Name ?? '',
      userId: wallet?.HostKey ?? wallet?.UserId ?? '',
      credits: Number(wallet?.Credits ?? 0),
      cashWallet: Number(wallet?.CashWallet ?? 0)
    },
    bookingsCount: bookings.length,
    bookings,
    waitlistCount: waitlist.length,
    waitlist,
    ...(raw ? { raw: { wallet, ordersRaw, waitlistRaw } } : {})
  };
}

export async function bookGymSlot({ venue, date: rawDate, time, court, waitlist = false, cash = false } = {}) {
  const date = normalizeDateStr(rawDate);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw invalidArgument('Missing or invalid --date YYYY-MM-DD for `sysu-cli gym book`.');
  }
  if (!time || !/^\d{2}:\d{2}$/.test(String(time))) {
    throw invalidArgument('Missing or invalid --time HH:MM (e.g. 20:00) for `sysu-cli gym book`.');
  }

  // Enforce strict cooldown to prevent high-frequency court-sniping loops
  await enforceActionCooldown('gym.book', 5000);

  const client = await GymClient.create();
  const resolved = await resolveVenueType(client, venue);
  const wallet = await client.request('/api/Credit/Me').catch(() => null);
  const slotsPayload = await client.request(
    `/api/venue/available-slots/range?venueTypeId=${encodeURIComponent(resolved.venueTypeId)}&start=${encodeURIComponent(date)}&end=${encodeURIComponent(date)}`
  );
  const hashStr = computeSlotsHash(slotsPayload);
  const identity = randomUUID();
  const bookingId = generateBookingSignature(identity, client.serverNowSec(), hashStr);
  const nowIso = client.serverNowIso();
  const actionedBy = wallet?.Identity ?? client.userUuid ?? undefined;
  const dateIso = new Date(date).toISOString();

  if (waitlist) {
    const [h, m] = String(time).split(':').map(Number);
    const endHour = String((h + 1) % 24).padStart(2, '0');
    const endTime = `${endHour}:${String(m).padStart(2, '0')}`;
    const payload = {
      Identity: identity,
      BookingId: bookingId,
      ...(actionedBy ? { UserId: actionedBy } : {}),
      VenueTypeId: resolved.venueTypeId,
      VenueBookings: [
        {
          VenueId: null,
          VenueName: null,
          TimeSlots: [{ Date: dateIso, Start: time, End: endTime }]
        }
      ],
      Participants: [],
      Status: 'WaitingList',
      Description: `候补排队: ${resolved.name}`,
      CreatedAt: nowIso,
      UpdatedAt: nowIso,
      ...(actionedBy ? { ActionedBy: actionedBy } : {})
    };
    const response = await client.request('/api/BookingRequestVenue', { method: 'POST', body: payload });
    const ok = response?.Code === 200;
    if (!ok) {
      throw new CliError(
        'UPSTREAM_ERROR',
        `Gym waitlist request was rejected: ${response?.Message || JSON.stringify(response?.Result ?? response)}`,
        {
          details: response
        }
      );
    }
    return {
      action: 'waitlist',
      bookingUuid: identity,
      bookingId,
      venueTypeId: resolved.venueTypeId,
      venueTypeName: resolved.name,
      date,
      time,
      status: response?.Result?.Status ?? 'WaitingList',
      response
    };
  }

  const matchingCourts = parseAvailableSlots(slotsPayload, {
    date,
    time,
    court,
    availableOnly: true
  });

  if (matchingCourts.length === 0) {
    throw new CliError(
      'UPSTREAM_ERROR',
      `No available court found for "${resolved.name}" on ${date} at ${time}${court ? ` (court filter: ${court})` : ''}.`,
      {
        hint: 'Check `sysu-cli gym slots` for open timeslots, or pass `--waitlist` to join the waiting list.'
      }
    );
  }

  const chosenCourt = matchingCourts[0];
  const chosenSlot = chosenCourt.slots[0];

  const feeTemplates = await client
    .request(`/api/venuetype/${encodeURIComponent(resolved.venueTypeId)}/feetemplates`)
    .catch(() => []);
  const feeInfo = selectFeeTemplate(feeTemplates, {
    userType: wallet?.Type ?? '学生',
    date,
    start: chosenSlot.start,
    end: chosenSlot.end
  });

  const userCredits = Number(wallet?.Credits ?? 0);
  const creditCost = feeInfo ? feeInfo.creditFee : Number(chosenSlot.charge ?? 0);
  const cashCost = feeInfo ? feeInfo.cashFee : Number(chosenSlot.charge ?? 0);
  const isCash = Boolean(cash) || (wallet ? creditCost > userCredits : false);
  const charge = isCash ? cashCost : creditCost;

  // Re-generate BookingId right before POST with latest synced server clock
  const finalBookingId = generateBookingSignature(identity, client.serverNowSec(), hashStr);
  const finalNowIso = client.serverNowIso();

  const payload = {
    Identity: identity,
    BookingId: finalBookingId,
    ...( wallet?.Id ? { UserId: wallet.Id } : {}),
    VenueTypeId: resolved.venueTypeId,
    VenueBookings: [
      {
        VenueId: chosenCourt.venueId,
        VenueName: chosenCourt.venueName,
        TimeSlots: [{ Date: dateIso, Start: chosenSlot.start, End: chosenSlot.end }]
      }
    ],
    Participants: [],
    Status: 'Accepted',
    Description: resolved.name,
    CreatedAt: finalNowIso,
    UpdatedAt: finalNowIso,
    ...(actionedBy ? { ActionedBy: actionedBy } : {}),
    IsCash: isCash,
    Charge: charge
  };

  const response = await client.request('/api/BookingRequestVenue', { method: 'POST', body: payload });
  if (response?.Code !== 200) {
    throw new CliError(
      'UPSTREAM_ERROR',
      `Gym booking failed: ${response?.Message || JSON.stringify(response?.Result ?? response)}`,
      {
        details: response
      }
    );
  }

  const orderNo = response?.Result?.BookingId ?? null;
  const sanitizedResponse = response?.Result
    ? {
        ...response,
        Result: {
          ...response.Result,
          Name: undefined,
          UserId: undefined,
          HostKey: undefined,
          ActionedBy: undefined
        }
      }
    : response;

  return {
    action: 'book',
    bookingUuid: response?.Result?.Identity ?? identity,
    ...(orderNo ? { orderNo } : {}),
    bookingId: finalBookingId,
    venueTypeId: resolved.venueTypeId,
    venueTypeName: resolved.name,
    venueId: chosenCourt.venueId,
    venueName: chosenCourt.venueName,
    date,
    startTime: chosenSlot.start,
    endTime: chosenSlot.end,
    charge,
    isCash,
    status: 'Accepted',
    response: sanitizedResponse
  };
}

export async function cancelGymBooking({ id } = {}) {
  const rawId = String(id ?? '').trim();
  if (!rawId) {
    throw invalidArgument('Missing --id <bookingUuid or #RB-... orderNo> for `sysu-cli gym cancel` (get it from `sysu-cli gym me`).');
  }

  await enforceActionCooldown('gym.cancel', 2000);
  const client = await GymClient.create();
  let bookingUuid = rawId;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
  if (!isUuid) {
    const today = formatDate(new Date());
    const ordersRaw = await client.request(
      `/api/BookingRequestVenue?startDate=${addDays(today, -3)}&endDate=${addDays(today, 14)}&waitingList=false`
    );
    const bookings = parseGymBookings(ordersRaw);
    const normalized = rawId.startsWith('#') ? rawId.toUpperCase() : `#${rawId.toUpperCase()}`;
    const hit = bookings.find(
      (b) => b.bookingId.toUpperCase() === rawId.toUpperCase() || b.bookingId.toUpperCase() === normalized
    );
    if (!hit) {
      throw new CliError('UPSTREAM_ERROR', `No active gym booking found matching order "${rawId}".`, {
        hint: 'Run `sysu-cli gym me` to inspect active bookings.'
      });
    }
    bookingUuid = hit.bookingUuid;
  }

  try {
    await client.request(`/api/BookingRequestVenue/${encodeURIComponent(bookingUuid)}`, { method: 'DELETE' });
  } catch (err) {
    // If the user passed the request Identity from `gym book` instead of the record Identity from `gym me`, resolve the latest active booking
    if (isUuid && String(err?.details?.preview ?? '').includes('not found')) {
      const today = formatDate(new Date());
      const ordersRaw = await client.request(
        `/api/BookingRequestVenue?startDate=${addDays(today, -3)}&endDate=${addDays(today, 14)}&waitingList=false`
      );
      const bookings = parseGymBookings(ordersRaw);
      if (bookings.length === 1) {
        bookingUuid = bookings[0].bookingUuid;
        await client.request(`/api/BookingRequestVenue/${encodeURIComponent(bookingUuid)}`, { method: 'DELETE' });
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  return {
    cancelled: true,
    bookingUuid
  };
}
