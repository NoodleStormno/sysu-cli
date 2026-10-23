import { createRequire } from 'node:module';

import { kebab, parseArgs } from './lib/args.js';
import { CliError, exitCodeFor, toErrorPayload } from './lib/errors.js';
import { withClient } from './lib/jwxt.js';
import * as auth from './modules/auth.js';
import * as catalog from './modules/catalog.js';
import * as cet from './modules/cet.js';
import * as classroom from './modules/classroom.js';
import * as completion from './modules/completion.js';
import * as course from './modules/course.js';
import * as dev from './modules/dev.js';
import { doctor } from './modules/doctor.js';
import * as exam from './modules/exam.js';
import * as grade from './modules/grade.js';
import * as notice from './modules/notice.js';
import * as profile from './modules/profile.js';
import * as program from './modules/program.js';
import { getTermInfo } from './modules/term.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const COMMANDS = {
  'doctor': {
    summary: 'Check Node.js, Playwright, saved session, and JWXT reachability.',
    options: { offline: { type: 'boolean' }, json: { type: 'boolean' } },
    run: ({ options }) => doctor(options)
  },
  'auth login': {
    summary: 'Open a browser on SYSU unified auth; save the JWXT session after you log in.',
    options: {
      browser: { type: 'string', choices: ['chrome', 'edge', 'chromium'] },
      timeout: { type: 'integer', min: 15, max: 900 },
      json: { type: 'boolean' }
    },
    run: ({ options }) => auth.login({ browser: options.browser, timeoutMs: options.timeout ? options.timeout * 1000 : undefined })
  },
  'auth refresh': {
    summary: 'Silently renew the JWXT session from the saved unified-auth browser profile.',
    options: {
      browser: { type: 'string', choices: ['chrome', 'edge', 'chromium'] },
      json: { type: 'boolean' }
    },
    run: ({ options }) => auth.refresh(options)
  },
  'auth status': {
    summary: 'Check whether the saved JWXT session is currently active.',
    options: { json: { type: 'boolean' } },
    run: () => auth.status()
  },
  'auth logout': {
    summary: 'Delete the saved session and local sysu-cli browser profiles.',
    options: { json: { type: 'boolean' } },
    run: () => auth.logout()
  },
  'term current': {
    summary: 'Return the current academic term and teaching week from JWXT.',
    options: { term: { type: 'string' }, json: { type: 'boolean' } },
    run: ({ options }) => withClient((client) => getTermInfo(client, options))
  },
  'course list': {
    summary: 'List timetable courses for a term and teaching week (defaults to current).',
    options: {
      term: { type: 'string' },
      week: { type: 'integer', min: 1, max: 30 },
      weekday: { type: 'integer', min: 1, max: 7 },
      raw: { type: 'boolean' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => course.listCourses(client, options))
  },
  'course today': {
    summary: "List courses on today's date (or --date YYYY-MM-DD) in the current term.",
    options: {
      date: { type: 'date' },
      raw: { type: 'boolean' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => course.coursesOnDate(client, options))
  },
  'course export-ics': {
    summary: 'Export timetable courses for a week or week range as an iCalendar (.ics) file or string.',
    options: {
      term: { type: 'string' },
      week: { type: 'integer', min: 1, max: 30 },
      fromWeek: { type: 'integer', min: 1, max: 30 },
      toWeek: { type: 'integer', min: 1, max: 30 },
      out: { type: 'string' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => course.exportCoursesIcs(client, options))
  },
  'grade list': {
    summary: 'List course grades, computed weighted GPA, and official rank summary for a term.',
    options: {
      term: { type: 'string' },
      raw: { type: 'boolean' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => grade.listGrades(client, options))
  },
  'grade credits': {
    summary: 'Return credit completion overview and score distribution.',
    options: { json: { type: 'boolean' } },
    run: () => withClient((client) => grade.creditSummary(client))
  },
  'exam weeks': {
    summary: 'List exam weeks configured for a term.',
    options: { term: { type: 'string' }, json: { type: 'boolean' } },
    run: ({ options }) => withClient((client) => exam.listExamWeeks(client, options))
  },
  'exam list': {
    summary: 'List scheduled exams for a term (filterable by --type or --week-id).',
    options: {
      term: { type: 'string' },
      type: { type: 'string' },
      weekId: { type: 'string' },
      raw: { type: 'boolean' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => exam.listExams(client, options))
  },
  'classroom campuses': {
    summary: 'List SYSU campuses with their JWXT IDs and codes.',
    options: { json: { type: 'boolean' } },
    run: () => withClient((client) => classroom.listCampuses(client))
  },
  'classroom buildings': {
    summary: 'List teaching buildings (optionally filtered by --campus).',
    options: {
      campus: { type: 'string' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => classroom.listBuildings(client, options))
  },
  'classroom empty': {
    summary: 'Query empty (or all with --all) classrooms in a teaching building on a date and section range.',
    options: {
      campus: { type: 'string' },
      building: { type: 'string' },
      date: { type: 'date' },
      sections: { type: 'string' },
      all: { type: 'boolean' },
      raw: { type: 'boolean' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => classroom.queryClassrooms(client, options))
  },
  'cet list': {
    summary: 'List CET-4 / CET-6 exam score records.',
    options: {
      level: { type: 'integer', choices: [4, 6] },
      raw: { type: 'boolean' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => cet.listCetScores(client, options))
  },
  'notice list': {
    summary: 'List JWXT academic notices from the Undergraduate Office (education) and colleges.',
    options: {
      category: { type: 'string', choices: ['all', 'education', 'college'] },
      search: { type: 'string' },
      limit: { type: 'integer', min: 1, max: 200 },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => notice.listNotices(client, options))
  },
  'completion summary': {
    summary: 'Show graduation credit completion rate and per-category credit breakdown.',
    options: {
      cultureType: { type: 'string' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => completion.completionSummary(client, options))
  },
  'completion courses': {
    summary: 'List courses under the graduation completion audit (filterable by --category or --search).',
    options: {
      cultureType: { type: 'string' },
      category: { type: 'string' },
      search: { type: 'string' },
      limit: { type: 'integer', min: 1, max: 500 },
      raw: { type: 'boolean' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => completion.completionCourses(client, options))
  },
  'program view': {
    summary: 'View personal training program (个人培养方案) basic info, credit requirements, and course tables.',
    options: {
      category: { type: 'string' },
      search: { type: 'string' },
      raw: { type: 'boolean' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => program.viewProgram(client, options))
  },
  'catalog search': {
    summary: 'Search university-wide course offerings (全校开课课程) for a term.',
    options: {
      term: { type: 'string' },
      name: { type: 'string' },
      code: { type: 'string' },
      teacher: { type: 'string' },
      department: { type: 'string' },
      campus: { type: 'string' },
      page: { type: 'integer', min: 1, max: 1000 },
      limit: { type: 'integer', min: 1, max: 100 },
      raw: { type: 'boolean' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => catalog.searchCatalog(client, options))
  },
  'profile view': {
    summary: 'View student academic record (我的学籍) and academic warning (学业预警) counts.',
    options: {
      raw: { type: 'boolean' },
      json: { type: 'boolean' }
    },
    run: ({ options }) => withClient((client) => profile.viewProfile(client, options))
  },
  'dev capture': {
    summary: 'Open a browser and record JSON XHR responses under /jwxt/ to inspect new endpoints.',
    options: {
      url: { type: 'string' },
      browser: { type: 'string', choices: ['chrome', 'edge', 'chromium'] },
      json: { type: 'boolean' }
    },
    run: ({ options }) => dev.capture(options)
  }
};

export async function run(argv, { stdout = process.stdout } = {}) {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    writeJson(stdout, { ok: true, command: 'version', data: { name: pkg.name, version: pkg.version } });
    return 0;
  }
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    const topic = argv.filter((arg) => !arg.startsWith('-') && arg !== 'help').join(' ');
    writeJson(stdout, { ok: true, command: 'help', data: buildHelp(topic) });
    return 0;
  }

  let commandKey = null;
  let rest = [];
  const twoWord = argv.slice(0, 2).join(' ');
  if (Object.hasOwn(COMMANDS, twoWord)) {
    commandKey = twoWord;
    rest = argv.slice(2);
  } else if (Object.hasOwn(COMMANDS, argv[0])) {
    commandKey = argv[0];
    rest = argv.slice(1);
  }

  if (!commandKey) {
    const error = new CliError('UNKNOWN_COMMAND', `Unknown command "${argv.slice(0, 2).join(' ')}".`, {
      hint: 'Run `sysu-cli --help` to see all supported commands.',
      details: { commands: Object.keys(COMMANDS) }
    });
    writeJson(stdout, { ok: false, command: argv.slice(0, 2).join(' ') || null, error: toErrorPayload(error) });
    process.exitCode = exitCodeFor(error.code);
    return process.exitCode;
  }

  const entry = COMMANDS[commandKey];
  try {
    const parsed = parseArgs(rest, entry.options);
    const data = await entry.run(parsed);
    writeJson(stdout, { ok: true, command: commandKey, data });
    return 0;
  } catch (error) {
    const payload = toErrorPayload(error);
    writeJson(stdout, { ok: false, command: commandKey, error: payload });
    process.exitCode = exitCodeFor(payload.code);
    return process.exitCode;
  }
}

function buildHelp(topic) {
  if (topic && COMMANDS[topic]) {
    return {
      command: topic,
      summary: COMMANDS[topic].summary,
      options: formatOptions(COMMANDS[topic].options)
    };
  }
  return {
    name: pkg.name,
    version: pkg.version,
    commands: Object.fromEntries(
      Object.entries(COMMANDS).map(([name, def]) => [name, { summary: def.summary, options: formatOptions(def.options) }])
    )
  };
}

function formatOptions(options = {}) {
  return Object.fromEntries(
    Object.entries(options)
      .filter(([key]) => key !== 'json')
      .map(([key, spec]) => [`--${kebab(key)}`, spec.choices ? `${spec.type} (${spec.choices.join('|')})` : spec.type])
  );
}

function writeJson(stream, payload) {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}
