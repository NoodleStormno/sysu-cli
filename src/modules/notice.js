import { JWXT_BASE } from '../lib/jwxt.js';

const REFERER = `${JWXT_BASE}/#/student`;

export async function listNotices(client, { category = 'all', search, limit = 20 } = {}) {
  const data = await client.get('/system-manage/info-delivery', {
    query: { status: 1, number: 4, deliveryObject: '02' },
    referer: REFERER
  });

  const buckets = [];
  if (category === 'all' || category === 'education') {
    for (const item of data?.education ?? []) {
      buckets.push(normalizeNotice(item, 'education'));
    }
  }
  if (category === 'all' || category === 'college') {
    for (const item of data?.college ?? []) {
      buckets.push(normalizeNotice(item, 'college'));
    }
  }

  const keyword = search ? String(search).trim().toLowerCase() : null;
  const filtered = keyword
    ? buckets.filter((item) => String(item.title ?? '').toLowerCase().includes(keyword))
    : buckets;

  filtered.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))
    || Number(b.top) - Number(a.top));

  const sliced = filtered.slice(0, limit);
  return {
    category,
    ...(keyword ? { search } : {}),
    totalMatched: filtered.length,
    count: sliced.length,
    notices: sliced
  };
}

function normalizeNotice(item, source) {
  return {
    id: item?.id ?? null,
    source,
    sourceLabel: source === 'education' ? '教务部' : '院系',
    title: item?.title ?? null,
    date: item?.deliveryDate ?? null,
    top: item?.topMark === '1' || item?.topMark === 1,
    isNew: item?.newDeliveryMark === '1' || item?.newDeliveryMark === 1
  };
}
