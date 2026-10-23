const DEFAULT_SECTION_TIMES = {
  1: { startTime: '08:00', endTime: '08:45' },
  2: { startTime: '08:55', endTime: '09:40' },
  3: { startTime: '10:10', endTime: '10:55' },
  4: { startTime: '11:05', endTime: '11:50' },
  5: { startTime: '14:20', endTime: '15:05' },
  6: { startTime: '15:15', endTime: '16:00' },
  7: { startTime: '16:30', endTime: '17:15' },
  8: { startTime: '17:25', endTime: '18:10' },
  9: { startTime: '19:00', endTime: '19:45' },
  10: { startTime: '19:55', endTime: '20:40' },
  11: { startTime: '20:50', endTime: '21:35' }
};

export function normalizeSectionTimes(rows) {
  const map = { ...DEFAULT_SECTION_TIMES };
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const num = Number(row?.sectionNumber);
      if (Number.isInteger(num) && row?.startTime && row?.endTime) {
        map[num] = { startTime: String(row.startTime).trim(), endTime: String(row.endTime).trim() };
      }
    }
  }
  return map;
}

/**
 * Build an RFC 5545 iCalendar (.ics) string in Asia/Shanghai local time from
 * normalized course entries (each with date YYYY-MM-DD, startSection, endSection).
 */
export function buildCourseIcs(entries, { sectionTimes, calendarName = 'SYSU 课表' } = {}) {
  const times = sectionTimes ?? DEFAULT_SECTION_TIMES;
  const stamp = formatUtcTimestamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//sysu-cli//SYSU JWXT Timetable//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(calendarName)}`,
    'X-WR-TIMEZONE:Asia/Shanghai'
  ];

  let eventCount = 0;
  for (const entry of entries) {
    if (!entry?.date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) continue;
    const startClock = times[entry.startSection]?.startTime ?? DEFAULT_SECTION_TIMES[1].startTime;
    const endClock = times[entry.endSection]?.endTime ?? times[entry.startSection]?.endTime ?? DEFAULT_SECTION_TIMES[1].endTime;
    const dtStart = toLocalDateTime(entry.date, startClock);
    const dtEnd = toLocalDateTime(entry.date, endClock);
    const uid = `${entry.term ?? 'term'}-w${entry.week ?? 0}-d${entry.weekday}-${entry.startSection}-${entry.endSection}-${hashUid(entry.courseName + (entry.classCode ?? ''))}@sysu-cli`;
    const descParts = [
      entry.teacher ? `教师: ${entry.teacher}` : null,
      entry.sections ? `节次: 第${entry.sections}节` : null,
      entry.week ? `周次: 第${entry.week}周` : null,
      entry.classCode ? `教学班: ${entry.classCode}` : null
    ].filter(Boolean);

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Asia/Shanghai:${dtStart}`,
      `DTEND;TZID=Asia/Shanghai:${dtEnd}`,
      `SUMMARY:${escapeIcs(entry.courseName)}`,
      ...(entry.location ? [`LOCATION:${escapeIcs(entry.location)}`] : []),
      ...(descParts.length ? [`DESCRIPTION:${escapeIcs(descParts.join('\n'))}`] : []),
      'END:VEVENT'
    );
    eventCount += 1;
  }

  lines.push('END:VCALENDAR');
  return { ics: `${lines.join('\r\n')}\r\n`, eventCount };
}

function toLocalDateTime(dateStr, clockStr) {
  const [y, m, d] = dateStr.split('-');
  const [hh = '08', mm = '00'] = String(clockStr).split(':');
  return `${y}${m}${d}T${hh.padStart(2, '0')}${mm.padStart(2, '0')}00`;
}

function formatUtcTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcs(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function hashUid(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
