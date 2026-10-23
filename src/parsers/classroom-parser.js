export const SECTION_FIELDS = [
  [1, 'oneSection'],
  [2, 'twoSection'],
  [3, 'threeSection'],
  [4, 'fourSection'],
  [5, 'fiveSection'],
  [6, 'sixSection'],
  [7, 'sevenSection'],
  [8, 'eightSection'],
  [9, 'nineSection'],
  [10, 'tenSection'],
  [11, 'elevenSection'],
  [12, 'twelveSection'],
  [13, 'thirteenSection'],
  [14, 'fourteenSection'],
  [15, 'fifteenSection'],
  [16, 'sixteenSection']
];

export function compressSections(sections) {
  const ordered = [...new Set(sections)].sort((a, b) => a - b);
  if (!ordered.length) return [];
  const ranges = [];
  let start = ordered[0];
  let end = ordered[0];
  for (const section of ordered.slice(1)) {
    if (section === end + 1) {
      end = section;
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = section;
      end = section;
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges;
}

export function parseClassroomRows(rows, { startSection = 1, endSection = 11, onlyEmpty = true } = {}) {
  if (!Array.isArray(rows)) return [];
  const required = [];
  for (let section = startSection; section <= endSection; section += 1) {
    required.push(section);
  }

  const rooms = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const freeSections = [];
    const occupied = [];
    for (const [section, field] of SECTION_FIELDS) {
      const cell = row[field];
      const reason = cell?.occupyReason ?? null;
      const pro = cell?.occupyPro ?? null;
      if (!reason && !pro) {
        freeSections.push(section);
      } else {
        occupied.push({ section, reason, type: pro });
      }
    }

    const freeSet = new Set(freeSections);
    const isFreeForRange = required.every((section) => freeSet.has(section));
    if (onlyEmpty && !isFreeForRange) continue;

    rooms.push({
      date: row.date ?? null,
      campus: row.campus ?? null,
      building: row.teachingBuild ?? null,
      buildingCode: row.teachingBuildNum ?? null,
      classroom: String(row.classroomNum ?? '').trim() || null,
      classroomId: row.classroomID ?? null,
      floor: row.floor ?? null,
      seats: toInt(row.seatCount ?? row.seats),
      freeInRequestedRange: isFreeForRange,
      freeRanges: compressSections(freeSections),
      freeSections,
      ...(onlyEmpty ? {} : { occupied })
    });
  }

  return rooms.sort((a, b) => String(a.building ?? '').localeCompare(String(b.building ?? ''), 'zh-CN')
    || String(a.classroom ?? '').localeCompare(String(b.classroom ?? ''), 'zh-CN', { numeric: true }));
}

function toInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && value !== '' && value !== null && value !== undefined ? Math.trunc(num) : null;
}
