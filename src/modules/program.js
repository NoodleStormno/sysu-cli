import { JWXT_BASE } from '../lib/jwxt.js';

const MENU_ID = 'jwxsd_grpyfack';
const REFERER = `${JWXT_BASE}/mk/#/personalTrainingProgramView?code=${MENU_ID}`;

export async function viewProgram(client, { category, search, raw = false } = {}) {
  const mainList = await client.get('/training-programe/training-programe/undergradute/student/personalMainProgram', {
    menuId: MENU_ID,
    referer: REFERER
  });
  const main = Array.isArray(mainList) ? mainList[0] : mainList;
  const programId = main?.TEACHPLANNUMBER ?? main?.teachPlanNumber ?? null;
  const grade = main?.GRADE ?? main?.grade ?? null;

  let basic = null;
  let creditRequirements = [];
  let courseGroups = {};
  if (programId) {
    basic = await client.get('/training-programe/trainingBasicInfo/getBasicInformation', {
      query: { id: programId },
      menuId: MENU_ID,
      referer: REFERER
    });
    const reqs = await client.get('/training-programe/trainingReqGraduate/showReqGraduateCreits', {
      query: { grade: grade ?? '', cultivateId: programId, cultivateCategoryId: '01' },
      menuId: MENU_ID,
      referer: REFERER
    });
    creditRequirements = Array.isArray(reqs) ? reqs : [];
    const table = await client.get('/training-programe/schemeSubmitAgg/getTableByProgramId', {
      query: { programId },
      menuId: MENU_ID,
      referer: REFERER
    });
    courseGroups = normalizeProgramTable(table, { category, search });
  }

  return {
    student: main ? {
      studentNumber: main.STUDENTNUMBER ?? null,
      grade: main.GRADE ?? null,
      college: main.COLLEGE ?? null,
      professionCode: main.PROFESSIONCODE ?? null,
      professionName: main.PROFESSIONNAME ?? null,
      programId
    } : null,
    basic: basic ? {
      id: basic.id ?? programId,
      grade: basic.grade ?? grade,
      collegeName: basic.collegeName ?? main?.COLLEGE ?? null,
      professionName: basic.professionName ?? main?.PROFESSIONNAME ?? null,
      schoolSystem: basic.schoolSystem ?? null,
      degreeName: basic.grantDegreeName ?? basic.degreeName ?? null,
      minGraduationCredits: basic.minGraduationCredit ?? null
    } : null,
    creditRequirements: creditRequirements.map((item) => ({
      categoryName: item.courseCategoryName ?? item.categoryName ?? null,
      categoryCode: item.courseCategoryCode ?? item.courseCategoryId ?? null,
      requiredCredits: item.requireCredit ?? item.credit ?? null
    })),
    courseGroups,
    ...(raw ? { raw: { main, basic, creditRequirements } } : {})
  };
}

function normalizeProgramTable(table, { category, search } = {}) {
  if (!table || typeof table !== 'object') return {};
  const keyword = search ? String(search).trim().toLowerCase() : null;
  const result = {};
  for (const [groupKey, list] of Object.entries(table)) {
    if (!Array.isArray(list)) continue;
    if (category && groupKey.toLowerCase() !== String(category).toLowerCase()) continue;
    const mapped = list
      .map((item) => ({
        courseCode: item.courseNumber ?? null,
        courseName: item.courseName ?? null,
        courseNameEn: item.courseEN ?? null,
        categoryCode: item.courseCategoryCode ?? null,
        categoryName: item.courseCategoryName ?? null,
        credit: item.credit ?? item.courseCredit ?? null,
        totalHours: item.totalHours ?? item.period ?? null,
        suggestedTerm: item.acadYearSemester ?? item.suggestTerm ?? null
      }))
      .filter((item) => !keyword
        || String(item.courseName ?? '').toLowerCase().includes(keyword)
        || String(item.courseCode ?? '').toLowerCase().includes(keyword));
    result[groupKey] = { count: mapped.length, courses: mapped };
  }
  return result;
}
