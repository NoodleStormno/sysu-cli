import { JWXT_BASE } from '../lib/jwxt.js';
import { parseCetRows } from '../parsers/cet-parser.js';

const MENU_ID = 'jwxsd_sljcjcx';
const REFERER = `${JWXT_BASE}/mk/#/stuEnglishGradeAchievement?code=${MENU_ID}`;

export async function listCetScores(client, { level, raw = false } = {}) {
  const data = await client.post('/achievement-manage/englishGradeAchievement/stuPageList', {
    pageNo: 1,
    pageSize: 200,
    total: true,
    param: {}
  }, {
    menuId: MENU_ID,
    referer: REFERER
  });

  const rows = Array.isArray(data?.rows) ? data.rows : (Array.isArray(data) ? data : []);
  const scores = parseCetRows(rows, { level });
  return {
    ...(level ? { level: `CET${level}` } : {}),
    totalRecords: rows.length,
    count: scores.length,
    scores,
    ...(raw ? { raw: rows } : {})
  };
}
