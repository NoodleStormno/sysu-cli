export const WEEKDAY_FIELDS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * JWXT selectStudentClassTable returns one row per section. Each weekday cell
 * has `,,`-separated blocks, and each block has `;;`-separated tokens in
 * either key:value form:
 *   "xslx:bk;;kcmc:数据结构与算法;;rkjs:张老师;;skdd:公教楼B201;;0;;jxb:202600001;;...;;skrq:第7周/2026-10-19/星期一/"
 * or legacy positional form: "课程;;教师;;地点".
 * Consecutive sections of the same course/teacher/location are merged.
 */
export function parseTimetableRows(rows, { term, week } = {}) {
  if (!Array.isArray(rows)) return [];
  const cells = [];

  for (const row of rows) {
    const section = Number(row?.section);
    if (!Number.isInteger(section)) continue;
    WEEKDAY_FIELDS.forEach((field, index) => {
      const value = row[field];
      if (!value || typeof value !== 'string') return;
      for (const block of value.split(',,')) {
        const parsed = parseCellBlock(block);
        if (!parsed) continue;
        cells.push({
          weekday: index + 1,
          section,
          ...parsed
        });
      }
    });
  }

  const groups = new Map();
  for (const cell of cells) {
    const key = [cell.weekday, cell.courseName, cell.teacher, cell.location, cell.classCode].join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cell);
  }

  const entries = [];
  for (const items of groups.values()) {
    const ordered = [...new Map(items.map((item) => [item.section, item])).values()]
      .sort((a, b) => a.section - b.section);
    let start = ordered[0];
    let end = ordered[0];
    const flush = () => {
      entries.push({
        term: term ?? null,
        week: week ?? null,
        weekday: start.weekday,
        weekdayName: WEEKDAY_NAMES[start.weekday - 1],
        ...(start.date ? { date: start.date } : {}),
        startSection: start.section,
        endSection: end.section,
        sections: start.section === end.section ? `${start.section}` : `${start.section}-${end.section}`,
        courseName: start.courseName,
        teacher: start.teacher,
        location: start.location,
        ...(start.classCode ? { classCode: start.classCode } : {})
      });
    };
    for (const item of ordered.slice(1)) {
      if (item.section === end.section + 1) {
        end = item;
      } else {
        flush();
        start = item;
        end = item;
      }
    }
    flush();
  }

  return entries.sort((a, b) => a.weekday - b.weekday
    || a.startSection - b.startSection
    || a.courseName.localeCompare(b.courseName, 'zh-CN'));
}

export function parseCellBlock(block) {
  const parts = String(block ?? '').split(';;').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;

  const kv = {};
  let kvCount = 0;
  for (const part of parts) {
    const match = part.match(/^([a-zA-Z]+):(.*)$/);
    if (match) {
      kv[match[1]] = match[2].trim();
      kvCount += 1;
    }
  }

  if (kvCount > 0 && kv.kcmc) {
    const campusLoc = kv.sameTeacherDiffPlaceTime
      ?.split('===')
      .map((seg) => seg.split('//')[1]?.trim())
      .find(Boolean);
    const dateMatch = kv.skrq?.match(/(\d{4}-\d{2}-\d{2})/);
    return {
      courseName: kv.kcmc,
      teacher: kv.rkjs || null,
      location: campusLoc || kv.skdd || null,
      classCode: kv.jxb || null,
      date: dateMatch ? dateMatch[1] : null
    };
  }

  return {
    courseName: parts[0],
    teacher: parts[1] || null,
    location: parts[2] || null,
    classCode: null,
    date: null
  };
}

/** ISO weekday (1 = Monday ... 7 = Sunday) for a local Date. */
export function isoWeekday(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

/** Whole-week difference between the Mondays of two local dates. */
export function weekOffset(from, to) {
  const monday = (date) => {
    const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    copy.setDate(copy.getDate() - (isoWeekday(copy) - 1));
    return copy;
  };
  const diffDays = Math.round((monday(to) - monday(from)) / 86400000);
  return Math.round(diffDays / 7);
}
