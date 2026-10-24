function cleanText(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<span[^>]+class=["'][^"']*accesshide[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const LMS_BASE_URL = 'https://lms.sysu.edu.cn';

const MOD_TYPE_LABELS = {
  fsresource: '视频/富媒体',
  vod: '视频',
  resource: '课件文件',
  folder: '文件夹',
  page: '页面',
  url: '外部链接',
  assign: '作业',
  quiz: '测验',
  forum: '讨论区',
  label: '标签说明',
  questionnaire: '问卷',
  feedback: '反馈',
  choice: '投票',
  lesson: '互动课件',
  scorm: 'SCORM课件',
  book: '图书',
  glossary: '词汇表',
  wiki: 'Wiki',
  workshop: '互评作业',
  attendance: '考勤'
};

const QTYPE_LABELS = {
  multichoice: '选择题',
  truefalse: '判断题',
  shortanswer: '填空题',
  numerical: '数值题',
  essay: '简答题',
  match: '匹配题',
  ddwtos: '拖拽填空题',
  gapselect: '下拉选择题',
  calculated: '计算题',
  description: '说明材料',
  multianswer: '完形填空题'
};

function resolveUrl(href, baseUrl = LMS_BASE_URL) {
  if (!href) return '';
  try {
    return new URL(href.replace(/&amp;/g, '&'), baseUrl).href;
  } catch {
    return String(href);
  }
}

export function htmlToReadableText(html = '', baseUrl = LMS_BASE_URL) {
  if (!html) return '';
  let s = String(html);
  // Preserve images as [图片: url]
  s = s.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (_m, src) => ` [图片: ${resolveUrl(src, baseUrl)}] `);
  // Preserve line breaks for block tags
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\/\s*(?:p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n');
  // Strip remaining tags and decode HTML entities via cleanText line-by-line
  return s
    .split('\n')
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function extractMoodleConfig(html = '') {
  const m = String(html).match(/M\.cfg\s*=\s*(\{[^;]+\});/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export function isLmsAuthenticatedHtml(html = '') {
  const s = String(html);
  if (!s) return false;
  if (s.includes('您正在用访客帐号访问') || s.includes('You are currently using guest access')) {
    return false;
  }
  return s.includes('/login/logout.php') || s.includes('data-userid=');
}

export function parseLmsCategories(html = '') {
  const categories = [];
  const seen = new Set();
  const re = /href=["'][^"']*\/course\/index\.php\?categoryid=(\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html))) !== null) {
    const categoryId = String(m[1]);
    const name = cleanText(m[2]);
    if (!name || seen.has(categoryId)) continue;
    seen.add(categoryId);
    categories.push({
      categoryId,
      name,
      url: `${LMS_BASE_URL}/course/index.php?categoryid=${categoryId}`
    });
  }
  return categories;
}

export function parseLmsSearchCourses(html = '') {
  const s = String(html);
  const courses = [];
  const seen = new Set();

  // Match course boxes or links to /course/view.php?id=<id>
  const boxRe = /<div[^>]+class="[^"]*coursebox[^"]*"[^>]+data-courseid="(\d+)"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*coursebox|<div[^>]+class="[^"]*paging|$)/gi;
  let boxMatch;
  while ((boxMatch = boxRe.exec(s)) !== null) {
    const courseId = String(boxMatch[1]);
    const block = boxMatch[2];
    const nameMatch = block.match(/class="[^"]*coursename[^"]*"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/href=["'][^"']*\/course\/view\.php\?id=\d+["'][^>]*>([\s\S]*?)<\/a>/i);
    const title = cleanText(nameMatch?.[1] ?? '');
    if (!title || title === '点击进入该课程' || seen.has(courseId)) continue;
    seen.add(courseId);

    const teachers = [...block.matchAll(/<li>\s*教师\s*[:：]\s*([\s\S]*?)<\/li>/gi)]
      .map((x) => cleanText(x[1]))
      .filter(Boolean);
    const summary = cleanText(block.match(/<div[^>]+class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '');

    courses.push({
      courseId,
      title,
      ...(teachers.length > 0 ? { teachers } : {}),
      ...(summary ? { summary } : {}),
      url: `${LMS_BASE_URL}/course/view.php?id=${courseId}`
    });
  }

  if (courses.length === 0) {
    const linkRe = /href=["'][^"']*\/course\/view\.php\?id=(\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(s)) !== null) {
      const courseId = String(m[1]);
      const title = cleanText(m[2]);
      if (!title || title === '点击进入该课程' || seen.has(courseId)) continue;
      seen.add(courseId);
      courses.push({
        courseId,
        title,
        url: `${LMS_BASE_URL}/course/view.php?id=${courseId}`
      });
    }
  }

  return courses;
}

export function parseEnrolledCoursesAjax(ajaxData = {}) {
  const rawCourses = Array.isArray(ajaxData?.courses) ? ajaxData.courses : [];
  return rawCourses.map((c) => ({
    courseId: String(c.id ?? ''),
    fullname: cleanText(c.fullname ?? ''),
    shortname: cleanText(c.shortname ?? ''),
    category: cleanText(c.coursecategory ?? ''),
    progress: c.hasprogress && c.progress !== null && c.progress !== undefined ? Number(c.progress) : null,
    completed: Boolean(c.isfavourite !== undefined && c.progress === 100),
    startDate: c.startdate ? new Date(Number(c.startdate) * 1000).toISOString().slice(0, 10) : null,
    endDate: c.enddate ? new Date(Number(c.enddate) * 1000).toISOString().slice(0, 10) : null,
    url: c.viewurl || `${LMS_BASE_URL}/course/view.php?id=${c.id}`
  }));
}

function toCstDateTimeStr(epochSec) {
  const sec = Number(epochSec);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const cst = new Date(sec * 1000 + 8 * 3600 * 1000);
  return cst.toISOString().replace('T', ' ').slice(0, 16);
}

export function parseCalendarEventsAjax(ajaxData = {}) {
  const rawEvents = Array.isArray(ajaxData?.events) ? ajaxData.events : [];
  return rawEvents.map((ev) => ({
    eventId: String(ev.id ?? ''),
    name: cleanText(ev.name ?? ''),
    activityName: cleanText(ev.activityname ?? ev.name ?? ''),
    activityState: cleanText(ev.activitystr ?? ''),
    moduleType: String(ev.modulename ?? ''),
    moduleTypeLabel: MOD_TYPE_LABELS[ev.modulename] ?? String(ev.modulename ?? ''),
    instanceId: ev.instance !== undefined ? String(ev.instance) : null,
    courseId: ev.course?.id !== undefined ? String(ev.course.id) : null,
    courseName: cleanText(ev.course?.fullname ?? ''),
    dueTimestamp: Number(ev.timesort ?? ev.timestart ?? 0),
    dueTime: toCstDateTimeStr(ev.timesort ?? ev.timestart),
    overdue: Boolean(ev.overdue),
    actionName: cleanText(ev.action?.name ?? ''),
    actionable: Boolean(ev.action?.actionable),
    url: ev.action?.url || ev.url || ''
  }));
}

function parseActivityCompletion(blockHtml = '') {
  const completionRegion = blockHtml.match(/<div[^>]+data-region=["']completion-info["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1]
    || blockHtml;

  const requirements = [];
  const badgeRe = /<span[^>]+class=["'][^"']*badge\s+badge-pill\s+([^"']+)["'][^>]*>([\s\S]*?)<\/span>\s*<\/span>/gi;
  let bm;
  while ((bm = badgeRe.exec(completionRegion)) !== null) {
    const cls = bm[1];
    const text = cleanText(bm[2]);
    if (!text) continue;
    const status = cls.includes('badge-success')
      ? 'completed'
      : cls.includes('badge-danger')
        ? 'failed'
        : 'todo';
    requirements.push({ status, text });
  }

  // Also check manual completion button
  const manualDone = /data-toggletype=["']manual:undo["']/i.test(completionRegion);
  const manualTodo = /data-toggletype=["']manual:mark-done["']/i.test(completionRegion);

  let completed = null;
  if (requirements.length > 0) {
    completed = requirements.every((r) => r.status === 'completed');
  } else if (manualDone) {
    completed = true;
  } else if (manualTodo) {
    completed = false;
  }

  return {
    completed,
    requirements
  };
}

function parseActivityDates(blockHtml = '') {
  const datesRegion = blockHtml.match(/<div[^>]+data-region=["']activity-dates["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1];
  if (!datesRegion) return [];
  return [...datesRegion.matchAll(/<div>([\s\S]*?)<\/div>/gi)]
    .map((m) => cleanText(m[1]))
    .filter(Boolean);
}

export function parseCourseSectionsAndTasks(html = '', { sectionNumberFallback = null } = {}) {
  const s = String(html);
  const courseTitle = cleanText(
    s.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.replace(/^课程\s*[:：]\s*/i, '') ?? ''
  );

  // Discover linked sections if course uses one-section-per-page layout (coursedisplay=1)
  const linkedSections = [];
  const seenSec = new Set();
  const secLinkRe = /href=["']([^"']*\/course\/view\.php\?id=(\d+)&(?:amp;)?section=(\d+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  let sm;
  while ((sm = secLinkRe.exec(s)) !== null) {
    const secNum = Number(sm[3]);
    const secTitle = cleanText(sm[4]);
    if (!Number.isInteger(secNum) || seenSec.has(secNum)) continue;
    seenSec.add(secNum);
    linkedSections.push({
      sectionNumber: secNum,
      sectionName: secTitle || `第 ${secNum} 节`,
      url: resolveUrl(sm[1])
    });
  }

  // Split by section blocks if present, otherwise parse activities in the whole document
  const sectionBlocks = [...s.matchAll(/<li[^>]+id=["']section-(\d+)["'][^>]*>([\s\S]*?)(?=<li[^>]+id=["']section-\d+["']|<\/ul>\s*<\/div>\s*<\/div>|$)/gi)];
  const sections = [];
  const tasks = [];

  const parseActivitiesFromChunk = (chunk, secNum, secName) => {
    const actRe = /<li[^>]+class=["']activity\s+([^"']+)["'][^>]+id=["']module-(\d+)["'][^>]*>([\s\S]*?)(?=<li[^>]+class=["']activity\s|<\/ul>|$)/gi;
    const secTasks = [];
    let am;
    while ((am = actRe.exec(chunk)) !== null) {
      const classes = am[1];
      const cmid = String(am[2]);
      const body = am[3];
      const modType = classes.match(/modtype_([a-z0-9_]+)/i)?.[1]?.toLowerCase()
        || classes.trim().split(/\s+/)[1]?.toLowerCase()
        || 'unknown';

      const rawName = body.match(/data-activityname=["']([^"']+)["']/i)?.[1]
        || body.match(/<span[^>]+class=["'][^"']*instancename[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]
        || '';
      const name = cleanText(rawName);
      const hrefMatch = body.match(/href=["'](https?:\/\/[^"']*\/mod\/[^"']+|\/mod\/[^"']+)["']/i);
      const url = hrefMatch ? resolveUrl(hrefMatch[1]) : null;

      // Skip pure layout labels that have no link unless they have meaningful text
      if (modType === 'label' && !url) continue;

      const { completed, requirements } = parseActivityCompletion(body);
      const dates = parseActivityDates(body);
      const isVideo = modType === 'fsresource' || modType === 'vod' || (modType === 'url' && /视频|录像|回放|课/i.test(name));

      const task = {
        cmid,
        sectionNumber: secNum,
        sectionName: secName,
        type: modType,
        typeLabel: MOD_TYPE_LABELS[modType] ?? modType,
        category: isVideo ? 'video' : modType,
        name,
        url,
        completed,
        ...(requirements.length > 0 ? { requirements } : {}),
        ...(dates.length > 0 ? { dates } : {})
      };
      secTasks.push(task);
      tasks.push(task);
    }
    return secTasks;
  };

  if (sectionBlocks.length > 0) {
    for (const sb of sectionBlocks) {
      const secNum = Number(sb[1]);
      const chunk = sb[2];
      const secName = cleanText(
        chunk.match(/<h3[^>]+class=["'][^"']*sectionname[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? `第 ${secNum} 节`
      );
      const secTasks = parseActivitiesFromChunk(chunk, secNum, secName);
      const summaryCounts = [...chunk.matchAll(/<span[^>]+class=["'][^"']*activity-count[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
        .map((x) => cleanText(x[1]))
        .filter(Boolean);
      sections.push({
        sectionNumber: secNum,
        sectionName: secName,
        taskCount: secTasks.length,
        ...(summaryCounts.length > 0 ? { summaryCounts } : {}),
        tasks: secTasks
      });
    }
  } else {
    const secNum = sectionNumberFallback ?? 0;
    const secName = cleanText(s.match(/<h3[^>]+class=["'][^"']*sectionname[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '');
    const secTasks = parseActivitiesFromChunk(s, secNum, secName);
    if (secTasks.length > 0) {
      sections.push({
        sectionNumber: secNum,
        sectionName: secName,
        taskCount: secTasks.length,
        tasks: secTasks
      });
    }
  }

  return {
    courseTitle,
    sections,
    tasks,
    linkedSections
  };
}

export function parseQuizOverviewHtml(html = '') {
  const s = String(html);
  const title = cleanText(
    s.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1]
      || s.match(/<title>([\s\S]*?)<\/title>/i)?.[1]
      || ''
  );
  const intro = htmlToReadableText(
    s.match(/<div[^>]+id=["']intro["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? ''
  );
  const rules = [...s.matchAll(/<div[^>]+class=["'][^"']*quizinfo[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)]
    .flatMap((m) => [...m[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((p) => cleanText(p[1])))
    .filter(Boolean);

  // Extract existing attempts from attempt.php / review.php links
  const attempts = [];
  const seenAttempt = new Set();
  const attemptLinkRe = /href=["']([^"']*\/mod\/quiz\/(attempt|review)\.php\?[^"']*attempt=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let am;
  while ((am = attemptLinkRe.exec(s)) !== null) {
    const url = resolveUrl(am[1]);
    const mode = am[2].toLowerCase(); // 'attempt' (inprogress) or 'review' (finished)
    const attemptId = String(am[3]);
    const label = cleanText(am[4]);
    if (seenAttempt.has(`${mode}:${attemptId}`)) continue;
    seenAttempt.add(`${mode}:${attemptId}`);
    attempts.push({
      attemptId,
      mode,
      label,
      url
    });
  }

  // Also check if there is a startattempt.php form with cmid & sesskey
  const canStartAttempt = /\/mod\/quiz\/startattempt\.php/i.test(s);
  const cmidMatch = s.match(/name=["']cmid["']\s+value=["'](\d+)["']/i);
  const sesskeyMatch = s.match(/name=["']sesskey["']\s+value=["']([^"']+)["']/i);

  return {
    title,
    ...(intro ? { intro } : {}),
    ...(rules.length > 0 ? { rules } : {}),
    attempts,
    canStartAttempt,
    cmid: cmidMatch?.[1] ?? null,
    sesskey: sesskeyMatch?.[1] ?? null
  };
}

export function parseQuizQuestionsHtml(html = '') {
  const s = String(html);
  const pageTitle = cleanText(s.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '');

  // Split by question container `<div id="question-..." class="que ...">`
  const queStarts = [...s.matchAll(/<div[^>]+id=["'](question-[^"']+)["'][^>]+class=["']que\s+([^"']+)["'][^>]*>/gi)];
  const questions = [];

  for (let i = 0; i < queStarts.length; i += 1) {
    const startIdx = queStarts[i].index;
    const endIdx = i + 1 < queStarts.length ? queStarts[i + 1].index : s.length;
    const block = s.slice(startIdx, endIdx);
    const questionDomId = queStarts[i][1];
    const classes = queStarts[i][2].trim().split(/\s+/);
    const qtype = classes[0] || 'unknown';

    const qno = cleanText(
      block.match(/<span[^>]+class=["'][^"']*qno[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]
        || block.match(/<h3[^>]+class=["'][^"']*no[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1]
        || String(i + 1)
    );
    const state = cleanText(block.match(/<div[^>]+class=["'][^"']*state[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '');
    const grade = cleanText(block.match(/<div[^>]+class=["'][^"']*grade[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '');

    // Extract .qtext
    const qtextHtml = block.match(/<div[^>]+class=["'][^"']*qtext[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]+class=["'][^"']*ablock|<div[^>]+class=["'][^"']*formulation|$)/i)?.[1]
      || block.match(/<div[^>]+class=["'][^"']*qtext[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
      || '';
    const stem = htmlToReadableText(qtextHtml);

    // Extract options for multichoice / truefalse
    const options = [];
    const formulationEnd = block.search(/<div[^>]+class=["'][^"']*outcome/i);
    const answerArea = formulationEnd > 0 ? block.slice(0, formulationEnd) : block;

    if (qtype === 'multichoice' || qtype === 'truefalse') {
      const optStarts = [...answerArea.matchAll(/<div[^>]+class=["'][^"']*\b(?:r0|r1)\b[^"']*["'][^>]*>/gi)];
      for (let oi = 0; oi < optStarts.length; oi += 1) {
        const oStart = optStarts[oi].index + optStarts[oi][0].length;
        const oEnd = oi + 1 < optStarts.length ? optStarts[oi + 1].index : answerArea.length;
        const optHtml = answerArea.slice(oStart, oEnd);
        const checked = /\bchecked(?:=["']checked["'])?\b/i.test(optHtml);
        const ansNum = cleanText(
          optHtml.match(/<span[^>]+class=["'][^"']*answernumber[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ''
        );
        const cleanedOptHtml = optHtml
          .replace(/<span[^>]+class=["'][^"']*answernumber[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, '')
          .replace(/<input[^>]*>/gi, '');
        const text = htmlToReadableText(cleanedOptHtml);
        if (!text) continue;
        const label = ansNum ? ansNum.replace(/[.\s]+$/, '') : String.fromCharCode(65 + options.length);
        options.push({
          label,
          text,
          selected: checked
        });
      }
    } else if (qtype === 'match') {
      const rowRe = /<tr[^>]*>[\s\S]*?<td[^>]+class=["'][^"']*text[^"']*["'][^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]+class=["'][^"']*control[^"']*["'][^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
      let rm;
      while ((rm = rowRe.exec(answerArea)) !== null) {
        const subQuestion = htmlToReadableText(rm[1]);
        const choices = [...rm[2].matchAll(/<option[^>]*>([\s\S]*?)<\/option>/gi)]
          .map((o) => cleanText(o[1]))
          .filter((t) => t && !t.includes('请选择'));
        options.push({
          subQuestion,
          choices
        });
      }
    }

    const rightAnswer = htmlToReadableText(
      block.match(/<div[^>]+class=["'][^"']*rightanswer[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? ''
    );
    const feedback = htmlToReadableText(
      block.match(/<div[^>]+class=["'][^"']*generalfeedback[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? ''
    );

    questions.push({
      questionId: questionDomId,
      number: qno,
      type: qtype,
      typeLabel: QTYPE_LABELS[qtype] ?? qtype,
      ...(state ? { state } : {}),
      ...(grade ? { grade } : {}),
      stem,
      ...(options.length > 0 ? { options } : {}),
      ...(rightAnswer ? { rightAnswer } : {}),
      ...(feedback ? { feedback } : {})
    });
  }

  // Discover additional quiz pages (`attempt.php?attempt=...&cmid=...&page=N`)
  const extraPageUrls = [];
  const seenPage = new Set();
  const pageRe = /href=["']([^"']*\/mod\/quiz\/attempt\.php\?[^"']*page=(\d+)[^"']*)["']/gi;
  let pm;
  while ((pm = pageRe.exec(s)) !== null) {
    const pageNum = Number(pm[2]);
    if (pageNum > 0 && !seenPage.has(pageNum)) {
      seenPage.add(pageNum);
      extraPageUrls.push({ page: pageNum, url: resolveUrl(pm[1]) });
    }
  }

  return {
    pageTitle,
    questions,
    extraPageUrls
  };
}

export function formatQuizAsText(quizTitle = '', questions = []) {
  const lines = [];
  if (quizTitle) {
    lines.push(`# ${quizTitle}`);
    lines.push('');
  }

  for (const q of questions) {
    const headerParts = [`【第 ${q.number} 题】(${q.typeLabel})`];
    if (q.grade) headerParts.push(`[${q.grade}]`);
    if (q.state) headerParts.push(`(${q.state})`);
    lines.push(headerParts.join(' '));
    lines.push(q.stem || '(无题干文本)');

    if (Array.isArray(q.options) && q.options.length > 0) {
      for (const opt of q.options) {
        if (opt.subQuestion !== undefined) {
          lines.push(`  - ${opt.subQuestion} -> 候选项: ${(opt.choices ?? []).join(' / ')}`);
        } else {
          const mark = opt.selected ? '[x]' : '[ ]';
          lines.push(`  ${mark} ${opt.label}. ${opt.text}`);
        }
      }
    }
    if (q.rightAnswer) {
      lines.push(`  * 正确答案: ${q.rightAnswer}`);
    }
    if (q.feedback) {
      lines.push(`  * 解析: ${q.feedback}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
