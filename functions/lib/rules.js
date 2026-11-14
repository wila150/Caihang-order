// 營業規則（後台「設定」可以改）：截單時間、公休日、店家自己補單
//   settings/rules { cutoff: '22:00', closed: [0], addon: true, addonUntil: '12:00' }
// 每個請求開頭呼叫 loadRules()，讀到的規則套進 dates.js（快取 30 秒）
import { getFirestore } from 'firebase-admin/firestore';
import { CUTOFF_HOUR, CLOSED_WEEKDAYS } from './config.js';
import { setRules, getRulesNow } from './dates.js';
import { UserError } from './http.js';

// ERP 出貨單可以勾的欄位：抬頭的日期、單號、業務、電話、地址、總金額，表格的單價、金額欄，下面的簽名欄
export const SLIP_FIELDS = ['date', 'no', 'rep', 'phone', 'address', 'amount', 'price', 'total', 'sign'];
const SLIP_FIELDS_DEFAULT = ['date', 'no', 'rep', 'address', 'amount', 'price', 'total', 'sign'];
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
  prints: { on: ['buy', 'daily'], slip: 'sys', stmt: 'sys', address: '', fax: '', env: 'c5', title: '', fields: SLIP_FIELDS_DEFAULT },
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

// 業務名單：業務編號 → 名字（例如 { '1': '阿忠' }），畫面和列印顯示「業務 1・阿忠」
export async function saveRepNames(input) {
  const reps = {};
  for (const [k, v] of Object.entries(input || {}).slice(0, 50)) {
    const code = String(k).trim().slice(0, 4), name = String(v || '').trim().slice(0, 12);
    if (code && name) reps[code] = name;
  }
  // 整個 reps 欄位換掉（拿掉的業務名字才會真的刪掉），其他設定不動
  await getFirestore().doc('settings/rules').set({ reps }, { mergeFields: ['reps'] });
  setRules({ reps });
  cachedAt = Date.now();
  return reps;
}

export async function savePrints(input) {
  const p = {
    on: [...new Set((Array.isArray(input.on) ? input.on : []).filter((k) => PRINTS.includes(k)))],
    slip: input.slip === 'erp' ? 'erp' : 'sys',
    stmt: input.stmt === 'erp' ? 'erp' : 'sys',
    address: String(input.address || '').trim().slice(0, 80),
    fax: String(input.fax || '').trim().slice(0, 20),
    env: ['c5', 'dl', 'a4'].includes(input.env) ? input.env : 'c5',
    // ERP 出貨單抬頭的公司名稱（例如 ERP 上的「明恩農產行」），沒填就用 SHOP_NAME
    title: String(input.title || '').trim().slice(0, 30),
    // ERP 出貨單要印哪些欄位
    fields: Array.isArray(input.fields) ? [...new Set(input.fields.filter((k) => SLIP_FIELDS.includes(k)))] : SLIP_FIELDS_DEFAULT,
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
