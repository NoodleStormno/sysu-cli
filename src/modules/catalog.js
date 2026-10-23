import { JWXT_BASE } from '../lib/jwxt.js';
import { describeTerm, resolveTerm } from './term.js';

const MENU_ID = 'jwxsd_qxkckk';
const REFERER = `${JWXT_BASE}/mk/#/openingCoursesStu?code=${MENU_ID}`;

export async function searchCatalog(client, {
  term: termOption,
  name,
  code,
  teacher,
  department,
  campus,
  page = 1,
  limit = 20,
  raw = false
} = {}) {
  const term = await resolveTerm(client, termOption);
  const param = {
    yearTerm: term,
    ...(name ? { courseName: name } : {}),
    ...(code ? { courseNum: code } : {}),
    ...(teacher ? { teacherName: teacher } : {}),
    ...(department ? { departmentName: department } : {}),
    ...(campus ? { campusName: campus } : {})
  };

  const data = await client.post('/schedule/agg/schoolOpeningCoursesSchedule/querySchoolOpeningCourses', {
    pageNo: page,
    pageSize: limit,
    total: true,
    param
  }, {
    menuId: MENU_ID,
    referer: REFERER
  });

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const courses = rows.map((row) => ({
    classId: row.class_ID ?? row.sumClassesID ?? null,
    classNumber: row.sumClassesNum ?? row.classesNum ?? null,
    term: row.yearTerm ?? term,
    courseCode: row.courseNum ?? null,
    courseName: row.courseName ?? null,
    categoryName: row.courseCategoryName ?? null,
    credit: row.credit ?? row.score ?? null,
    totalHours: row.totalHours ?? null,
    department: row.departmentName ?? row.openDepartmentName ?? null,
    campus: row.campusName ?? null,
    teacher: row.teacherName ?? row.teachingTeacherName ?? null,
    scheduleText: row.timeAndPlace ?? row.scheduleInfo ?? null,
    capacity: row.classCapacity ?? row.选课容量 ?? null
  }));

  return {
    term,
    termLabel: describeTerm(term),
    page,
    limit,
    total: data?.total ?? courses.length,
    count: courses.length,
    courses,
    ...(raw ? { raw: rows } : {})
  };
}
