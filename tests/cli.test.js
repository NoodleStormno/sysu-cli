import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CookieJar } from '../src/lib/cookies.js';
import { run } from '../src/main.js';
import { normalizeTerm } from '../src/modules/term.js';
import { parseTimetableRows, weekOffset } from '../src/parsers/course-parser.js';
import { parseExamRows } from '../src/parsers/exam-parser.js';
import { computeWeightedGpa, parseGradeRows } from '../src/parsers/grade-parser.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jwxt.json');

async function invoke(args, env = {}) {
  const previous = {};
  const merged = { SYSU_BACKEND: 'mock', SYSU_MOCK_FILE: FIXTURE, ...env };
  for (const [key, value] of Object.entries(merged)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let output = '';
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
    }
  });
  try {
    const code = await run(args, { stdout });
    return { code, body: JSON.parse(output) };
  } finally {
    process.exitCode = 0;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('merges consecutive sections and keeps non-contiguous sections separate', () => {
  const entries = parseTimetableRows([
    { section: '1', monday: '算法;;张;;B201' },
    { section: '2', monday: '算法;;张;;B201' },
    { section: '5', monday: '算法;;张;;B201' }
  ], { term: '2025-1', week: 8 });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].sections, '1-2');
  assert.equal(entries[1].sections, '5');
});

test('computes credit-weighted GPA', () => {
  const rows = parseGradeRows([
    { scoCourseName: 'A', scoCredit: '4', scoFinalScore: '92', scoPoint: '4.2' },
    { scoCourseName: 'B', scoCredit: '5', scoFinalScore: '88', scoPoint: '3.8' },
    { scoCourseName: 'P/F', scoCredit: '1', scoFinalScore: '合格', scoPoint: '' }
  ]);
  const summary = computeWeightedGpa(rows);
  assert.equal(summary.gradedCredits, 9);
  assert.equal(summary.weightedGpa, 3.978);
});

test('parses exam grid cells and skips emptyFlag slots', () => {
  const exams = parseExamRows([
    {
      dataNumber: '1',
      timetable: {
        1: [{ emptyFlag: true }],
        3: [{ emptyFlag: false, examSubjectName: '操作系统', examDate: '2026-01-08', durationTime: '14:30-16:30', duration: '120', classroomNumber: 'B101' }]
      }
    }
  ], { term: '2025-1' });
  assert.equal(exams.length, 1);
  assert.equal(exams[0].courseName, '操作系统');
  assert.equal(exams[0].weekday, 3);
  assert.equal(exams[0].durationMinutes, 120);
});

test('normalizes both short and long term formats', () => {
  assert.equal(normalizeTerm('2025-1'), '2025-1');
  assert.equal(normalizeTerm('2025-2026-2'), '2025-2');
  assert.equal(normalizeTerm(undefined), 'current');
  assert.throws(() => normalizeTerm('2025-2027-1'), { code: 'INVALID_ARGUMENT' });
});

test('computes whole-week offset across week boundaries', () => {
  assert.equal(weekOffset(new Date(2026, 9, 23), new Date(2026, 9, 25)), 0); // Fri -> Sun same ISO week
  assert.equal(weekOffset(new Date(2026, 9, 23), new Date(2026, 9, 26)), 1); // Fri -> next Mon
});

test('cookie jar matches subdomains, paths, and Set-Cookie updates', () => {
  const jar = new CookieJar([
    { name: 'sid', value: 'v1', domain: '.sysu.edu.cn', path: '/jwxt' }
  ]);
  assert.equal(jar.header('https://jwxt.sysu.edu.cn/jwxt/api/login/status'), 'sid=v1');
  assert.equal(jar.header('https://jwxt.sysu.edu.cn/other'), '');
  jar.store('https://jwxt.sysu.edu.cn/jwxt/api/login/status', ['sid=v2; Path=/jwxt; HttpOnly']);
  assert.equal(jar.header('https://jwxt.sysu.edu.cn/jwxt/api/login/status'), 'sid=v2');
  assert.equal(jar.dirty, true);
});

