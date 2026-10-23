import { JWXT_BASE } from '../lib/jwxt.js';

const MENU_ID = 'jwxsd_kcwcqtj';
const REFERER = `${JWXT_BASE}/mk/gradua/#/completionstatusStu?code=${MENU_ID}`;
const BASE = '/gradua-degree/graduatemsg/studentsGraduationExamination';

export async function completionSummary(client, { cultureType = '01' } = {}) {
  const overviewRows = await client.get('/achievement-manage/score-check/credit-situation', {
    referer: `${JWXT_BASE}/#/student`
  });
  const categoryRows = await client.post(`${BASE}/creditHoursStu`, undefined, {
    query: { cultureTypeCode: cultureType },
    menuId: MENU_ID,
    referer: REFERER
  });

  const overview = Array.isArray(overviewRows) && overviewRows[0] ? overviewRows[0] : null;
  const categories = (Array.isArray(categoryRows) ? categoryRows : []).map((item) => ({
    categoryCode: item.courseCategoryNumber ?? null,
    categoryName: item.courseCategoryName ?? null,
    requiredCredits: toNum(item.actualCredit ?? item.trainingCredit),
    exemptCredits: toNum(item.exemptCredit),
    earnedCredits: toNum(item.earnedCredit),
    earnedAllCredits: toNum(item.earnedAllCredit)
  }));

  return {
    cultureType,
    overview: overview ? {
      studentNumber: overview.studentNo ?? null,
      grade: overview.grade ?? null,
      professionCode: overview.professionNumber ?? null,
      teachPlanNumber: overview.teachPlanNumber ?? null,
      minGraduationCredits: toNum(overview.minGraduationCredit),
      finishedCredits: toNum(overview.finishCredit),
      completionRate: toNum(overview.finishCreditRate)
    } : null,
    categories
  };
}

export async function completionCourses(client, {
  cultureType = '01',
  category,
  search,
  limit = 100,
  raw = false
} = {}) {
  const data = await client.post(`${BASE}/studentCourse`, {
    pageNo: 1,
    pageSize: Math.max(limit, 200),
    total: true,
    param: {
      cultureTypeCode: cultureType,
      ...(category ? { courseCategoryNumber: category } : {})
    }
  }, {
    menuId: MENU_ID,
    referer: REFERER
  });

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const keyword = search ? String(search).trim().toLowerCase() : null;
  const mapped = rows
    .map((row) => ({
      courseCode: row.courseNumber ?? null,
      courseName: row.courseName ?? null,
      categoryCode: row.courseCategoryNumber ?? null,
      categoryName: row.courseCategoryName ?? null,
      terms: row.acadYearSemester ?? null,
      credit: toNum(row.credit ?? row.courseCredit ?? row.scoCredit),
      score: row.score ?? row.scoFinalScore ?? row.finalScore ?? null,
      gradePoint: toNum(row.point ?? row.scoPoint ?? row.gradePoint),
      status: row.completeStatusName ?? row.completeStatus ?? row.whetherPass ?? null
    }))
    .filter((item) => !keyword
      || String(item.courseName ?? '').toLowerCase().includes(keyword)
      || String(item.courseCode ?? '').toLowerCase().includes(keyword));

  const sliced = mapped.slice(0, limit);
  return {
    total: data?.total ?? rows.length,
    count: sliced.length,
    courses: sliced,
    ...(raw ? { raw: rows.slice(0, limit) } : {})
  };
}

function toNum(value) {
  const num = Number(value);
  return Number.isFinite(num) && value !== null && value !== undefined && value !== '' ? num : null;
}
