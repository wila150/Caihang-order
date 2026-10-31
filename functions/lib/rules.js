// 營業規則（後台「設定」可以改）：截單時間、公休日、店家自己補單
//   settings/rules { cutoff: '22:00', closed: [0], addon: true, addonUntil: '12:00' }
// 每個請求開頭呼叫 loadRules()，讀到的規則套進 dates.js（快取 30 秒）
import { getFirestore } from 'firebase-admin/firestore';
import { CUTOFF_HOUR, CLOSED_WEEKDAYS } from './config.js';
import { setRules, getRulesNow } from './dates.js';
import { UserError } from './http.js';

export const DEFAULT_RULES = {
  cutoff: `${String(CUTOFF_HOUR).padStart(2, '0')}:00`, // 配送日前一天幾點截單
  closed: CLOSED_WEEKDAYS, // 不配送的星期幾（0＝週日）
  addon: true, // 截單後店家可以自己補單
  addonUntil: '12:00', // 配送當天幾點前可以補單
  autoJoin: true, // 新店家加好友後自己填店名、地址、電話就開通，不用等老闆審核
  liang: true, // 斤的品項可以叫到兩；關掉就全部只能叫整數斤（個別品項也可以在品項頁關）
  maxEdits: 2, // 店家送出後自己最多改幾次，改滿只能加不能減（0＝不限）；老闆在後台改不算
  palette: 'garlic', // 整個 App 的配色：garlic 墨綠暖白、blue 科技藍、mint 薄荷綠、gray 商務灰
  // 列印：on＝要顯示的報表按鈕（見 PRINTS），slip／stmt＝出貨單、對帳單用系統格式或 ERP 格式，address／fax 印在信封，env＝信封尺寸
  prints: { on: ['buy', 'daily'], slip: 'sys', stmt: 'sys', address: '', fax: '', env: 'c5' },
};
export const PRINTS = ['buy', 'supOrder', 'pick', 'purchase', 'daily', 'stmtBrief', 'envelope', 'arSum', 'sales'];
export const PALETTES = ['garlic', 'blue', 'mint', 'gray'];

let cachedAt = 0;
export async function loadRules() {
  if (Date.now() - cachedAt < 30e3) return getRulesNow();
  const saved = (await getFirestore().doc('settings/rules').get()).data() || {};
  setRules({ ...DEFAULT_RULES, ...saved });
  cachedAt = Date.now();
  return getRulesNow();
}

const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export async function saveRules(input) {
  const r = {
    cutoff: String(input.cutoff || ''),
    closed: [...new Set((Array.isArray(input.closed) ? input.closed : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort(),
    addon: !!input.addon,
    addonUntil: String(input.addonUntil || ''),
    autoJoin: input.autoJoin !== false,
    liang: input.liang !== false,
    maxEdits: Math.max(0, Math.min(20, Math.floor(Number(input.maxEdits)) || 0)),
  };
  // 截單 00:00 當成半夜 12 點（配送當天 00:00），不是前一天一早
  if (r.cutoff === '00:00') r.cutoff = '24:00';
  if (!isTime(r.cutoff) && r.cutoff !== '24:00') throw new UserError('截單時間格式不對，例如 22:00');
  if (!isTime(r.addonUntil)) throw new UserError('補單截止時間格式不對，例如 12:00');
  if (r.closed.length === 7) throw new UserError('不能每天都公休');
  await getFirestore().doc('settings/rules').set(r, { merge: true }); // merge：不要蓋掉配色
  setRules(r);
  cachedAt = Date.now();
  return r;
}

export async function savePrints(input) {
  const p = {
    on: [...new Set((Array.isArray(input.on) ? input.on : []).filter((k) => PRINTS.includes(k)))],
    slip: input.slip === 'erp' ? 'erp' : 'sys',
    stmt: input.stmt === 'erp' ? 'erp' : 'sys',
    address: String(input.address || '').trim().slice(0, 80),
    fax: String(input.fax || '').trim().slice(0, 20),
    env: ['c5', 'dl', 'a4'].includes(input.env) ? input.env : 'c5',
  };
  await getFirestore().doc('settings/rules').set({ prints: p }, { merge: true });
  setRules({ prints: p });
  cachedAt = Date.now();
  return p;
}

export async function savePalette(palette) {
  if (!PALETTES.includes(palette)) throw new UserError('沒有這個配色');
  await getFirestore().doc('settings/rules').set({ palette }, { merge: true });
  setRules({ palette });
  cachedAt = Date.now();
  return palette;
}