test('CLI contract: course list, grade list, exam list succeed against mock JWXT', async () => {
  const courses = await invoke(['course', 'list']);
  assert.equal(courses.code, 0);
  assert.equal(courses.body.ok, true);
  assert.equal(courses.body.data.term, '2025-1');
  assert.equal(courses.body.data.week, 8);
  assert.equal(courses.body.data.count, 4);

  const grades = await invoke(['grade', 'list']);
  assert.equal(grades.code, 0);
  assert.equal(grades.body.data.count, 2);
  assert.equal(grades.body.data.summary.computed.weightedGpa, 3.978);
  assert.equal(grades.body.data.summary.official.avePoint, '3.98');

  const exams = await invoke(['exam', 'list', '--type', '18-19周期末考']);
  assert.equal(exams.code, 0);
  assert.equal(exams.body.data.count, 1);
  assert.equal(exams.body.data.exams[0].location, '东校区公教楼D302');
});

test('CLI contract: returns structured LOGIN_REQUIRED when session is missing', async () => {
  const res = await invoke(['course', 'list'], { SYSU_MOCK_LOGGED_OUT: '1' });
  assert.equal(res.code, 3);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'LOGIN_REQUIRED');
  assert.match(res.body.error.hint, /auth refresh/);
});

test('CLI contract: returns UNKNOWN_COMMAND and INVALID_ARGUMENT with exit code 2', async () => {
  const unknown = await invoke(['nope']);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.body.error.code, 'UNKNOWN_COMMAND');

  const badArg = await invoke(['course', 'list', '--week', 'zero']);
  assert.equal(badArg.code, 2);
  assert.equal(badArg.body.error.code, 'INVALID_ARGUMENT');
});

test('CLI contract: classroom, cet, notice, completion, program, catalog, profile, and export-ics', async () => {
  const rooms = await invoke(['classroom', 'empty', '--campus', '东校园', '--building', '公教楼', '--date', '2026-10-26', '--sections', '1-2']);
  assert.equal(rooms.code, 0);
  assert.equal(rooms.body.data.count, 1);
  assert.equal(rooms.body.data.classrooms[0].classroom, 'B201');

  const cet6 = await invoke(['cet', 'list', '--level', '6']);
  assert.equal(cet6.code, 0);
  assert.equal(cet6.body.data.count, 1);
  assert.equal(cet6.body.data.scores[0].totalScore, 560);

  const notices = await invoke(['notice', 'list', '--search', '交流']);
  assert.equal(notices.code, 0);
  assert.equal(notices.body.data.count, 1);
  assert.equal(notices.body.data.notices[0].sourceLabel, '教务部');

  const comp = await invoke(['completion', 'summary']);
  assert.equal(comp.code, 0);
  assert.equal(comp.body.data.overview.completionRate, 75.0);
  assert.equal(comp.body.data.categories[0].categoryName, '公必');

  const compCourses = await invoke(['completion', 'courses', '--search', '形势']);
  assert.equal(compCourses.code, 0);
  assert.equal(compCourses.body.data.count, 1);

  const prog = await invoke(['program', 'view']);
  assert.equal(prog.code, 0);
  assert.equal(prog.body.data.student.professionName, '计算机科学与技术');
  assert.equal(prog.body.data.courseGroups.publicRequired.count, 1);

  const cat = await invoke(['catalog', 'search', '--name', '数据结构']);
  assert.equal(cat.code, 0);
  assert.equal(cat.body.data.count, 1);
  assert.equal(cat.body.data.courses[0].courseCode, 'DCS201');

  const prof = await invoke(['profile', 'view']);
  assert.equal(prof.code, 0);
  assert.equal(prof.body.data.profile.name, '张三');
  assert.equal(prof.body.data.academicWarnings[0].count, 0);

  const ics = await invoke(['course', 'export-ics', '--week', '8']);
  assert.equal(ics.code, 0);
  assert.equal(ics.body.data.eventCount, 2);
  assert.match(ics.body.data.ics, /BEGIN:VCALENDAR/);
  assert.match(ics.body.data.ics, /SUMMARY:数据结构与算法/);
  assert.match(ics.body.data.ics, /DTSTART;TZID=Asia\/Shanghai:20251027T080000/);
});

