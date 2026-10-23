export const EXAM_WEEK_TYPES = ['缓补考', '10-17周结课考', '18-19周期末考'];

export function normalizeExamWeek(week) {
  if (!week || typeof week !== 'object') return null;
  return {
    examWeekId: week.examWeekId ?? null,
    examWeekName: week.examWeekName ?? week.weekName ?? null,
    startDate: week.startDate ?? null,
    endDate: week.endDate ?? null,
    applyRange: week.applyRange ?? null
  };
}

export function matchExamWeekType(week, type) {
  if (!type) return true;
  const name = String(week?.examWeekName ?? week?.weekName ?? '').replace(/\s+/g, '');
  if (type === '缓补考') return name.includes('缓补考');
  if (type === '10-17周结课考') return name.includes('10-17周结课考') || (name.includes('10-17周') && name.includes('结课'));
  if (type === '18-19周期末考') return name.includes('18-19周期末考') || (name.includes('18-19周') && name.includes('期末'));
  return name.includes(type.replace(/\s+/g, ''));
}

/**
 * queryStuEaxmInfo returns a grid:
 *   [{ dataNumber: "1", timetable: { "1": [cell, ...], "2": [...] } }, ...]
 * where each non-empty cell describes one exam.
 */
export function parseExamRows(rows, { term, examWeek } = {}) {
  if (!Array.isArray(rows)) return [];
  const entries = [];
  rows.forEach((row, rowIndex) => {
    const grid = row?.timetable;
    if (!grid || typeof grid !== 'object') return;
    const sectionLabel = String(row.dataNumber ?? rowIndex + 1);
    for (const [weekdayKey, cells] of Object.entries(grid)) {
      if (!Array.isArray(cells)) continue;
      const weekday = Number(weekdayKey);
      for (const cell of cells) {
        if (!cell || typeof cell !== 'object' || cell.emptyFlag) continue;
        const duration = Number(cell.duration);
        const dateValue = cell.examDate ?? null;
        const parsedDay = dateValue && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)
          ? (() => {
            const [y, m, d] = dateValue.split('-').map(Number);
            const day = new Date(y, m - 1, d).getDay();
            return day === 0 ? 7 : day;
          })()
          : null;
        entries.push({
          term: term ?? null,
          examWeekId: examWeek?.examWeekId ?? null,
          examWeekName: examWeek?.examWeekName ?? null,
          courseName: cell.examSubjectName ?? cell.courseName ?? null,
          examDate: dateValue,
          examTime: cell.durationTime ?? cell.startTime ?? null,
          durationMinutes: Number.isFinite(duration) && cell.duration !== '' ? duration : null,
          location: cell.classroomNumber ?? null,
          examStage: cell.examStage ?? null,
          examMode: cell.examMode ?? null,
          weekday: weekday >= 1 && weekday <= 7 ? weekday : parsedDay,
          sectionLabel
        });
      }
    }
  });
  return entries.sort((a, b) => String(a.examDate ?? '').localeCompare(String(b.examDate ?? ''))
    || String(a.examTime ?? '').localeCompare(String(b.examTime ?? ''))
    || String(a.courseName ?? '').localeCompare(String(b.courseName ?? ''), 'zh-CN'));
}
