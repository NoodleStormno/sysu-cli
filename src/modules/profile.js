import { JWXT_BASE } from '../lib/jwxt.js';

export async function viewProfile(client, { raw = false } = {}) {
  const roll = await client.get('/student-status/countrystu/studentRollView', {
    menuId: 'jwxsd_wdxj',
    referer: `${JWXT_BASE}/mk/studentWeb/#/myStuRoll?code=jwxsd_wdxj`
  });
  const alarms = await client.get('/alarm/alarm-archives/studentAlarmNumber', {
    referer: `${JWXT_BASE}/#/student`
  });

  return {
    profile: roll ? {
      studentNumber: roll.studentNumber ?? null,
      name: roll.basicName ?? null,
      namePinyin: roll.basicNameSpell ?? null,
      grade: roll.grade ?? roll.admissionGrade ?? null,
      college: roll.collegeName ?? roll.departmentName ?? null,
      major: roll.professionName ?? roll.majorName ?? null,
      className: roll.className ?? roll.stuClassName ?? null,
      campus: roll.campusName ?? null,
      schoolSystem: roll.schoolSystem ?? null,
      enrollmentDate: roll.admissionDate ?? roll.entranceDate ?? null,
      expectedGraduationDate: roll.expectGraduateDate ?? roll.graduateDate ?? null,
      status: roll.rollStatusName ?? roll.studentStatusName ?? null
    } : null,
    academicWarnings: (Array.isArray(alarms) ? alarms : []).map((item) => ({
      level: item.name ?? null,
      type: item.alarmType ?? null,
      count: Number(item.value ?? 0),
      color: item.color ?? null
    })),
    ...(raw ? { raw: { roll, alarms } } : {})
  };
}
