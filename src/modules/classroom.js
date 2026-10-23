import { invalidArgument } from '../lib/errors.js';
import { JWXT_BASE } from '../lib/jwxt.js';
import { parseClassroomRows } from '../parsers/classroom-parser.js';
import { formatDate } from './course.js';

const MENU_ID = 'jwxsd_jsskqkjkxjscx';
const REFERER = `${JWXT_BASE}/mk/schedule-web/#/classroomCheckStu?code=${MENU_ID}`;

export async function listCampuses(client) {
  const rows = await client.get('/base-info/campus/findCampusNamesBox', { menuId: MENU_ID, referer: REFERER });
  const campuses = (Array.isArray(rows) ? rows : []).map((item) => ({
    id: String(item.id ?? ''),
    code: String(item.campusNumber ?? ''),
    name: item.campusName ?? null
  }));
  return { count: campuses.length, campuses };
}

export async function listBuildings(client, { campus } = {}) {
  const resolvedCampus = campus ? await resolveCampus(client, campus) : null;
  const rows = await client.get('/base-info/teaching-building/pull', {
    query: { campusId: resolvedCampus?.id ?? '' },
    menuId: MENU_ID,
    referer: REFERER
  });
  const buildings = (Array.isArray(rows) ? rows : []).map((item) => ({
    id: String(item.id ?? ''),
    code: String(item.code ?? ''),
    name: item.name ?? null,
    floors: item.floorNumber !== undefined ? Number(item.floorNumber) : null
  }));
  return {
    ...(resolvedCampus ? { campus: resolvedCampus } : {}),
    count: buildings.length,
    buildings
  };
}

export async function queryClassrooms(client, {
  campus,
  building,
  date,
  sections = '1-11',
  all = false,
  pageSize = 200,
  raw = false
} = {}) {
  if (!building) {
    throw invalidArgument('`--building <名称或ID>` is required by JWXT (run `sysu-cli classroom buildings --campus <校区>` to list buildings).');
  }
  const [startSection, endSection] = parseSectionRange(sections);
  const dateStr = formatDate(date ?? new Date());
  const resolvedCampus = campus ? await resolveCampus(client, campus) : null;
  const resolvedBuilding = await resolveBuilding(client, building, resolvedCampus?.id);

  const body = {
    pageNo: 1,
    pageSize,
    total: true,
    param: {
      ...(resolvedCampus ? { campusId: resolvedCampus.id } : {}),
      teachingBuildID: resolvedBuilding.id,
      dateA: dateStr,
      dateB: dateStr,
      sectionA: String(startSection),
      sectionB: String(endSection),
      weekOrTime: 'time'
    }
  };
  const result = await client.post('/schedule/agg/classroomOccupy/pageCheckList', body, {
    menuId: MENU_ID,
    referer: REFERER
  });
  const rawRows = Array.isArray(result?.data) ? result.data : (Array.isArray(result) ? result : []);
  const rooms = parseClassroomRows(rawRows, { startSection, endSection, onlyEmpty: !all });

  return {
    date: dateStr,
    sections: `${startSection}-${endSection}`,
    ...(resolvedCampus ? { campus: resolvedCampus } : {}),
    building: resolvedBuilding,
    onlyEmpty: !all,
    count: rooms.length,
    classrooms: rooms,
    ...(raw ? { raw: rawRows } : {})
  };
}

export function parseSectionRange(spec = '1-11') {
  const text = String(spec).trim();
  const single = text.match(/^(\d{1,2})$/);
  if (single) {
    const n = Number(single[1]);
    if (n >= 1 && n <= 16) return [n, n];
  }
  const range = text.match(/^(\d{1,2})-(\d{1,2})$/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start >= 1 && end <= 16 && start <= end) return [start, end];
  }
  throw invalidArgument(`Invalid --sections "${spec}". Use N or M-N within 1..16 (e.g. "1-2" or "5-8").`);
}

async function resolveCampus(client, input) {
  const { campuses } = await listCampuses(client);
  const norm = normalizeKey(input);
  const matched = campuses.find((item) => normalizeKey(item.id) === norm
    || normalizeKey(item.code) === norm
    || normalizeKey(item.name) === norm
    || normalizeKey(item.name).includes(norm));
  if (!matched) {
    throw invalidArgument(`Campus "${input}" not found.`, { available: campuses });
  }
  return matched;
}

async function resolveBuilding(client, input, campusId) {
  const rows = await client.get('/base-info/teaching-building/pull', {
    query: { campusId: campusId ?? '' },
    menuId: MENU_ID,
    referer: REFERER
  });
  const buildings = (Array.isArray(rows) ? rows : []).map((item) => ({
    id: String(item.id ?? ''),
    code: String(item.code ?? ''),
    name: item.name ?? null
  }));
  const norm = normalizeKey(input);
  const exact = buildings.find((item) => normalizeKey(item.id) === norm
    || normalizeKey(item.code) === norm
    || normalizeKey(item.name) === norm);
  if (exact) return exact;
  const fuzzy = buildings.filter((item) => normalizeKey(item.name).includes(norm));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw invalidArgument(`Building "${input}" matched multiple buildings; be more specific.`, { candidates: fuzzy });
  }
  throw invalidArgument(`Building "${input}" was not found.`, { availableCount: buildings.length, sample: buildings.slice(0, 15) });
}

function normalizeKey(value) {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}
