import { invalidArgument, upstreamChanged } from '../lib/errors.js';
import { JWXT_BASE } from '../lib/jwxt.js';

const TERM_RE = /^(\d{4})-([1-3])$/;
const LONG_TERM_RE = /^(\d{4})-(\d{4})-([1-3])$/;

/**
 * Normalize a user term into JWXT's "YYYY-N" form (start year + semester).
 * Accepts "current", "2025-1" and "2025-2026-1".
 */
export function normalizeTerm(value) {
  if (value === undefined || value === null || value === '' || value === 'current') {
    return 'current';
  }
  const text = String(value).trim();
  const short = text.match(TERM_RE);
  if (short) return `${short[1]}-${short[2]}`;
  const long = text.match(LONG_TERM_RE);
  if (long && Number(long[2]) === Number(long[1]) + 1) return `${long[1]}-${long[3]}`;
  throw invalidArgument(`Invalid term "${value}". Use YYYY-N (e.g. 2025-1 for 2025-2026 first semester) or "current".`);
}

export function termToSchoolYear(term) {
  const match = String(term).match(TERM_RE);
  if (!match) return null;
  const start = Number(match[1]);
  return { schoolYear: `${start}-${start + 1}`, semester: match[2] };
}

export function describeTerm(term) {
  const parsed = termToSchoolYear(term);
  if (!parsed) return null;
  const names = { 1: '第一学期', 2: '第二学期', 3: '第三学期' };
  return `${parsed.schoolYear} 学年${names[parsed.semester] ?? `第${parsed.semester}学期`}`;
}

export async function fetchCurrentTerm(client) {
  const data = await client.get('/base-info/acadyearterm/showNewAcadlist', { referer: `${JWXT_BASE}/#/student` });
  const term = data?.acadYearSemester;
  if (!term || !TERM_RE.test(String(term))) {
    throw upstreamChanged('showNewAcadlist did not return acadYearSemester in YYYY-N form.', { keys: Object.keys(data ?? {}) });
  }
  return String(term);
}

export async function resolveTerm(client, value) {
  const term = normalizeTerm(value);
  return term === 'current' ? fetchCurrentTerm(client) : term;
}

export async function fetchCurrentWeek(client, term) {
  const data = await client.get('/base-info/school-calender/weekly', { query: { academicYear: term } });
  const week = Number(data?.nowWeekly ?? data?.nowTimeWeekly);
  return Number.isInteger(week) && week > 0 ? week : null;
}

export async function getTermInfo(client, { term: termOption } = {}) {
  const term = await resolveTerm(client, termOption);
  const currentWeek = await fetchCurrentWeek(client, term);
  return {
    term,
    label: describeTerm(term),
    currentWeek
  };
}
