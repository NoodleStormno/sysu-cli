import { createHash } from 'node:crypto';

export function generateBookingSignature(identity, timestampSec = Math.floor(Date.now() / 1000)) {
  const ts = String(timestampSec);
  const raw = `SYSUBOOKING-${identity}${ts}`;
  const md5 = createHash('md5').update(raw, 'utf8').digest('hex');
  return `${md5}.${ts}.null`;
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

export function parseVenueTypes(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const id = row.Identity ?? row.Id ?? row.VenueTypeId ?? row.id ?? '';
    const name = row.Name ?? row.VenueTypeName ?? row.Description ?? row.name ?? '';
    const campus = row.CampusName ?? row.Campus ?? inferCampus(name);
    return {
      venueTypeId: String(id),
      name: String(name),
      campus: String(campus || ''),
      description: String(row.Description ?? row.Remark ?? '')
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
