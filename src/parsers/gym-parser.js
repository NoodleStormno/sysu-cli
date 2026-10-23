import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

let wasmExports = null;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

function getWasmExports() {
  if (wasmExports) return wasmExports;
  const wasmUrl = new URL('../lib/gym-token.wasm', import.meta.url);
  const wasmBytes = readFileSync(wasmUrl);
  const mod = new WebAssembly.Module(wasmBytes);
  const instance = new WebAssembly.Instance(mod, {
    './wasm_token_bg.js': {
      __wbindgen_init_externref_table() {
        const table = wasmExports.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
      }
    }
  });
  wasmExports = instance.exports;
  wasmExports.__wbindgen_start();
  return wasmExports;
}

function passStringToWasm(exportsObj, str) {
  const buf = textEncoder.encode(String(str ?? ''));
  const ptr = exportsObj.__wbindgen_malloc(buf.length, 1) >>> 0;
  new Uint8Array(exportsObj.memory.buffer).subarray(ptr, ptr + buf.length).set(buf);
  return [ptr, buf.length];
}

export function computeSlotsHash(slotsPayload) {
  if (slotsPayload === undefined || slotsPayload === null) return '';
  return createHash('md5').update(JSON.stringify(slotsPayload), 'utf8').digest('hex');
}

export function generateBookingSignature(
  identity,
  timestampSec = Math.floor(Date.now() / 1000),
  hashStr = ''
) {
  const exportsObj = getWasmExports();
  const [idPtr, idLen] = passStringToWasm(exportsObj, identity);
  const [hashPtr, hashLen] = passStringToWasm(exportsObj, hashStr);
  const [retPtr, retLen] = exportsObj.gen_token(idPtr, idLen, Math.floor(Number(timestampSec)), hashPtr, hashLen);
  try {
    return textDecoder.decode(
      new Uint8Array(exportsObj.memory.buffer).subarray(retPtr >>> 0, (retPtr >>> 0) + retLen)
    );
  } finally {
    exportsObj.__wbindgen_free(retPtr, retLen, 1);
  }
}

export function selectFeeTemplate(feeTemplates = [], { userType = '学生', date, start, end } = {}) {
  if (!Array.isArray(feeTemplates) || feeTemplates.length === 0) return null;
  const byRole = userType ? feeTemplates.filter((t) => t.UserRole === userType) : [];
  const pool = byRole.length > 0 ? byRole : feeTemplates;
  const dayNum = date ? new Date(date).getDay() : 1;
  const dayType = dayNum === 0 || dayNum === 6 ? '周末' : '工作日';
  const matched =
    pool.find(
      (t) =>
        t.Timeslot &&
        String(t.Timeslot.StartTime ?? '') <= String(start ?? '') &&
        String(t.Timeslot.EndTime ?? '') >= String(end ?? '') &&
        (t.Timeslot.DayType === dayType || t.Timeslot.DayType === '全周')
    ) || pool[0];
  if (!matched) return null;
  return {
    creditFee: Number(matched.CreditFee ?? 0),
    cashFee: Number(matched.CashFee ?? 0),
    description: String(matched.Description ?? matched.Name ?? ''),
    template: matched
  };
}

/**
 * Solve SafeLine WAF's `js-challenge` SHA-1 Proof-of-Work:
 * Finds the smallest non-negative integer `cnt` (in hex `suffix = cnt.toString(16)`)
 * such that `SHA1(prefix + suffix)` starts with `leadingZeroBits` binary 0s.
 */
export function solveSafelinePow(prefix, leadingZeroBits = 9) {
  const bits = Number(leadingZeroBits);
  if (!prefix || !Number.isInteger(bits) || bits <= 0 || bits > 24) return null;
  const target = '0'.repeat(bits);
  const hexCharsNeeded = Math.ceil(bits / 4);

  for (let cnt = 0; cnt < 2000000; cnt += 1) {
    const suffix = cnt.toString(16);
    const hex = createHash('sha1').update(`${prefix}${suffix}`, 'utf8').digest('hex');
    let bin = '';
    for (let i = 0; i < hexCharsNeeded; i += 1) {
      bin += parseInt(hex[i], 16).toString(2).padStart(4, '0');
    }
    if (bin.slice(0, bits) === target) {
      return suffix;
    }
  }
  return null;
}

