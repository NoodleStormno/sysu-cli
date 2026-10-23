import { invalidArgument } from '../lib/errors.js';
import { JWXT_BASE } from '../lib/jwxt.js';
import { matchExamWeekType, normalizeExamWeek, parseExamRows } from '../parsers/exam-parser.js';
import { describeTerm, resolveTerm } from './term.js';

const REFERER = `${JWXT_BASE}/mk/#/stuExamInfo`;

export async function listExamWeeks(client, { term: termOption } = {}) {
  const term = await resolveTerm(client, termOption);
  const weeks = await fetchExamWeeks(client, term);
  return {
    term,
    termLabel: describeTerm(term),
    count: weeks.length,
    examWeeks: weeks.map(normalizeExamWeek)
  };
}

export async function listExams(client, { term: termOption, type, weekId, raw } = {}) {
  const term = await resolveTerm(client, termOption);
  const weeks = await fetchExamWeeks(client, term);
  const targets = weeks
    .filter((week) => !weekId || String(week.examWeekId) === String(weekId))
    .filter((week) => matchExamWeekType(week, type));

  if ((weekId || type) && targets.length === 0) {
    throw invalidArgument(`No exam week matched ${weekId ? `id ${weekId}` : `type ${type}`} in ${term}.`, {
      available: weeks.map(normalizeExamWeek)
    });
  }

  const exams = [];
  const rawResults = [];
  for (const week of targets) {
    const body = {
      acadYear: term,
      examWeekId: week.examWeekId ?? null,
      examDate: '',
      examWeekName: week.examWeekName ?? week.weekName ?? '',
      examWeekObj: week
    };
    const data = await client.post('/examination-manage/classroomResource/queryStuEaxmInfo', body, {
      query: { code: 'jwxsd_ksxxck' },
      referer: REFERER
    });
    exams.push(...parseExamRows(Array.isArray(data) ? data : [], { term, examWeek: normalizeExamWeek(week) }));
    if (raw) rawResults.push({ examWeekId: week.examWeekId, data });
  }

  return {
    term,
    termLabel: describeTerm(term),
    examWeeks: targets.map(normalizeExamWeek),
    count: exams.length,
    exams,
    ...(raw ? { raw: rawResults } : {})
  };
}

async function fetchExamWeeks(client, term) {
  const data = await client.get('/schedule/agg/commonScheduleExamTime/queryExamWeekName', {
    query: { yearTerm: term },
    referer: REFERER
  });
  return Array.isArray(data) ? data : [];
}
