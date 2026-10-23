import { upstreamChanged } from '../lib/errors.js';
import { JWXT_BASE } from '../lib/jwxt.js';
import { computeWeightedGpa, parseGradeRows } from '../parsers/grade-parser.js';
import { describeTerm, normalizeTerm, termToSchoolYear } from './term.js';

const REFERER = `${JWXT_BASE}/#/student`;
const BASE = '/achievement-manage/score-check';

/**
 * Resolve the grade query (school year, semester, train type, addScoreFlag)
 * the same way the JWXT score page does.
 */
async function resolveGradeQuery(client, termOption) {
  const term = normalizeTerm(termOption);
  const status = await client.get(`${BASE}/checkStuStatus`, { referer: REFERER });
  const pull = (await client.get(`${BASE}/getPull`, { referer: REFERER })) ?? {};

  let schoolYear;
  let semester;
  if (term === 'current') {
    schoolYear = pull.selectYearPull?.[0]?.dataNumber;
    semester = pull.selectTermPull?.[0]?.termNumber;
    if (!schoolYear || !semester) {
      throw upstreamChanged('getPull did not provide default school year / semester.', { keys: Object.keys(pull) });
    }
  } else {
    ({ schoolYear, semester } = termToSchoolYear(term));
  }

  const normalizedTerm = `${String(schoolYear).split('-')[0]}-${semester}`;
  return {
    term: normalizedTerm,
    query: {
      scoSchoolYear: String(schoolYear),
      trainTypeCode: String(pull.selectTrainType?.[0]?.dataNumber ?? '01'),
      addScoreFlag: String(Boolean(status?.addScoreFlag)),
      scoSemester: String(semester)
    }
  };
}

export async function listGrades(client, { term: termOption, raw } = {}) {
  const { term, query } = await resolveGradeQuery(client, termOption);
  const rows = await client.get(`${BASE}/list`, { query, referer: REFERER });
  const ranking = await client.get(`${BASE}/getSortByYear`, { query, referer: REFERER });
  const grades = parseGradeRows(Array.isArray(rows) ? rows : [], { term });
  return {
    term,
    termLabel: describeTerm(term),
    count: grades.length,
    grades,
    summary: {
      computed: computeWeightedGpa(grades),
      official: ranking && typeof ranking === 'object' ? ranking : null
    },
    ...(raw ? { raw: rows } : {})
  };
}

export async function creditSummary(client) {
  const rows = await client.get(`${BASE}/stuCreditSitlist`, { referer: REFERER });
  const pie = await client.get(`${BASE}/getPicPie`, { referer: REFERER });
  const rawPie = Array.isArray(pie) ? pie : (Array.isArray(pie?.selectPie) ? pie.selectPie : []);
  const distribution = rawPie.map((item) => ({
    range: item?.ITEM ?? item?.name ?? null,
    count: Number(item?.COU ?? item?.value ?? 0)
  }));
  return {
    credits: Array.isArray(rows) ? rows : [],
    distribution
  };
}
