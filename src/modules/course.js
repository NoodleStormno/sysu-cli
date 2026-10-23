import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { invalidArgument, upstreamChanged } from '../lib/errors.js';
import { JWXT_BASE } from '../lib/jwxt.js';
import { WEEKDAY_NAMES, isoWeekday, parseTimetableRows, weekOffset } from '../parsers/course-parser.js';
import { buildCourseIcs, normalizeSectionTimes } from '../parsers/ics.js';
import { describeTerm, fetchCurrentWeek, resolveTerm } from './term.js';

const REFERER = `${JWXT_BASE}/#/student`;

export async function fetchWeekTimetable(client, { term, week, raw = false }) {
  const data = await client.get('/timetable-search/classTableInfo/selectStudentClassTable', {
    query: { academicYear: term, weekly: week },
    referer: REFERER
  });
  if (!Array.isArray(data)) {
    throw upstreamChanged('selectStudentClassTable did not return an array.', { type: typeof data });
  }
  return {
    entries: parseTimetableRows(data, { term, week }),
    ...(raw ? { raw: data } : {})
  };
}

export async function listCourses(client, { term: termOption, week: weekOption, weekday, raw } = {}) {
  const term = await resolveTerm(client, termOption);
  const currentWeek = await fetchCurrentWeek(client, term);
  const week = weekOption ?? currentWeek;
  if (!week) {
    throw invalidArgument(`JWXT did not report a current week for ${term}; pass --week <n>.`);
  }
  const { entries, raw: rawRows } = await fetchWeekTimetable(client, { term, week, raw });
  const filtered = weekday ? entries.filter((entry) => entry.weekday === weekday) : entries;
  return {
    term,
    termLabel: describeTerm(term),
    week,
    currentWeek,
    ...(weekday ? { weekday, weekdayName: WEEKDAY_NAMES[weekday - 1] } : {}),
    count: filtered.length,
    courses: filtered,
    ...(raw ? { raw: rawRows } : {})
  };
}

/**
 * Courses on a given local date (default today), mapped to a teaching week
 * relative to JWXT's current week.
 */
export async function coursesOnDate(client, { date, raw } = {}) {
  const today = new Date();
  const target = date ?? today;
  const term = await resolveTerm(client, 'current');
  const currentWeek = await fetchCurrentWeek(client, term);
  if (!currentWeek) {
    throw invalidArgument(`JWXT did not report a current week for ${term}; use \`course list --week <n>\` instead.`);
  }
  const week = currentWeek + weekOffset(today, target);
  const weekday = isoWeekday(target);
  if (week < 1) {
    return emptyDay({ term, week, currentWeek, target, weekday, note: 'Date is before the first teaching week of the current term.' });
  }
  const { entries, raw: rawRows } = await fetchWeekTimetable(client, { term, week, raw });
  const courses = entries.filter((entry) => entry.weekday === weekday);
  return {
    term,
    termLabel: describeTerm(term),
    date: formatDate(target),
    week,
    currentWeek,
    weekday,
    weekdayName: WEEKDAY_NAMES[weekday - 1],
    count: courses.length,
    courses,
    ...(raw ? { raw: rawRows } : {})
  };
}

function emptyDay({ term, week, currentWeek, target, weekday, note }) {
  return {
    term,
    termLabel: describeTerm(term),
    date: formatDate(target),
    week,
    currentWeek,
    weekday,
    weekdayName: WEEKDAY_NAMES[weekday - 1],
    count: 0,
    courses: [],
    note
  };
}

export function formatDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export async function exportCoursesIcs(client, { term: termOption, week, fromWeek, toWeek, out } = {}) {
  const term = await resolveTerm(client, termOption);
  const currentWeek = await fetchCurrentWeek(client, term);
  const start = week ?? fromWeek ?? currentWeek ?? 1;
  const end = week ?? toWeek ?? start;
  if (start > end || end - start > 25) {
    throw invalidArgument('Invalid week range for `course export-ics` (ensure --from-week <= --to-week and span <= 25 weeks).');
  }

  const minorRows = await client.get('/base-info/AcadyeartermSet/minorName', {
    query: { schoolYear: term },
    referer: REFERER
  }).catch(() => null);
  const sectionTimes = normalizeSectionTimes(minorRows);

  const allEntries = [];
  for (let w = start; w <= end; w += 1) {
    const { entries } = await fetchWeekTimetable(client, { term, week: w });
    for (const entry of entries) {
      allEntries.push(entry);
    }
  }

  // If any entry lacks an explicit `date` from `skrq`, derive it from the week's calendar startTime.
  if (allEntries.some((entry) => !entry.date)) {
    const weekStartCache = new Map();
    for (const entry of allEntries) {
      if (entry.date || !entry.week) continue;
      if (!weekStartCache.has(entry.week)) {
        const cal = await client.get('/base-info/school-calender', {
          query: { academicYear: term, weekly: entry.week },
          referer: REFERER
        }).catch(() => null);
        weekStartCache.set(entry.week, cal?.startTime ?? null);
      }
      const startTime = weekStartCache.get(entry.week);
      if (startTime && /^\d{4}-\d{2}-\d{2}$/.test(startTime)) {
        const [y, m, d] = startTime.split('-').map(Number);
        const dt = new Date(y, m - 1, d + (entry.weekday - 1));
        entry.date = formatDate(dt);
      }
    }
  }

  const { ics, eventCount } = buildCourseIcs(allEntries, {
    sectionTimes,
    calendarName: `SYSU ${term} 课表`
  });

  const outFile = out ? resolve(out) : null;
  if (outFile) {
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, ics, 'utf8');
  }

  return {
    term,
    termLabel: describeTerm(term),
    fromWeek: start,
    toWeek: end,
    eventCount,
    ...(outFile ? { file: outFile } : { ics })
  };
}