export function extractUuidFromJwt(token = '') {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);
    for (const value of Object.values(payload)) {
      if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        return value;
      }
    }
    return payload.sub ? String(payload.sub) : null;
  } catch {
    return null;
  }
}

function inferCampus(text = '') {
  const s = String(text);
  for (const c of ['南校园', '北校园', '东校园', '珠海校区', '深圳校区']) {
    if (s.includes(c)) return c;
  }
  if (s.includes('南校')) return '南校园';
  if (s.includes('北校')) return '北校园';
  if (s.includes('东校')) return '东校园';
  if (s.includes('珠海')) return '珠海校区';
  if (s.includes('深圳')) return '深圳校区';
  return '';
}

function isUuid(str = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(str));
}

export function parseVenueTypes(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const id = row.Identity ?? row.Id ?? row.VenueTypeId ?? row.id ?? '';
    const name = String(row.Name ?? row.VenueTypeName ?? row.Description ?? row.name ?? '');
    const address = String(row.Address ?? '');
    const rawCampus = String(row.CampusName ?? (!isUuid(row.Campus) ? (row.Campus ?? '') : ''));
    const campus = rawCampus || inferCampus(`${name} ${address}`);
    return {
      venueTypeId: String(id),
      name,
      campus,
      ...(address ? { address } : {}),
      description: String(row.Description ?? row.Remark ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    };
  });
}

export function parseAvailableSlots(rows = [], { date, time, court, availableOnly = false } = {}) {
  if (!Array.isArray(rows)) return [];
  const courts = [];

  for (const item of rows) {
    const venueId = String(item.VenueId ?? item.Identity ?? '');
    const venueName = String(item.VenueName ?? item.Name ?? '');
    if (court && !venueName.includes(court)) continue;

    const rawSlots = Array.isArray(item.Timeslots ?? item.TimeSlots) ? (item.Timeslots ?? item.TimeSlots) : [];
    const slots = [];
    for (const ts of rawSlots) {
      const slotDate = String(ts.Date ?? '').slice(0, 10);
      const start = String(ts.Start ?? '');
      const end = String(ts.End ?? '');
      const availableCapacity = Number(ts.AvailableCapacity ?? 0);
      const totalCapacity = ts.TotalCapacity !== undefined ? Number(ts.TotalCapacity) : null;
      const charge = ts.Charge !== undefined ? Number(ts.Charge) : (ts.Price !== undefined ? Number(ts.Price) : null);

      if (date && slotDate !== date) continue;
      if (time && start !== time) continue;
      if (availableOnly && !(availableCapacity > 0)) continue;

      slots.push({
        date: slotDate,
        start,
        end,
        availableCapacity,
        ...(totalCapacity !== null ? { totalCapacity } : {}),
        ...(charge !== null ? { charge } : {}),
        available: availableCapacity > 0,
        rawSlot: ts
      });
    }

    if (slots.length > 0) {
      courts.push({
        venueId,
        venueName,
        availableSlotCount: slots.filter((s) => s.available).length,
        slots
      });
    }
  }

  return courts;
}

function toCstDateTime(utcIso = '') {
  if (!utcIso) return { date: '', time: '' };
  const dt = new Date(utcIso);
  if (Number.isNaN(dt.getTime())) return { date: String(utcIso).slice(0, 10), time: '' };
  const cst = new Date(dt.getTime() + 8 * 3600 * 1000);
  const iso = cst.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16)
  };
}

export function parseGymBookings(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const startCst = toCstDateTime(row.StartDateTime);
    const endCst = toCstDateTime(row.EndDateTime);
    return {
      bookingUuid: String(row.Identity ?? ''),
      bookingId: String(row.BookingId ?? ''),
      status: String(row.Status ?? ''),
      venueId: row.VenueId ? String(row.VenueId) : null,
      venueName: String(row.VenueName ?? row.Description ?? ''),
      description: String(row.Description ?? ''),
      date: startCst.date,
      startTime: startCst.time,
      endTime: endCst.time,
      charge: row.Charge !== undefined ? Number(row.Charge) : null,
      isCash: Boolean(row.IsCash),
      createdAt: String(row.CreatedAt ?? '')
    };
  });
}
