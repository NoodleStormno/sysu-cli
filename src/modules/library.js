import { readFile } from 'node:fs/promises';

import { CliError, invalidArgument } from '../lib/errors.js';
import { paceRequest } from '../lib/rate-limit.js';
import { parseLibraryHoldingsHtml, parseLibrarySearchHtml } from '../parsers/library-parser.js';

const OPAC_BASE = process.env.SYSU_OPAC_BASE_URL || 'http://10.8.11.130:8991/F';

const FIELD_MAP = {
  any: 'WRD',
  wrd: 'WRD',
  title: 'WTI',
  wti: 'WTI',
  author: 'WAU',
  wau: 'WAU',
  subject: 'WSU',
  wsu: 'WSU',
  isbn: 'ISB',
  isb: 'ISB',
  callno: 'CAL',
  cal: 'CAL',
  publisher: 'WPU',
  wpu: 'WPU'
};

function resolveLocalBase(lang = 'zh') {
  const normalized = String(lang || 'zh').toLowerCase();
  if (['zh', 'cn', 'zsu01'].includes(normalized)) return 'ZSU01';
  if (['en', 'west', 'zsu09'].includes(normalized)) return 'ZSU09';
  throw invalidArgument(`Invalid --lang "${lang}". Use "zh" (中文文献 ZSU01) or "en" (西文文献 ZSU09).`);
}

async function fetchOpacHtml(queryString) {
  if (process.env.SYSU_BACKEND === 'mock') {
    const file = process.env.SYSU_MOCK_FILE;
    if (file) {
      const table = JSON.parse(await readFile(file, 'utf8'));
      const key = `OPAC ${queryString}`;
      if (key in table) return table[key];
    }
    throw new CliError('UPSTREAM_ERROR', `No mock OPAC fixture for ${queryString}`);
  }

  await paceRequest('library', 400);
  const url = `${OPAC_BASE}/?${queryString}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) sysu-cli/0.3'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      throw new CliError('UPSTREAM_ERROR', `Library OPAC returned HTTP ${res.status}.`, {
        details: { url, status: res.status }
      });
    }
    return await res.text();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('NETWORK_ERROR', `Failed to reach SYSU Library OPAC (${url}): ${error.message}`, {
      hint: 'Check campus network or VPN connectivity to library OPAC.',
      cause: error
    });
  }
}

export async function searchLibrary({ query, field = 'any', lang = 'zh', campus } = {}) {
  const keyword = String(query ?? '').trim();
  if (!keyword) {
    throw invalidArgument('Missing --query <keyword> for `sysu-cli library search`.');
  }
  const findCode = FIELD_MAP[String(field).toLowerCase()];
  if (!findCode) {
    throw invalidArgument(`Invalid --field "${field}". Supported: any, title, author, isbn, subject, callno, publisher.`);
  }
  const localBase = resolveLocalBase(lang);
  const qs = `func=find-b&find_code=${findCode}&request=${encodeURIComponent(keyword)}&local_base=${localBase}`;
  const html = await fetchOpacHtml(qs);
  const parsed = parseLibrarySearchHtml(html);

  let books = parsed.books;
  if (campus) {
    const q = String(campus).trim();
    books = books.filter(
      (b) => b.campuses.some((c) => c.includes(q)) || b.holdingSummary.some((h) => h.location.includes(q))
    );
  }

  return {
    query: keyword,
    field: findCode,
    base: localBase,
    campusFilter: campus ?? null,
    totalHits: parsed.totalHits,
    count: books.length,
    books
  };
}

export async function getLibraryHoldings({ doc, lang = 'zh', campus, availableOnly = false } = {}) {
  const rawDoc = String(doc ?? '').trim();
  if (!rawDoc) {
    throw invalidArgument('Missing --doc <docNumber> for `sysu-cli library holdings` (get docNumber from `library search`).');
  }
  const docNumber = rawDoc.padStart(9, '0');
  const localBase = resolveLocalBase(lang);
  const qs = `func=item-global&doc_library=${localBase}&doc_number=${encodeURIComponent(docNumber)}`;
  const html = await fetchOpacHtml(qs);
  let items = parseLibraryHoldingsHtml(html);

  if (campus) {
    const q = String(campus).trim();
    items = items.filter((item) => item.campus.includes(q) || item.subLibrary.includes(q) || item.location.includes(q));
  }
  if (availableOnly) {
    items = items.filter((item) => item.available);
  }

  return {
    docNumber,
    base: localBase,
    campusFilter: campus ?? null,
    availableOnly: Boolean(availableOnly),
    count: items.length,
    availableCount: items.filter((item) => item.available).length,
    items
  };
}
