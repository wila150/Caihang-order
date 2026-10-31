// 日期一律用台灣時間，格式 YYYY-MM-DD
import { CUTOFF_HOUR, CLOSED_WEEKDAYS } from './config.js';

// 營業規則：rules.js 從資料庫讀到後用 setRules 套進來
let R = { palette: 'garlic', cutoff: `${String(CUTOFF_HOUR).padStart(2, '0')}:00`, closed: CLOSED_WEEKDAYS, addon: true, addonUntil: '12:00' };
export const setRules = (r) => { R = { ...R, ...r }; };
export const getRulesNow = () => ({ ...R });
const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

const TZ = 8 * 3600e3;
const ymd = (d) => d.toISOString().slice(0, 10);

export const today = () => ymd(new Date(Date.now() + TZ));
export const thisMonth = () => today().slice(0, 7);
export const addDays = (s, n) => {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
export const weekday = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
// 嚴格檢查：2026-02-31 這種不存在的日期也要擋
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && ymd(new Date(s + 'T00:00:00Z')) === s;
export const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

// 配送日 D 的截單時刻：D 前一天的截單時間
export const cutoffOf = (D) => Date.parse(addDays(D, -1) + 'T00:00:00Z') + minutes(R.cutoff) * 60e3 - TZ;
export const isOpen = (D) => Date.now() < cutoffOf(D);

// 現在可以叫貨的配送日
export function openDate() {
  let D = addDays(today(), 1);
  for (let i = 0; i < 14; i++) {
    if (!R.closed.includes(weekday(D)) && isOpen(D)) return D;
    D = addDays(D, 1);
  }
  return D;
}

const WD = '日一二三四五六';
export const md = (D) => `${+D.slice(5, 7)}/${+D.slice(8, 10)}`;
export const label = (D) => `${md(D)}（${WD[weekday(D)]}）`;
// 截單 24:00＝配送當天 00:00（前一天半夜 12 點），顯示成「半夜 12 點」比較不會看錯
export const cutoffText = (t = R.cutoff) => (t === '24:00' ? '半夜 12 點' : t);
export const cutoffLabel = (D) => {
  const c = addDays(D, -1);
  if (R.cutoff === '24:00') return `${c === today() ? '今天' : md(c)}半夜 12 點`;
  return `${c === today() ? (minutes(R.cutoff) >= 18 * 60 ? '今晚' : '今天') : md(c)} ${cutoffText()}`;
};
export const cutoffTime = () => cutoffText();

// 現在在採買哪一天的貨：已經截單、還沒送的配送日裡最晚的那天（晚上截單後去市場買的是明天的貨）。
// 今天的貨過了補單截止（預設中午）就算送完了，改看還在叫貨的那天
export function buyDate() {
  const open = openDate();
  let pick = null;
  for (let D = today(); D < open; D = addDays(D, 1)) if (!R.closed.includes(weekday(D))) pick = D;
  if (pick === today() && Date.now() > addonUntilOf(pick)) pick = null;
  return pick || open;
}

// 店家自己補單：已截單、還沒過配送當天補單截止時間的配送日（最早的那天）；沒有就回 null
export const addonUntilOf = (D) => Date.parse(D + 'T00:00:00Z') + minutes(R.addonUntil) * 60e3 - TZ;
export const addonUntilLabel = (D) => `${D === today() ? '今天' : md(D)} ${R.addonUntil}`;
export function addonDate() {
  if (!R.addon) return null;
  const open = openDate();
  for (let D = today(); D < open; D = addDays(D, 1)) {
    if (!R.closed.includes(weekday(D)) && !isOpen(D) && Date.now() < addonUntilOf(D)) return D;
  }
  return null;
}
