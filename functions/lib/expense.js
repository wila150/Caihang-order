// 記帳（支出）：老闆、會計在 LINE 打「油錢 500」「付大成 12000 進貨」，或在後台「報表」頁記一筆
//   settings/expenseCats { items: [{ name, words: [關鍵字] }] }：分類和自動分類用的關鍵字
//   expenses/{id}        { id, date, month, amount, cat, item, payee, note, by, source: 'line' | 'admin', at }
// 進貨類的分類＝品項的分類（葉菜類、瓜果豆類…），跟品項頁同步；品名（高麗菜）會自動分到它的分類。
// 進貨的錢：那天有填進價就用進價算進貨成本，記帳的進貨只列出來不重複扣；那天沒填進價，就用記帳的進貨當進貨成本
import { getFirestore } from 'firebase-admin/firestore';
import { UserError } from './http.js';
import { today, isDate, addDays, buyDate } from './dates.js';
import { getCategories, getProducts, addBought, setDayPrices } from './shop.js';
import { roundQty } from './qty.js';

const db = () => getFirestore();
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const ref = (id) => {
  const k = clean(id, 40);
  if (!/^[\w-]+$/.test(k)) throw new UserError('找不到這筆帳，可能已經刪掉了', 404);
  return db().doc('expenses/' + k);
};
const rid = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const PURCHASE = '進貨付款';
export const OTHER = '雜支';
export const DEFAULT_CATS = [
  { name: '油錢', words: ['油錢', '加油', '汽油', '柴油', '油資'] },
  { name: '薪水', words: ['薪水', '薪資', '工資', '工讀', '員工', '獎金'] },
  { name: '房租', words: ['房租', '租金', '倉庫', '店租'] },
  { name: '水電', words: ['電費', '水費', '瓦斯', '電話費', '網路', '水電'] },
  { name: '包材', words: ['塑膠袋', '袋子', '紙箱', '箱子', '包材', '膠帶', '網袋'] },
  { name: '車子', words: ['保養', '修車', '輪胎', '停車', '過路費', 'etag', '牌照稅', '燃料稅'] },
  { name: PURCHASE, words: ['進貨', '批貨', '市場', '果菜', '貨款', '供應商'] },
  { name: OTHER, words: [] },
];

// 進貨的分類：品項有記廠商（匯入 ERP 後）就用廠商（七美、聯興…，分類就是付給誰），沒有就用品項分類（葉菜類…）
const supplierList = (products) => [...new Map(products.filter((p) => p.supplier).sort((a, b) => String(a.supplierCode || '~').localeCompare(String(b.supplierCode || '~'))).map((p) => [p.supplier, 1])).keys()];
// 回傳 [{ name, words, purchase, product, supplier, hidden }]：進貨分類在最前面（product），再來是自己的支出分類
//   用廠商的時候，舊的品項分類（以前記的葉菜類…）還是算進貨，只是不出現在選單（hidden）
export async function getCats() {
  const [saved, cats, products] = await Promise.all([
    db().doc('settings/expenseCats').get().then((d) => d.data()?.items ?? DEFAULT_CATS),
    getCategories(), getProducts(),
  ]);
  const learned = Object.fromEntries(saved.map((c) => [c.name, c.words || []]));
  const aliases = (p) => (Array.isArray(p.alias) ? p.alias : String(p.alias || '').split(/[、,，]/)).map((x) => x.trim()).filter(Boolean);
  const sups = supplierList(products);
  const bySup = sups.length > 0;
  // 品名自動分到它的廠商（打「高麗菜 1500」就是付給西螺市場）
  const short = supplierKeys(sups).filter(([k, s]) => k !== s);
  const supCats = sups.map((name) => ({
    name, purchase: true, product: true, supplier: true,
    words: [...new Set([...short.filter(([, s]) => s === name).map(([k]) => k), ...products.filter((p) => p.supplier === name).flatMap((p) => [p.name, ...aliases(p)]), ...(learned[name] || [])])],
  }));
  const prod = cats.filter((name) => !sups.includes(name)).map((name) => ({
    name, purchase: true, product: true, ...(bySup ? { hidden: true } : {}),
    words: [...new Set([...(bySup ? [] : products.filter((p) => p.cat === name).flatMap((p) => [p.name, ...aliases(p)])), ...(learned[name] || [])])],
  }));
  const fixed = new Set([...sups, ...cats]);
  return [...supCats, ...prod, ...saved.filter((c) => !fixed.has(c.name)).map((c) => ({ ...c, purchase: c.name === PURCHASE }))];
}
export const isPurchase = (cat, cats) => cat === PURCHASE || !!cats.find((c) => c.name === cat)?.purchase;

