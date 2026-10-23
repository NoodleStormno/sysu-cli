import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { launchProfile } from '../lib/browser.js';
import { CookieJar } from '../lib/cookies.js';
import { CliError, invalidArgument } from '../lib/errors.js';
import { enforceActionCooldown, paceRequest } from '../lib/rate-limit.js';
import { loadState, saveState } from '../lib/state.js';
import {
  extractUuidFromJwt,
  generateBookingSignature,
  parseAvailableSlots,
  parseGymBookings,
  parseVenueTypes
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
  constructor({ baseUrl = GYM_BASE_URL, jar, token, userUuid, mockTable = null } = {}) {
    this.baseUrl = baseUrl;
    this.jar = jar ?? new CookieJar();
    this.token = token ?? null;
    this.userUuid = userUuid ?? (token ? extractUuidFromJwt(token) : null);
    this.mockTable = mockTable;
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

    return new GymClient({
      jar: new CookieJar(session.cookies ?? []),
      token: session.gymToken,
      userUuid: session.gymUserUuid ?? extractUuidFromJwt(session.gymToken)
    });
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

    await paceRequest('gym', 500);
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const cookieHeader = this.jar.header(url);
    const headers = {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${this.token}`,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
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

    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      throw new CliError('LOGIN_REQUIRED', `SYSU Gym session expired or was rejected (HTTP ${res.status}).`, {
        hint: GYM_LOGIN_HINT
      });
    }

    if (res.status === 204) {
      return { ok: true, status: 204 };
    }

    const text = await res.text();
    if (/WEB 应用防火墙|Access Forbidden|资源或业务被限制访问/i.test(text)) {
      throw new CliError('LOGIN_REQUIRED', 'SYSU Gym WAF challenge or campus-network restriction triggered.', {
        hint: 'Ensure you are on the SYSU campus network/VPN and run `sysu-cli gym login` to refresh your gym session.'
      });
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new CliError('UPSTREAM_ERROR', `Non-JSON response from gym.sysu.edu.cn (HTTP ${res.status}).`, {
        details: { url, status: res.status, preview: text.slice(0, 200) }
      });
    }
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

    const cookies = await context.cookies();
    const gymUserUuid = extractUuidFromJwt(gymToken);
    const gymUpdatedAt = new Date().toISOString();
    await saveState({
      ...existing,
      browser: chosen.id,
      cookies,
      gymToken,
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
    venues = venues.filter((v) => v.campus.includes(q) || v.name.includes(q));
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
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    return { venueTypeId: v, name: v };
  }
  const all = parseVenueTypes(await client.request('/api/venuetype/all'));
  const exact = all.find((item) => item.name === v || item.venueTypeId === v);
  if (exact) return exact;
  const fuzzy = all.filter((item) => item.name.includes(v));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw invalidArgument(`Multiple venues matched "${v}": ${fuzzy.map((x) => `${x.name} (${x.venueTypeId})`).join(', ')}. Please be more specific or pass the UUID.`);
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

  const [wallet, ordersRaw, waitlistRaw] = await Promise.all([
    client.request('/api/Credit/Me'),
    client.request(`/api/BookingRequestVenue?startDate=${startDate}&endDate=${endDate}&waitingList=false`),
    client.request(`/api/BookingRequestVenue?startDate=${startDate}&endDate=${endDate}&waitingList=true`)
  ]);

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
  const identity = randomUUID();
  const bookingId = generateBookingSignature(identity);
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  if (waitlist) {
    const [h, m] = String(time).split(':').map(Number);
    const endHour = String((h + 1) % 24).padStart(2, '0');
    const endTime = `${endHour}:${String(m).padStart(2, '0')}`;
    const payload = {
      Identity: identity,
      BookingId: bookingId,
      VenueTypeId: resolved.venueTypeId,
      VenueBookings: [
        {
          VenueId: null,
          VenueName: null,
          TimeSlots: [{ Date: `${date}T00:00:00.000Z`, Start: time, End: endTime }]
        }
      ],
      Participants: [],
      Status: 'WaitingList',
      Description: '候补排队',
      CreatedAt: createdAt
    };
    const response = await client.request('/api/BookingRequestVenue', { method: 'POST', body: payload });
    const ok = response?.Code === 200;
    if (!ok) {
      throw new CliError('UPSTREAM_ERROR', `Gym waitlist request was rejected: ${response?.Message || JSON.stringify(response?.Result ?? response)}`, {
        details: response
      });
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

  const slotsPayload = await client.request(
    `/api/venue/available-slots/range?venueTypeId=${encodeURIComponent(resolved.venueTypeId)}&start=${encodeURIComponent(date)}&end=${encodeURIComponent(date)}`
  );
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
  const rawSlot = { ...chosenSlot.rawSlot };
  delete rawSlot.AvailableCapacity;

  const payload = {
    Identity: identity,
    BookingId: bookingId,
    VenueTypeId: resolved.venueTypeId,
    VenueBookings: [
      {
        VenueId: chosenCourt.venueId,
        VenueName: chosenCourt.venueName,
        TimeSlots: [rawSlot]
      }
    ],
    Participants: [],
    Status: 'Accepted',
    Description: resolved.name,
    CreatedAt: createdAt,
    UpdatedAt: createdAt,
    IsCash: Boolean(cash),
    ...(chosenSlot.charge !== undefined ? { Charge: chosenSlot.charge } : {})
  };

  const response = await client.request('/api/BookingRequestVenue', { method: 'POST', body: payload });
  if (response?.Code !== 200) {
    throw new CliError('UPSTREAM_ERROR', `Gym booking failed: ${response?.Message || JSON.stringify(response?.Result ?? response)}`, {
      details: response
    });
  }

  return {
    action: 'book',
    bookingUuid: identity,
    bookingId,
    venueTypeId: resolved.venueTypeId,
    venueTypeName: resolved.name,
    venueId: chosenCourt.venueId,
    venueName: chosenCourt.venueName,
    date,
    startTime: chosenSlot.start,
    endTime: chosenSlot.end,
    status: 'Accepted',
    response
  };
}

export async function cancelGymBooking({ id } = {}) {
  const bookingUuid = String(id ?? '').trim();
  if (!bookingUuid) {
    throw invalidArgument('Missing --id <bookingUuid> for `sysu-cli gym cancel` (get bookingUuid from `sysu-cli gym me`).');
  }

  await enforceActionCooldown('gym.cancel', 2000);
  const client = await GymClient.create();
  await client.request(`/api/BookingRequestVenue/${encodeURIComponent(bookingUuid)}`, { method: 'DELETE' });

  return {
    cancelled: true,
    bookingUuid
  };
}
