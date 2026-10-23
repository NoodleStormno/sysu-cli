function stripTags(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferCampus(text = '') {
  const s = String(text);
  for (const campus of ['南校园', '北校园', '东校园', '珠海校区', '深圳校区']) {
    if (s.includes(campus)) return campus;
  }
  if (s.includes('南校')) return '南校园';
  if (s.includes('北校')) return '北校园';
  if (s.includes('东校')) return '东校园';
  if (s.includes('珠海')) return '珠海校区';
  if (s.includes('深圳')) return '深圳校区';
  return '';
}

function parseQrSummary(qrRaw = '') {
  if (!qrRaw) return [];
  const decoded = decodeURIComponent(qrRaw.replace(/\+/g, ' '));
  return decoded
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s{2,}/);
      const location = (parts[0] ?? line).trim();
      const callNumber = (parts[1] ?? '').trim();
      return {
        campus: inferCampus(location),
        location,
        callNumber
      };
    });
}

export function parseLibrarySearchHtml(html = '') {
  const text = String(html);
  const hitMatch = text.match(/of\s+(\d+)/i) || text.match(/共\s*(\d+)\s*条/);
  const totalHits = hitMatch ? Number(hitMatch[1]) : 0;
  const sessionMatch = text.match(/http:\/\/10\.8\.11\.130:8991\/F\/[A-Z0-9-]+/);
  const sessionUrl = sessionMatch ? sessionMatch[0] : null;

  const chunks = text.split(/<!--\s*filename:\s*short-lcl-body\s*-->/i).slice(1);
  const books = [];

  for (const chunk of chunks) {
    const docNumber = (chunk.match(/DOC-NUMBER\s*\(\d+\)\s*=\s*([0-9A-Za-z]+)/) ?? [])[1] ?? '';
    if (!docNumber) continue;

    const base = ((chunk.match(/Z05-BASE\s*\(\d+\)\s*=\s*([0-9A-Za-z]+)/) ?? [])[1] ?? 'ZSU01').trim();
    const isbn = ((chunk.match(/Z13-ISBN-ISSN\s*\(\d+\)\s*=\s*([^\r\n]+)/) ?? [])[1] ?? '').trim();
    const totalItems = Number(((chunk.match(/TOTAL-NUMBER-OF-ITEMS\s*\(\d+\)\s*=\s*(\d+)/) ?? [])[1] ?? 0));
    const loanedItems = Number(((chunk.match(/TOTAL-NUMBER-OF-LOANED-ITEM\s*\(\d+\)\s*=\s*(\d+)/) ?? [])[1] ?? 0));
    const qrRaw = ((chunk.match(/QR\s*\(\d+\)\s*=\s*([^\r\n]+)/) ?? [])[1] ?? '').trim();

    const titleMatch = chunk.match(/<div\s+class=itemtitle[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch ? stripTags(titleMatch[1]) : '';

    const extractField = (label) => {
      const re = new RegExp(`<td[^>]*>\\s*${label}[：:]\\s*<td[^>]*>([\\s\\S]*?)(?:<td|<\\/tr|<\\/table)`, 'i');
      const m = chunk.match(re);
      return m ? stripTags(m[1]) : '';
    };

    const author = extractField('作者');
    const callNumber = extractField('索书号');
    const publisher = extractField('出版社');
    const year = extractField('年份');
    const holdingSummary = parseQrSummary(qrRaw);
    const campuses = [...new Set(holdingSummary.map((h) => h.campus).filter(Boolean))];

    books.push({
      docNumber,
      base,
      title,
      author,
      publisher,
      year,
      isbn,
      callNumber,
      totalItems,
      loanedItems,
      availableItems: Math.max(0, totalItems - loanedItems),
      campuses,
      holdingSummary
    });
  }

  return {
    totalHits: totalHits || books.length,
    sessionUrl,
    books
  };
}

export function parseLibraryHoldingsHtml(html = '') {
  const text = String(html);
  const rows = [...text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const items = [];

  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripTags(c[1]));
    if (cells.length < 8) continue;
    const loanType = cells[2] ?? '';
    const status = cells[3] ?? '';
    const subLibrary = cells[5] ?? '';
    const location = cells[6] ?? '';
    const callNumber = cells[7] ?? '';
    const barcode = cells[11] ?? '';

    if (
      !subLibrary ||
      !callNumber ||
      subLibrary.includes('选择分馆') ||
      loanType.includes('选择') ||
      location.includes('隐藏已外借') ||
      loanType === '单册状态'
    ) {
      continue;
    }
    const available = status === '在架上';

    items.push({
      barcode,
      callNumber,
      loanType,
      status,
      available,
      campus: inferCampus(`${subLibrary} ${location}`),
      subLibrary,
      location
    });
  }

  return items;
}