export async function saveCats(input) {
  if (!Array.isArray(input)) throw new UserError('分類格式錯誤');
  const names = new Set();
  const list = input.map((c) => {
    const name = clean(c.name, 12);
    if (!name) throw new UserError('有分類沒有填名稱');
    if (names.has(name)) throw new UserError(`分類「${name}」重複了`);
    names.add(name);
    const words = (Array.isArray(c.words) ? c.words : String(c.words || '').split(/[、,，\s]+/)).map((w) => clean(w, 12)).filter(Boolean);
    return { name, words: [...new Set(words)].slice(0, 30) };
  });
  if (!names.has(OTHER)) list.push({ name: OTHER, words: [] }); // 認不出來的都放雜支，不能刪
  // 廠商、品項分類的關鍵字只存另外加的（品名會自動帶進來）
  const [cats, products] = await Promise.all([getCategories(), getProducts()]);
  const auto = new Set(products.map((p) => p.name)), fixed = new Set([...cats, ...supplierList(products)]);
  await db().doc('settings/expenseCats').set({ items: list.map((c) => (fixed.has(c.name) ? { ...c, words: c.words.filter((w) => !auto.has(w)) } : c)) });
  return getCats();
}

// 依品名猜分類：先比分類名稱，再比關鍵字（長的先比，「電話費」不會被「電費」搶走）
export function guessCat(text, cats) {
  const t = String(text || '').toLowerCase();
  const hit = cats.find((c) => c.name !== OTHER && t.includes(c.name.toLowerCase()));
  if (hit) return hit.name;
  const pairs = cats.flatMap((c) => c.words.map((w) => [w.toLowerCase(), c.name])).sort((a, b) => b[0].length - a[0].length);
  return pairs.find(([w]) => w && t.includes(w))?.[1] || OTHER;
}

// 改分類時記住這個品名：下次打一樣的字就自動分到這類（同一個字只會在一個分類裡）
export async function learnWord(item, cat) {
  const w = clean(item, 12);
  if (!w || cat === OTHER) return;
  const cats = await getCats();
  if (guessCat(w, cats) === cat) return;
  await saveCats(cats.map((c) => ({ name: c.name, words: c.name === cat ? [...c.words.filter((x) => x !== w), w] : c.words.filter((x) => x !== w) })));
}

// 「油錢 500」「昨天 加油 1,200」「10/28 付大成 12000 @大成」「記帳 紙箱 50個 800 公司用」
// 金額＝最後一個數字（可以有 $、逗號、元、塊）；@ 後面是付給誰；其他字是品名
export function parseExpenseText(raw, now = today()) {
  let s = String(raw || '').replace(/^(記帳|支出|花費?|付款?)\s*[:：]?\s*/, '').trim();
  // 金額簡寫：1.2萬、1萬2千、12k、3千 → 數字
  s = s.replace(/(\d+(?:\.\d+)?)\s*萬\s*(?:(\d)\s*千)?/g, (_, a, b) => String(Math.round(+a * 10000 + (b ? +b * 1000 : 0))))
    .replace(/(\d+(?:\.\d+)?)\s*(千|[kK])(?![a-zA-Z])/g, (_, a) => String(Math.round(+a * 1000)));
  // 加法：「56+1590」「300 + 200 + 50」記成加起來的金額（後面跟著「=1646」也吃掉），算式留在備註；
  // 帶單位的（56斤+3斤）是數量，不算
  let sum = '';
  s = s.replace(/(?<![\d.\/])\d[\d,]*(?:\.\d+)?(?:\s*[+＋]\s*\d[\d,]*(?:\.\d+)?)+(?:\s*[=＝]\s*\d[\d,]*(?:\.\d+)?)?(?![\d.]|\s*(?:個|包|箱|斤|兩|袋|支|瓶|桶|公斤|kg|台|件|張|次|天|小時|顆|盒|捆|把|人|籃|簍|紮|綑))/i, (m) => {
    const expr = m.replace(/\s+/g, '').replace(/[=＝].*$/, '');
    sum = expr;
    return String(Math.round(expr.split(/[+＋]/).reduce((a, x) => a + Number(x.replace(/,/g, '')), 0) * 100) / 100);
  });
  let date = now;
  const rel = s.match(/^(今天|昨天|前天)\s*/);
  if (rel) { date = addDays(now, { 今天: 0, 昨天: -1, 前天: -2 }[rel[1]]); s = s.slice(rel[0].length); }
  const md = s.match(/^(\d{1,2})[/／月](\d{1,2})日?\s+/);
  if (md) {
    let y = +now.slice(0, 4);
    const d = `${y}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
    date = d > now ? `${y - 1}${d.slice(4)}` : d; // 12/30 在 1 月打，是去年
    if (!isDate(date)) return null;
    s = s.slice(md[0].length);
  }
  s = s.replace(/^(付款?|花費?)\s*/, '');
  let payee = '';
  const at = s.match(/\s*[@＠]\s*(\S+)/);
  if (at) { payee = at[1]; s = s.replace(at[0], ' '); }
  // 金額＝第一個不是數量（50個、3箱）也不是日期（7/1-8/31）的數字
  let hit = null;
  for (const x of s.matchAll(/[$＄]?\s*(\d[\d,]*(?:\.\d+)?)\s*(個|包|箱|斤|兩|袋|支|瓶|桶|公斤|kg|台|件|張|次|天|小時|顆|盒|捆|把|人|籃|簍|紮|綑|元|塊)?/gi)) {
    const prev = s[x.index - 1] || '', next = s[x.index + x[0].length] || '';
    if (/[\/\-~～]/.test(prev + next) || (x[2] && !/元|塊/.test(x[2]))) continue;
    hit = x; break;
  }
  if (!hit) return null;
  const amount = Math.round(Number(hit[1].replace(/,/g, '')));
  if (!(amount > 0 && amount < 1e8)) return null;
  let item = clean(s.slice(0, hit.index).replace(/[,，、:：\s]+$/, ''), 30);
  let after = s.slice(hit.index + hit[0].length).trim();
  if (!item) [item, after] = [clean(after, 30), '']; // 「$300 便當」
  if (!item) return null;
  return { date, amount, item, payee: clean(payee, 20), note: clean([after, sum].filter(Boolean).join(' '), 40) };
}

function normalize(input, cats) {
  const amount = Math.round(Number(input.amount));
  if (!(amount > 0 && amount < 1e8)) throw new UserError('金額不正確');
  const date = String(input.date || today());
  if (!isDate(date)) throw new UserError('日期不正確');
  const item = clean(input.item, 30);
  const cat = cats.some((c) => c.name === input.cat) ? input.cat : guessCat(`${item} ${input.note || ''} ${input.payee || ''}`, cats);
  if (!item && !input.cat) throw new UserError('請填買了什麼，例如 油錢');
  // 分類是廠商就是付給這家
  const sup = cats.find((c) => c.name === cat)?.supplier;
  return { date, month: date.slice(0, 7), amount, cat, item: item || (sup ? '進貨' : cat), payee: sup ? cat : clean(input.payee, 20), note: clean(input.note, 40) };
}

// 記帳的品名有品項和數量（「高麗菜20斤」「青蔥 2斤4兩」），就算成採買進度的已買；單位要跟品項一樣才算
export function matchBuy(item, products) {
  const t = String(item || '').replace(/\s+/g, '');
  const names = products.flatMap((p) => [p.name, ...(Array.isArray(p.alias) ? p.alias : String(p.alias || '').split(/[、,，]/))].map((n) => [String(n).trim(), p]))
    .filter(([n]) => n && t.includes(n)).sort((a, b) => b[0].length - a[0].length);
  for (const [n, p] of names) {
    const rest = t.slice(t.indexOf(n) + n.length);
    const esc = (u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = p.unit === '斤' ? rest.match(/^(?:(\d+(?:\.\d+)?)斤)?(?:(\d+)兩)?/) : rest.match(new RegExp(`^(\\d+(?:\\.\\d+)?)${esc(p.unit)}`));
    let q = p.unit === '斤' ? (m && (m[1] || m[2]) ? (+m[1] || 0) + (+m[2] || 0) / 16 : 0) : m ? +m[1] : 0;
    // 包裝單位：「高麗菜3件」＋換算 1件=10斤 → 30 斤
    if (!q) for (const k of p.packs || []) { const x = rest.match(new RegExp(`^(\\d+(?:\\.\\d+)?)${esc(k.unit)}`)); if (x) { q = +x[1] * k.n; break; } }
    if (q > 0) return { pid: p.id, name: p.name, unit: p.unit, qty: roundQty(q) };
  }
  return null;
}

// 有數量的進貨：總金額 ÷ 數量＝這次的進價（每斤多少）
const unitCost = (amount, qty) => Math.round((amount / qty) * 100) / 100;
// 把那個配送日、那個品項所有有數量的進貨加權平均，填進「單價」頁的進價（報表的毛利就照實際進價算）
async function syncCost(date, pid) {
  const snap = await db().collection('expenses').where('buy.date', '==', date).where('buy.pid', '==', pid).get();
  const L = snap.docs.map((d) => d.data().buy && d.data()).filter(Boolean);
  const qty = L.reduce((a, e) => a + e.buy.qty, 0), amount = L.reduce((a, e) => a + e.amount, 0);
  if (!(qty > 0)) return null;
  const avg = unitCost(amount, qty);
  await setDayPrices(date, {}, { [pid]: avg });
  return { avg, times: L.length };
}

// 品名裡有認得的廠商（品項上記的 ERP 供應商名稱）就當成付給這家、算進貨付款：「聯興 12000」不用打 @
// 也認簡稱：去掉字尾（西螺市場→西螺）、前兩個字（秋福豬肉→秋福），跟別家撞到或太短的不用
const SUFFIX = /(市場|商行|行|公司|食品|企業社|農產|商店)$/;
export function supplierKeys(names) {
  const list = [...new Set(names.filter((s) => s && s.length >= 2 && s !== '其他'))];
  const keys = list.map((s) => [s, s]);
  const short = [];
  for (const s of list) {
    const mine = new Set();
    const a = s.replace(SUFFIX, '');
    if (a !== s && a.length >= 2) mine.add(a);
    if (s.length > 2) mine.add(s.slice(0, 2));
    for (const k of mine) short.push([k, s]); // 同一家算一次（西螺市場：去字尾、前兩字都是「西螺」）
  }
  // 同一個簡稱對到兩家、或剛好是另一家的全名：不用
  const count = short.reduce((m, [k]) => m.set(k, (m.get(k) || 0) + 1), new Map());
  for (const [k, s] of short) if (count.get(k) === 1 && !list.includes(k) && !keys.some(([x, y]) => x === k && y !== s)) keys.push([k, s]);
  return [...new Map(keys).entries()].sort((a, b) => b[0].length - a[0].length);
}
const supplierNames = async () => supplierKeys((await getProducts()).map((p) => p.supplier));
// 字裡有哪家廠商：回傳 [打的字, 完整名稱]
export const findSupplier = (text, keys) => { const t = String(text || '').replace(/[\s　]/g, ''); return keys.find(([k]) => t.includes(k)) || null; };
// 「進貨 聯興」「付給七美」「西螺進貨」：廠商拿出來當付給誰（完整名稱），品名、備註拿掉廠商名稱（同樣是進貨，寫法統一）
function tidy(e, keys) {
  if (e.payee) return e;
  const hit = findSupplier(`${e.item || ''}${e.note || ''}`, keys);
  if (!hit) return e;
  const [k, s] = hit;
  const strip = (t) => String(t || '').replace(k, ' ').replace(/(付給|給|付)\s*$/, '').replace(/^\s*(付給|給)\s*/, '').replace(/\s+/g, ' ').trim();
  return { ...e, payee: s, item: strip(e.item) || '進貨', note: strip(e.note), cat: !e.cat || e.cat === PURCHASE || e.cat === OTHER ? s : e.cat };
}

export async function addExpense(input, { by = '', source = 'admin' } = {}) {
  const cats = await getCats();
  if (!input.payee) input = tidy(input, await supplierNames());
  // raw：LINE 傳來的原始訊息，帳記錯時可以對照（後台記帳明細、廠商總帳看得到）
  const e = { id: rid(), ...normalize(input, cats), by: clean(by, 40), source, ...(input.raw ? { raw: clean(input.raw, 200) } : {}), at: new Date().toISOString() };
  // 今天記的進貨：算進現在正在採買的那個配送日
  if (isPurchase(e.cat, cats) && e.date === today()) {
    const m = matchBuy(e.item, await getProducts());
    if (m) { e.buy = { date: buyDate(), ...m, cost: unitCost(e.amount, m.qty) }; await addBought(e.buy.date, m.pid, m.qty); }
  }
  await db().doc('expenses/' + e.id).set(e);
  if (e.buy) e.costSync = await syncCost(e.buy.date, e.buy.pid);
  return e;
}

export async function updateExpense(id, input) {
  const r = ref(id);
  const old = (await r.get()).data();
  if (!old) throw new UserError('找不到這筆帳，可能已經刪掉了', 404);
  const cats = await getCats();
  const e = { ...old, ...normalize({ ...old, ...input }, cats) };
  // 品名或數量改了：採買進度跟著改（先扣掉舊的，再加新的，配送日不變）
  const m = old.buy && isPurchase(e.cat, cats) ? matchBuy(e.item, await getProducts()) : null;
  if (old.buy && (m?.pid !== old.buy.pid || m?.qty !== old.buy.qty)) {
    await addBought(old.buy.date, old.buy.pid, -old.buy.qty);
    if (m) { e.buy = { date: old.buy.date, ...m }; await addBought(e.buy.date, m.pid, m.qty); } else delete e.buy;
  }
  if (e.buy) e.buy.cost = unitCost(e.amount, e.buy.qty);
  await r.set(e);
  // 金額或數量改了：進價重算（原本的品項和新的品項都要）
  if (old.buy) await syncCost(old.buy.date, old.buy.pid);
  if (e.buy && e.buy.pid !== old.buy?.pid) await syncCost(e.buy.date, e.buy.pid);
  return e;
}

export async function removeExpense(id) {
  const r = ref(id);
  const old = (await r.get()).data();
  if (!old) throw new UserError('找不到這筆帳，可能已經刪掉了', 404);
  if (old.buy) await addBought(old.buy.date, old.buy.pid, -old.buy.qty);
  await r.delete();
  if (old.buy) await syncCost(old.buy.date, old.buy.pid);
  return old;
}

export async function getExpense(id) {
  return (await ref(id).get()).data() || null;
}

export async function listExpenses(month) {
  const [snap, sups] = await Promise.all([db().collection('expenses').where('month', '==', month).get(), supplierNames()]);
  // 舊的記帳（還沒自動認廠商的時候記的）也照同樣的規則整理，廠商總帳才算得到
  return snap.docs.map((d) => tidy(d.data(), sups)).sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));
}

// LINE 查帳：今天／本月各分類多少
export function summarize(list) {
  const by = {};
  for (const e of list) by[e.cat] = (by[e.cat] || 0) + e.amount;
  return { total: list.reduce((a, e) => a + e.amount, 0), by: Object.entries(by).sort((a, b) => b[1] - a[1]) };
}
