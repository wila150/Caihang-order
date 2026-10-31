// 資料都放在 Firestore：
//   settings/products   { items: 品項清單 }
//   settings/units      { items: 單位清單 }
//   stores/{id}         店家（含路線站號、綁定的 LINE 帳號 members）
//   members/{userId}    { storeId }：LINE 帳號屬於哪家店
//   pending/{userId}    申請開通的人
//   orders/{日期}_{店}   訂單（每家店每個配送日一張；簽收後追加的「補單」是 {日期}_{店}-2、-3…，seq 欄位記第幾張）
//   dayPrices/{日期}     { prices: { pid: 單價 } }：老闆確認過的當天單價
//   monthly/{YYYY-MM}   { amounts: { "日期|店[-補單號]": 金額 } }：對帳用的每日金額，一次讀完一整個月
//   paid/{YYYY-MM}      { stores: { 店: { list: [{ id, amount, date, method, note, by, at }] } } }：這個月貨款的每一筆收款（舊資料只有 { at }＝整月收清）
//   settings/priceGroups { items: 報價組 }：店家 groupId 對到這裡，決定拿基本價的幾折或固定價
//   users/{uid}         後台帳號的角色（見 lib/auth.js）
//   bought/{日期}        { items: { pid: 數量 } }：採買進度，這個配送日的貨已經買了多少
//   storeAliases/{店}    { items: [{ text, pid }] }：只有這家店用的叫法（例如這家說「大的」是指某個品項）
//   storeHistory/{店}    { items: { pid: 金額 }, at }：從 ERP「客戶產品銷售統計表」匯進來的，這家店以前買過什麼（AI 分粗細大小、叫貨頁「常用」）
import crypto from 'node:crypto';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PRESET, DEFAULT_PRODUCTS, CATEGORIES, DEFAULT_UNITS, UNITS_VERSION, UNITS_ADDED } from './config.js';
import { qtyText, roundQty } from './qty.js';
import { UserError } from './http.js';
import { openDate, isDate, today, addonDate, getRulesNow, cutoffLabel, addonUntilLabel } from './dates.js';

const db = () => getFirestore();
const doc = (path) => db().doc(path);
const data = async (path) => (await doc(path).get()).data() ?? null;

const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clean = (s, max) => String(s ?? '').trim().slice(0, max);

/* ---------- 品項 ---------- */
// 品項有兩千多項（約 400KB），一次載入會被讀好幾次：暫存 3 秒，這台改了品項馬上清掉（別台最多晚 3 秒）
let prodCache = null, prodAt = 0;
export const bustProducts = () => { prodCache = null; };
export async function getProducts() {
  await ensureMigrated();
  if (!prodCache || Date.now() - prodAt > 3000) {
    prodAt = Date.now();
    prodCache = data('settings/products').then((d) => d?.items ?? DEFAULT_PRODUCTS).catch((e) => { prodCache = null; throw e; });
  }
  return prodCache;
}

/* ---------- 包裝換算：1 件＝10 斤、1 箱＝20 斤（數量一律換成品項的單位） ---------- */
// 輸入「件=10、箱=20」或 [{ unit, n }]，回傳 [{ unit, n }]
export function packList(v, unit) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[、,，;；\n]/).map((s) => {
    const m = s.trim().match(/^1?\s*([^\d=＝\s]+)\s*[=＝]\s*(\d+(?:\.\d+)?)/);
    if (s.trim() && !m) throw new UserError(`換算「${s.trim()}」看不懂，例如：件=10、箱=20`);
    return m && { unit: m[1], n: +m[2] };
  });
  const seen = new Set();
  return arr.filter((x) => x && x.unit && x.unit !== unit && +x.n > 0 && !seen.has(x.unit) && seen.add(x.unit)).map((x) => ({ unit: clean(x.unit, 6), n: roundQty(+x.n) })).slice(0, 5);
}

/* ---------- 別名（客人常打的寫法，給 AI 對照） ---------- */
// 舊資料是一串字（用、或逗號隔開），新的存成陣列；兩種都讀得懂
export const ALIAS_MAX = 50; // 每個品項最多幾個叫法
export function aliasList(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[、,，;；\n]/);
  return [...new Set(arr.map((s) => clean(s, 20)).filter(Boolean))].slice(0, ALIAS_MAX);
}

// 從 AI 紀錄「看不懂」加叫法。storeId 有填＝只有這家店用；沒填＝全部店家通用
export async function addAlias({ text, pid, storeId }) {
  text = clean(text, 20);
  if (!text) throw new UserError('請填客人寫的叫法');
  const products = await getProducts();
  const p = products.find((x) => x.id === pid);
  if (!p) throw new UserError('請選對應的品項');
  if (storeId) {
    const ref = doc('storeAliases/' + storeId);
    await db().runTransaction(async (tx) => {
      const items = ((await tx.get(ref)).data()?.items || []).filter((a) => a.text !== text);
      if (items.length >= 200) throw new UserError('這家店的專屬叫法太多了，請先刪掉一些');
      tx.set(ref, { items: [...items, { text, pid }] });
    });
    return { products, storeAliases: await getStoreAliases(storeId) };
  }
  const ref = doc('settings/products');
  const list = await db().runTransaction(async (tx) => {
    const items = (await tx.get(ref)).data()?.items ?? structuredClone(DEFAULT_PRODUCTS);
    const other = items.find((x) => x.id !== pid && aliasList(x.alias).includes(text));
    if (other) throw new UserError(`「${text}」已經是「${other.name}」的叫法了，同一個叫法不能對到兩個品項（不同店意思不同的話，請選「只有這家店」）`);
    const it = items.find((x) => x.id === pid);
    if (!it) throw new UserError('找不到這個品項，請重新整理');
    const cur = aliasList(it.alias);
    if (!cur.includes(text)) {
      if (cur.length >= ALIAS_MAX) throw new UserError(`「${it.name}」的叫法已經有 ${ALIAS_MAX} 個了`);
      it.alias = [...cur, text];
    }
    tx.set(ref, { items });
    return items;
  });
  bustProducts();
  return { products: list };
}

export const getStoreAliases = async (storeId) => (await data('storeAliases/' + storeId))?.items || [];
export async function allStoreAliases() {
  const snap = await db().collection('storeAliases').get();
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data().items || []]));
}
export async function removeStoreAlias(storeId, text) {
  const ref = doc('storeAliases/' + storeId);
  await db().runTransaction(async (tx) => {
    const items = ((await tx.get(ref)).data()?.items || []).filter((a) => a.text !== text);
    tx.set(ref, { items });
  });
  return getStoreAliases(storeId);
}

/* ---------- 單位 ---------- */
export async function getUnits() {
  const saved = await data('settings/units');
  if (!saved?.items) return DEFAULT_UNITS;
  if ((saved.v || 1) >= UNITS_VERSION) return saved.items;
  const add = Object.entries(UNITS_ADDED).filter(([v]) => +v > (saved.v || 1)).flatMap(([, u]) => u);
  const items = [...new Set([...saved.items, ...add])];
  await doc('settings/units').set({ items, v: UNITS_VERSION });
  return items;
}

export async function saveUnits(input) {
  if (!Array.isArray(input)) throw new UserError('單位格式錯誤');
  const list = [...new Set(input.map((u) => clean(u, 6)).filter(Boolean))];
  if (!list.length) throw new UserError('至少要有一個單位');
  const used = (await getProducts()).filter((p) => !list.includes(p.unit));
  if (used.length) throw new UserError(`「${used[0].unit}」還有品項在用（${used[0].name}），先把品項改成別的單位`);
  await doc('settings/units').set({ items: list, v: UNITS_VERSION });
  return list;
}

/* ---------- 分類（後台品項頁「分類管理」可以自己加刪）---------- */
//   settings/categories { items: 分類清單 }
// 舊版分類名稱改成新的（例如菜行的「根莖類」→「根莖大蔥」），品項一起改；只改還沒被老闆改過名字的
async function migrateCategories() {
  const map = PRESET.renamed;
  if (!map) return;
  const cref = doc('settings/categories'), pref = doc('settings/products');
  await db().runTransaction(async (tx) => {
    const [c, p] = await Promise.all([tx.get(cref), tx.get(pref)]);
    const cats = c.data()?.items, items = p.data()?.items;
    const hit = (x) => Object.hasOwn(map, x);
    if (!cats?.some(hit) && !items?.some((i) => hit(i.cat))) return;
    const list = cats ? cats.map((x) => map[x] || x) : [...CATEGORIES];
    for (const x of CATEGORIES) if (!list.includes(x)) list.push(x); // 新增的分類（加工乾貨、百貨）也加進來
    // 照預設的順序排（跟 POS 一樣），老闆自己加的分類放後面
    const rank = (x) => (CATEGORIES.includes(x) ? CATEGORIES.indexOf(x) : 99);
    tx.set(cref, { items: [...new Set(list)].sort((a, b) => rank(a) - rank(b)) });
    if (items) tx.set(pref, { items: items.map((i) => (hit(i.cat) ? { ...i, cat: map[i.cat] } : i)) });
  });
  bustProducts();
}
let migrated = null;
const ensureMigrated = () => (migrated ??= migrateCategories().catch((e) => { migrated = null; throw e; }));
export async function getCategories() {
  await ensureMigrated();
  const list = (await data('settings/categories'))?.items ?? CATEGORIES;
  // 品項用到、但清單裡沒有的分類也列出來，免得品項看不到
  const extra = [...new Set((await getProducts()).map((p) => p.cat).filter((c) => c && !list.includes(c)))];
  return [...list, ...extra];
}
export async function saveCategories(input) {
  if (!Array.isArray(input)) throw new UserError('分類格式錯誤');
  const list = [...new Set(input.map((c) => clean(c, 12)).filter(Boolean))];
  if (!list.length) throw new UserError('至少要有一個分類');
  const used = (await getProducts()).filter((p) => !list.includes(p.cat));
  if (used.length) throw new UserError(`「${used[0].cat}」還有品項在用（${used[0].name}），先把品項改到別的分類`);
  await doc('settings/categories').set({ items: list });
  return list;
}

// 分類改名：連同這個分類底下的品項一起改
export async function renameCategory(from, to) {
  to = clean(to, 12);
  if (!to) throw new UserError('請填新的分類名稱');
  const cats = await getCategories();
  if (!cats.includes(from)) throw new UserError('找不到這個分類，請重新整理');
  if (from === to) return { categories: cats, products: await getProducts() };
  if (cats.includes(to)) throw new UserError(`「${to}」已經有了`);
  const pref = doc('settings/products');
  const products = await db().runTransaction(async (tx) => {
    const items = (await tx.get(pref)).data()?.items ?? structuredClone(DEFAULT_PRODUCTS);
    items.forEach((p) => { if (p.cat === from) p.cat = to; });
    tx.set(pref, { items });
    tx.set(doc('settings/categories'), { items: cats.map((c) => (c === from ? to : c)) });
    return items;
  });
  bustProducts();
  return { categories: cats.map((c) => (c === from ? to : c)), products };
}

// 品項只管名稱、分類、單位、上下架；單價每天在「單價」頁輸入
export async function saveProducts(input) {
  if (!Array.isArray(input)) throw new UserError('品項格式錯誤');
  const cats = (await data('settings/categories'))?.items ?? CATEGORIES;
  const old = new Map((await getProducts()).map((p) => [p.id, p]));
  const units = await getUnits();
  const names = new Set();
  const aliasOwner = new Map(); // 叫法 → 品名：同一個叫法不能對到兩個品項
  const list = input.map((p) => {
    const name = clean(p.name, 40);
    if (!name) throw new UserError('有品項沒有填品名');
    if (names.has(name)) throw new UserError(`「${name}」重複了`);
    names.add(name);
    const id = clean(p.id, 30) || rid('p');
    return {
      id,
      cat: cats.includes(p.cat) ? p.cat : cats[0],
      name,
      unit: units.includes(p.unit) ? p.unit : units[0],
      price: old.get(id)?.price ?? 0, // 最近一次輸入的單價，新訂單先用這個
      cost: old.get(id)?.cost ?? null, // 最近一次輸入的進價
      priceDate: old.get(id)?.priceDate || '', // 最近單價是哪一天的
      on: !!p.on,
      // 別名（客人常打的寫法，給 AI 對照用）。畫面沒送 alias 時保留原本的，免得存品項時被清空
      alias: p.alias === undefined ? aliasList(old.get(id)?.alias) : aliasList(p.alias),
      packs: packList(p.packs === undefined ? old.get(id)?.packs : p.packs, units.includes(p.unit) ? p.unit : units[0]),
      liang: (p.liang === undefined ? old.get(id)?.liang : p.liang) !== false, // 斤的品項可不可以叫到兩
      code: clean(p.code === undefined ? old.get(id)?.code : p.code, 20), // ERP 產品代號（匯入 ERP 時帶進來，之後匯出給 ERP 用）
      supplier: clean(p.supplier === undefined ? old.get(id)?.supplier : p.supplier, 20), // 跟哪家廠商進（採買總表依廠商分組）
      // ERP 帶進來的：廠商代碼（廠商照這個排）、小單位和進位（斤／兩／16、公斤／公克／1000）、建議售價；畫面沒送就保留
      ...Object.fromEntries(['supplierCode', 'small'].map((k) => [k, clean(p[k] === undefined ? old.get(id)?.[k] : p[k], 10)])),
      ...Object.fromEntries(['step', 'listPrice'].map((k) => [k, Math.max(0, +(p[k] === undefined ? old.get(id)?.[k] : p[k]) || 0)])),
    };
  });
  for (const p of list) {
    for (const a of p.alias) {
      if (aliasOwner.has(a) && aliasOwner.get(a) !== p.name) throw new UserError(`「${a}」同時是「${aliasOwner.get(a)}」和「${p.name}」的叫法，請只留一個`);
      aliasOwner.set(a, p.name);
    }
  }
  await doc('settings/products').set({ items: list });
  bustProducts();
  return list;
}

/* ---------- 匯入 ERP 產品（後台品項頁上傳 ERP 匯出的「產品資料」Excel）---------- */
// rows：[{ code, name, cat, catCode, unit, small, step, price, cost, supplier, supplierCode }]，畫面讀完 Excel 送來
// price＝建議售價、cost＝進貨單位那欄（ERP 那欄其實是進價）、step＝進位（1 大單位＝幾個小單位）
// 用 ERP 代號比對：有的就照 ERP 更新品名、分類、單位；還沒代號的舊品項同名同單位就接上代號（單價、叫法、訂單紀錄都留著）；其他新增並上架
// 分類換成 ERP 的（照類別編號排）。dry＝只算結果給畫面確認；removeOthers＝不在 ERP 檔裡的品項一起刪掉
const ERP_UNIT = { 台斤: '斤', F公: '公斤' };
const ERP_OFF = new Set(['備註', '總金額']); // POS 的特殊行，不是給店家叫的：一樣匯進來（ERP 有的都要有），但先下架
export async function importErp(input, { dry = true, removeOthers = false } = {}) {
  if (!Array.isArray(input) || !input.length) throw new UserError('Excel 裡沒有讀到產品，請確認是 ERP 匯出的產品資料');
  if (input.length > 5000) throw new UserError('產品太多了（最多 5000 項）');
  const skipped = [], rows = [], seen = new Set(); // skipped：匯進來但先下架的
  for (const r of input) {
    const code = clean(r.code, 20), name = clean(r.name, 40), cat = clean(r.cat, 12);
    let unit = ERP_UNIT[clean(r.unit, 6)] || clean(r.unit, 6);
    if (!code || !name || seen.has(code)) continue;
    seen.add(code);
    // 單位是亂碼（0、_41+）的先用「包」、下架，列給老闆自己改
    const off = ERP_OFF.has(name) || !/^[一-鿿]{1,3}$/.test(unit);
    if (!/^[一-鿿]{1,3}$/.test(unit)) unit = '包';
    if (off) skipped.push(`${name}（${code}）`);
    const num = (v) => (Number.isFinite(+v) && +v > 0 ? +v : 0);
    rows.push({
      code, name, cat: cat || '其它', catCode: clean(r.catCode, 10), unit, off, liang: unit !== '斤' || clean(r.small, 4) === '兩',
      supplier: clean(r.supplier, 20), supplierCode: clean(r.supplierCode, 10),
      small: clean(r.small, 10).replace(/[^\u4e00-\u9fff]/g, ''), step: num(r.step), listPrice: num(r.price), cost: num(r.cost),
    });
  }
  if (!rows.length) throw new UserError('Excel 裡沒有讀到產品，請確認是 ERP 匯出的產品資料');
  // ERP 同名的（白米 斤／白米 袋）加單位區分，連單位也一樣就加代號；下架的那些撞名時只改它自己（加代號）
  const count = (list, key) => list.reduce((m, x) => m.set(key(x), (m.get(key(x)) || 0) + 1), new Map());
  const live = rows.filter((x) => !x.off);
  const byName = count(live, (x) => x.name), byNameUnit = count(live, (x) => x.name + '|' + x.unit);
  for (const x of live) {
    if (byNameUnit.get(x.name + '|' + x.unit) > 1) x.name = `${x.name}（${x.code}）`;
    else if (byName.get(x.name) > 1) x.name = `${x.name}（${x.unit}）`;
  }
  const taken = new Set(live.map((x) => x.name));
  for (const x of rows.filter((r) => r.off)) { if (taken.has(x.name)) x.name = `${x.name}（${x.code}）`; taken.add(x.name); }

  await ensureMigrated();
  const units = await getUnits();
  const pref = doc('settings/products'), cref = doc('settings/categories'), uref = doc('settings/units');
  return db().runTransaction(async (tx) => {
    const [p, c] = await Promise.all([tx.get(pref), tx.get(cref)]);
    const old = p.data()?.items ?? structuredClone(DEFAULT_PRODUCTS);
    const oldCats = c.data()?.items ?? CATEGORIES;
    const withCode = new Map(old.filter((x) => x.code).map((x) => [x.code, x]));
    const noCode = new Map(old.filter((x) => !x.code).map((x) => [x.name + '|' + x.unit, x]));
    const used = new Set();
    let add = 0, update = 0, link = 0;
    const stamp = rid('p');
    const list = rows.map((r, i) => {
      const o = withCode.get(r.code) || noCode.get(r.name + '|' + r.unit);
      const base = { code: r.code, name: r.name, cat: r.cat, unit: r.unit, liang: r.liang, supplier: r.supplier, supplierCode: r.supplierCode, small: r.small, step: r.step, listPrice: r.listPrice };
      // 單價、進價：還沒填過的才用 ERP 的建議售價、進價（每天在「單價」頁填的不會被蓋掉）
      if (!o) { add++; return { id: stamp + i.toString(36), ...base, price: r.listPrice, cost: r.cost || null, priceDate: '', on: !r.off, alias: [], packs: [] }; }
      used.add(o.id);
      o.code ? update++ : link++;
      return { ...o, ...base, price: o.price || r.listPrice, cost: o.cost ?? (r.cost || null), packs: packList(o.packs, r.unit) };
    });
    const others = old.filter((x) => !used.has(x.id));
    const keep = removeOthers ? [] : others;

    // 分類：ERP 的照類別編號排，留下來的舊品項還在用的分類放後面
    const erpCats = [...new Map([...rows].sort((a, b) => a.catCode.localeCompare(b.catCode)).map((r) => [r.cat, 1])).keys()];
    const cats = [...erpCats, ...oldCats.filter((x) => !erpCats.includes(x) && keep.some((k) => k.cat === x))];
    for (const k of keep) if (!cats.includes(k.cat)) cats.push(k.cat);
    // 同一分類裡照筆畫排，比較好找
    const coll = new Intl.Collator('zh-Hant-TW-u-co-stroke');
    list.sort((a, b) => cats.indexOf(a.cat) - cats.indexOf(b.cat) || coll.compare(a.name, b.name));
    const items = [...list, ...keep];
    // 舊品項跟 ERP 品名撞到（單位不同）：舊的加「（舊）」
    const names = new Set(list.map((x) => x.name));
    for (const k of keep) if (names.has(k.name)) k.name = `${k.name}（舊）`;

    const newUnits = [...new Set([...units, ...items.map((x) => x.unit)])];
    // Firestore 一份文件上限 1MB，品項全部放在 settings/products
    const size = Buffer.byteLength(JSON.stringify(items));
    if (size > 900_000) throw new UserError(`品項資料太大（${Math.round(size / 1000)}KB），請先刪掉一些不用的品項再匯入`);

    const summary = { add, update, link, skipped, others: others.map((x) => x.name), removed: removeOthers ? others.length : 0, catCount: cats.length, total: items.length };
    if (dry) return summary;
    tx.set(pref, { items });
    tx.set(cref, { items: cats });
    bustProducts();
    if (newUnits.length !== units.length) tx.set(uref, { items: newUnits, v: UNITS_VERSION });
    return { ...summary, products: items, categories: cats, units: newUnits };
  });
}

/* ---------- 報價組 ---------- */
// type：none 照基本價、percent 打折（value＝90 是 9 折）、minus 每單位減 value 元；fixed 是個別品項的固定價
export async function getPriceGroups() {
  return (await data('settings/priceGroups'))?.items ?? [];
}

export function priceFor(base, pid, group) {
  if (!group) return base;
  if (group.fixed?.[pid] != null) return group.fixed[pid];
  if (group.type === 'percent') return Math.round((base * group.value) / 100);
  if (group.type === 'minus') return Math.max(0, base - group.value);
  return base;
}

export async function savePriceGroups(input) {
  if (!Array.isArray(input)) throw new UserError('報價組格式錯誤');
  const names = new Set();
  const list = input.map((g) => {
    const name = clean(g.name, 20);
    if (!name) throw new UserError('有報價組沒有填名稱');
    if (names.has(name)) throw new UserError(`報價組「${name}」重複了`);
    names.add(name);
    const type = ['none', 'percent', 'minus'].includes(g.type) ? g.type : 'none';
    const value = Number(g.value) || 0;
    if (type === 'percent' && !(value > 0 && value <= 200)) throw new UserError(`「${name}」的折數不正確（例如 9 折填 90）`);
    if (type === 'minus' && !(value >= 0)) throw new UserError(`「${name}」每單位減的金額不正確`);
    const fixed = {};
    for (const [pid, v] of Object.entries(g.fixed || {})) {
      if (v === '' || v == null) continue;
      const n = Math.round(Number(v));
      if (!(n >= 0)) throw new UserError(`「${name}」有固定價不正確`);
      fixed[pid] = n;
    }
    return { id: clean(g.id, 30) || rid('g'), name, type, value, fixed, chain: clean(g.chain, 30) }; // chain：這組是哪個連鎖店的
  });
  await doc('settings/priceGroups').set({ items: list });
  await repriceOpen();
  return list;
}

// 同連鎖店同一個報價：每個連鎖店一個報價組（沒有就建，先照基本價），分店全部放進去
export async function chainGroups() {
  const [stores, groups] = await Promise.all([getStores(), getPriceGroups()]);
  const chains = [...new Set(stores.map((s) => s.chain).filter(Boolean))];
  let made = 0, moved = 0;
  const names = new Set(groups.map((g) => g.name));
  for (const c of chains) {
    if (groups.some((g) => g.chain === c)) continue;
    // 已經有同名的報價組就直接當成這個連鎖店的
    const same = groups.find((g) => g.name === c && !g.chain);
    if (same) { same.chain = c; continue; }
    groups.push({ id: rid('g') + made, name: names.has(c) ? `${c}（連鎖）` : c, type: 'none', value: 0, fixed: {}, chain: c });
    made++;
  }
  const gOf = Object.fromEntries(groups.filter((g) => g.chain).map((g) => [g.chain, g.id]));
  const batch = db().batch();
  for (const s of stores) if (s.chain && gOf[s.chain] && s.groupId !== gOf[s.chain]) { batch.set(doc('stores/' + s.id), { groupId: gOf[s.chain] }, { merge: true }); moved++; }
  batch.set(doc('settings/priceGroups'), { items: groups });
  await batch.commit();
  if (moved) await repriceOpen();
  return { made, moved, chains: chains.length, priceGroups: groups, stores: await getStores() };
}

// 店家換組、報價組改規則後，今天（含）以後還沒送的訂單重算
async function repriceOpen() {
  const [stores, groups] = await Promise.all([getStores(), getPriceGroups()]);
  const gOf = (sid) => groups.find((g) => g.id === stores.find((s) => s.id === sid)?.groupId);
  const snap = await db().collection('orders').where('date', '>=', today()).get();
  const batch = db().batch();
  let n = 0;
  for (const d of snap.docs) {
    const o = d.data();
    let changed = false;
    for (const it of o.items) {
      const base = it.base ?? it.price;
      const p = priceFor(base, it.pid, gOf(o.storeId));
      if (p !== it.price || it.base !== base) { it.price = p; it.base = base; changed = true; }
    }
    if (changed) {
      batch.set(d.ref, o);
      batch.set(doc('monthly/' + o.month), { amounts: { [monthKey(o.date, o.storeId, o.seq)]: amountOf(o) } }, { merge: true });
      n++;
    }
  }
  if (n) await batch.commit();
}

/* ---------- 每日單價 ---------- */
export async function getDayPrices(date) {
  return (await data('dayPrices/' + date))?.prices || {};
}
export async function getDayCosts(date) {
  return (await data('dayPrices/' + date))?.costs || {};
}

// input：{ pid: 基本價 }；costInput：{ pid: 進價 }（選填，算毛利用）
export async function setDayPrices(date, input, costInput = {}) {
  if (!isDate(date)) throw new UserError('配送日不正確');
  const prices = {};
  for (const [pid, v] of Object.entries(input || {})) {
    const n = Math.round(Number(v));
    if (v === '' || v == null || !(n >= 0)) throw new UserError('有單價沒填或不正確');
    prices[pid] = n;
  }
  const costs = {};
  for (const [pid, v] of Object.entries(costInput || {})) {
    if (v === '' || v == null) continue;
    const n = Math.round(Number(v) * 100) / 100;
    if (!(n >= 0)) throw new UserError('有進價不正確');
    costs[pid] = n;
  }
  const cur = (await data('dayPrices/' + date)) || {};
  const day = { ...(cur.prices || {}), ...prices };
  const dayCosts = { ...(cur.costs || {}), ...costs };
  const batch = db().batch();
  batch.set(doc('dayPrices/' + date), { date, prices: day, costs: dayCosts });

  // 套用到這天所有訂單（各店照報價組換算）
  const [stores, groups] = await Promise.all([getStores(), getPriceGroups()]);
  for (const o of await ordersOfDate(date)) {
    const g = groups.find((x) => x.id === stores.find((s) => s.id === o.storeId)?.groupId);
    let changed = false;
    for (const it of o.items) {
      if (!(it.pid in prices)) continue;
      const p = priceFor(prices[it.pid], it.pid, g);
      if (it.price !== p || it.base !== prices[it.pid]) { it.price = p; it.base = prices[it.pid]; changed = true; }
    }
    if (changed) {
      batch.set(orderDoc(date, o.storeId, o.seq), o);
      batch.set(doc('monthly/' + date.slice(0, 7)), { amounts: { [monthKey(date, o.storeId, o.seq)]: amountOf(o) } }, { merge: true });
    }
  }
  await batch.commit();
  // 記成最近的單價，之後的新訂單先帶這個。補填「過去某天」的價格時不要蓋掉比較新的價格；
  // 用 transaction 只改價格欄位，免得蓋掉同時在改的品項或叫法
  const pref = doc('settings/products');
  await db().runTransaction(async (tx) => {
    const items = (await tx.get(pref)).data()?.items ?? structuredClone(DEFAULT_PRODUCTS);
    let changed = false;
    for (const p of items) {
      if (!(p.id in prices || p.id in costs) || (p.priceDate && date < p.priceDate)) continue;
      if (p.id in prices) { p.price = prices[p.id]; p.priceDate = date; } // 只改進價（記帳自動填的）不動單價的日期
      if (p.id in costs) p.cost = costs[p.id];
      changed = true;
    }
    if (changed) tx.set(pref, { items });
  });
  bustProducts();
  return day;
}

/* ---------- 店家 ---------- */
export async function getStores() {
  const snap = await db().collection('stores').get();
  return snap.docs.map((d) => d.data()).sort((a, b) => a.route - b.route);
}

export async function saveStores(input) {
  if (!Array.isArray(input)) throw new UserError('店家格式錯誤');
  const old = new Map((await getStores()).map((s) => [s.id, s]));
  const list = input.map((s) => {
    const name = clean(s.name, 30);
    if (!name) throw new UserError('有店家沒有填店名');
    const route = Math.floor(Number(s.route));
    return {
      id: clean(s.id, 30) || rid('s'),
      name,
      route: route > 0 ? route : 99,
      phone: clean(s.phone, 20),
      address: clean(s.address, 80),
      on: s.on !== false,
      groupId: clean(s.groupId, 30),
      pay: s.pay === 'cash' ? 'cash' : 'month', // 付款方式：month 月結（月底對帳單一次付）、cash 現結（每次送貨付）
      // ERP 客戶代號、連鎖店、聯絡人（匯入 ERP 客戶時帶進來）；畫面沒送就保留原本的
      ...Object.fromEntries(['code', 'chain', 'contact'].map((k) => [k, clean(s[k] === undefined ? old.get(s.id)?.[k] : s[k], 30)])),
      members: old.get(s.id)?.members || [], // 綁定的 LINE 帳號只能用開通／解除改
      ...(old.get(s.id)?.invite ? { invite: old.get(s.id).invite } : {}), // 綁定 QR Code
    };
  });
  // 同連鎖店同一個報價：有分店換了報價組，同連鎖店的其他分店跟著換
  const switched = new Map();
  for (const s of list) if (s.chain && old.has(s.id) && (old.get(s.id).groupId || '') !== s.groupId) switched.set(s.chain, s.groupId);
  for (const s of list) if (switched.has(s.chain)) s.groupId = switched.get(s.chain);
  // 有訂單紀錄的店家不能刪：刪了它的應收帳款、對帳就看不到了。不合作了請取消「合作中」
  const kept0 = new Set(list.map((s) => s.id));
  for (const s of old.values()) {
    if (kept0.has(s.id)) continue;
    if (!(await db().collection('orders').where('storeId', '==', s.id).limit(1).get()).empty) throw new UserError(`「${s.name}」有訂單紀錄，不能刪除（刪了應收帳款會看不到）。不合作了請取消「合作中」`);
  }
  const batch = db().batch();
  for (const s of list) batch.set(doc('stores/' + s.id), s);
  // 被刪掉的店家，連同它的 LINE 綁定一起刪
  const kept = new Set(list.map((s) => s.id));
  for (const s of old.values()) {
    if (kept.has(s.id)) continue;
    batch.delete(doc('stores/' + s.id));
    for (const m of s.members) batch.delete(doc('members/' + m.userId));
  }
  await batch.commit();
  if (list.some((s) => (old.get(s.id)?.groupId || '') !== s.groupId)) await repriceOpen();
  return getStores();
}

// 只改一家店的付款方式（對帳頁直接切換）
// 匯入 ERP 客戶（後台店家頁上傳 ERP 的「客戶資料一覽表」）
// rows：[{ code, name, chain, phone, contact }]。照客戶代號比對，沒代號的舊店家同名就接上；新的店家先排在最後一站、月結、合作中
// 電話 ERP 沒填就不動（老闆可能在後台補過），LINE 綁定、報價組、站號都不動
export async function importErpStores(input, { dry = true } = {}) {
  if (!Array.isArray(input) || !input.length) throw new UserError('Excel 裡沒有讀到客戶，請確認是 ERP 的客戶資料一覽表');
  if (input.length > 2000) throw new UserError('客戶太多了（最多 2000 家）');
  const [old, groups] = await Promise.all([getStores(), getPriceGroups()]);
  // 新分店的報價組：跟同連鎖店其他分店一樣（同連鎖店同一個報價），沒有分店才用連鎖店自己的組
  const chainGroup = Object.fromEntries(groups.filter((g) => g.chain).map((g) => [g.chain, g.id]));
  for (const s of old) if (s.chain && s.groupId) chainGroup[s.chain] = s.groupId;
  const byCode = new Map(old.filter((s) => s.code).map((s) => [s.code, s]));
  const byName = new Map(old.filter((s) => !s.code).map((s) => [s.name, s]));
  const seen = new Set(), list = [];
  let add = 0, update = 0, link = 0;
  const stamp = rid('s');
  for (const [i, r] of input.entries()) {
    const code = clean(r.code, 30), name = clean(r.name, 30);
    if (!code || !name || seen.has(code)) continue;
    seen.add(code);
    const erp = { code, name, chain: clean(r.chain, 30), contact: clean(r.contact, 30) };
    const phone = clean(r.phone, 20);
    const o = byCode.get(code) || byName.get(name);
    if (o) {
      o.code ? update++ : link++;
      byName.delete(o.name);
      list.push({ ...o, ...erp, phone: phone || o.phone || '' });
    } else {
      add++;
      list.push({ id: stamp + i.toString(36), ...erp, route: 99, phone, address: '', on: true, groupId: chainGroup[erp.chain] || '', pay: 'month', members: [] });
    }
  }
  if (!list.length) throw new UserError('Excel 裡沒有讀到客戶，請確認是 ERP 的客戶資料一覽表');
  const summary = { add, update, link, total: old.length + add };
  if (dry) return summary;
  // 一次最多寫 500 筆
  for (let k = 0; k < list.length; k += 400) {
    const batch = db().batch();
    for (const s of list.slice(k, k + 400)) batch.set(doc('stores/' + s.id), s);
    await batch.commit();
  }
  return { ...summary, stores: await getStores() };
}

export async function setStorePay(sid, pay) {
  const ref = doc('stores/' + clean(sid, 40));
  if (!(await ref.get()).exists) throw new UserError('找不到這家店', 404);
  await ref.update({ pay: pay === 'cash' ? 'cash' : 'month' });
  return getStores();
}

// userId 是「store:店家ID」：後台代客叫貨的連結（電話叫貨的店不一定有綁 LINE）
export async function storeOfUser(userId) {
  const sid = String(userId).startsWith('store:') ? String(userId).slice(6) : (await data('members/' + userId))?.storeId;
  if (!sid) return null;
  const s = await data('stores/' + sid);
  return s && s.on ? s : null;
}

export const listPending = async () => (await db().collection('pending').get()).docs.map((d) => d.data()).sort((a, b) => a.at.localeCompare(b.at));

// keepText：已經回覆過店名就不再覆蓋（回傳 false＝沒有改），第一次回覆回傳 true
// order：還沒開通前傳的叫貨內容，開通後幫他送去 AI 整理（只留最後一次）
export async function addPending(userId, name, text, { keepText = false, order = '' } = {}) {
  const old = await data('pending/' + userId);
  if (keepText && old?.text) return false;
  await doc('pending/' + userId).set({
    userId,
    name: name || old?.name || '',
    text: clean(text, 60) || old?.text || '',
    order: clean(order, 500) || old?.order || '',
    at: old?.at || new Date().toISOString(),
  });
  return keepText ? true : !old;
}
export const getPending = (userId) => data('pending/' + userId);
// 綁定過、但店家暫停合作
export async function isPausedMember(userId) {
  const sid = (await data('members/' + userId))?.storeId;
  return !!sid && (await data('stores/' + sid))?.on === false;
}

export async function approve(userId, { storeId, newStore }) {
  const p = await data('pending/' + userId);
  if (!p) throw new UserError('找不到這個申請，可能已經處理過了');
  const stores = await getStores();
  let s = stores.find((x) => x.id === storeId);
  if (!s) {
    const name = clean(newStore?.name, 30);
    if (!name) throw new UserError('請選店家，或填新店家的店名');
    s = { id: rid('s'), name, route: Math.max(0, ...stores.map((x) => x.route)) + 1, phone: '', address: '', on: true, members: [] };
  }
  const batch = db().batch();
  // 從舊店家移除（如果有）
  const prev = (await data('members/' + userId))?.storeId;
  const old = stores.find((x) => x.id === prev && x.id !== s.id);
  if (old) batch.update(doc('stores/' + old.id), { members: old.members.filter((m) => m.userId !== userId) });
  s.members = [...s.members.filter((m) => m.userId !== userId), { userId, name: p.name }];
  batch.set(doc('stores/' + s.id), s);
  batch.set(doc('members/' + userId), { storeId: s.id });
  batch.delete(doc('pending/' + userId));
  await batch.commit();
  return s;
}

export const reject = (userId) => doc('pending/' + userId).delete();

// 新店家自己開通：填店名、地址、電話就建好店家並綁定。
// 店名＋電話都跟已經有的店一樣（後台先建好的，或同一家店的員工第二個來填），就綁到那家，不會多一家重複的
export async function selfJoin(userId, name, input) {
  const s = { name: clean(input.name, 30), address: clean(input.address, 80), phone: clean(input.phone, 20).replace(/[^\d#+-]/g, '') };
  if (!s.name) throw new UserError('請填店家名稱');
  if (!s.address) throw new UserError('請填地址');
  if (!/^\d{8,12}$/.test(s.phone.replace(/\D/g, ''))) throw new UserError('電話號碼看起來不對，例如 0912345678 或 0223456789');
  if (await storeOfUser(userId)) throw new UserError('這個 LINE 已經開通了，回到 LINE 直接打字叫貨就可以', 409);
  if (await isPausedMember(userId)) throw new UserError('您的店家目前暫停叫貨，有問題請在 LINE 留言給老闆', 403);
  const stores = await getStores();
  const digits = (x) => String(x || '').replace(/\D/g, '');
  let store = stores.find((x) => x.on && x.name === s.name && digits(x.phone) === digits(s.phone));
  if (!store) store = { id: rid('s'), name: s.name, route: Math.max(0, ...stores.map((x) => x.route)) + 1, phone: s.phone, address: s.address, on: true, members: [], selfJoined: new Date().toISOString() };
  else store = { ...store, address: store.address || s.address };
  const pending = await data('pending/' + userId);
  store.members = [...store.members, { userId, name: clean(name, 40) || pending?.name || '' }];
  const batch = db().batch();
  batch.set(doc('stores/' + store.id), store);
  batch.set(doc('members/' + userId), { storeId: store.id });
  batch.delete(doc('pending/' + userId));
  await batch.commit();
  return { store, isNew: !stores.some((x) => x.id === store.id), order: pending?.order || '' };
}

/* ---------- 綁定 QR Code：每家店一組綁定碼，店家掃了送出「綁定 XXXX」就自動綁好（不用老闆開通）---------- */
const INVITE_DAYS = 30;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 拿掉 0/O、1/I/L 這些容易看錯的
export async function storeInvite(storeId, renew = false) {
  const s = await data('stores/' + storeId);
  if (!s) throw new UserError('找不到這家店', 404);
  if (!renew && s.invite && s.invite.exp > new Date().toISOString()) return s.invite;
  const code = Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  const invite = { code, exp: new Date(Date.now() + INVITE_DAYS * 86400e3).toISOString() };
  await doc('stores/' + storeId).update({ invite });
  return invite;
}
// 回傳 { store, already }；碼不對丟 UserError。同一個 LINE 一天最多錯 5 次
export async function bindByInvite(userId, name, code) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tryRef = doc(`bindTries/${today()}_${userId}`);
  if (((await tryRef.get()).data()?.n || 0) >= 5) throw new UserError('今天輸入錯太多次了，請明天再試，或直接留言給老闆。');
  const snap = await db().collection('stores').where('invite.code', '==', code).limit(1).get();
  const s = snap.docs[0]?.data();
  if (!s || !(s.invite.exp > new Date().toISOString())) {
    await tryRef.set({ n: FieldValue.increment(1) }, { merge: true });
    throw new UserError(s ? '這個綁定碼已經過期了，請老闆重新給您一個。' : '綁定碼不對，請再確認一次，或直接留言給老闆。');
  }
  const prev = (await data('members/' + userId))?.storeId;
  if (prev === s.id) return { store: s, already: true };
  if (prev) { const p = await data('stores/' + prev); if (p) throw new UserError(`您的 LINE 已經綁定「${p.name}」了。要換店請直接留言給老闆。`); }
  const batch = db().batch();
  batch.update(doc('stores/' + s.id), { members: [...(s.members || []).filter((m) => m.userId !== userId), { userId, name: clean(name, 30) }] });
  batch.set(doc('members/' + userId), { storeId: s.id });
  batch.delete(doc('pending/' + userId));
  await batch.commit();
  return { store: s, already: false };
}

export async function unbind(userId) {
  const sid = (await data('members/' + userId))?.storeId;
  const s = sid && (await data('stores/' + sid));
  const batch = db().batch();
  if (s) batch.update(doc('stores/' + sid), { members: s.members.filter((m) => m.userId !== userId) });
  batch.delete(doc('members/' + userId));
  await batch.commit();
}

/* ---------- 訂單 ---------- */
// seq：第幾張單（1 是原本的叫貨單，2 以後是簽收後開的補單）
export const slipKey = (sid, seq = 1) => (seq > 1 ? `${sid}-${seq}` : sid);
const orderDoc = (date, sid, seq = 1) => doc(`orders/${date}_${slipKey(sid, seq)}`);
const monthKey = (date, sid, seq = 1) => `${date}|${slipKey(sid, seq)}`;
// 簽收後出貨單就鎖住，數量和品項都不能再改（單價還是可以補）；要追加就開補單（檢查在 saveOrder／setShip 的 transaction 裡）
export const getOrder = async (date, sid, seq = 1) => (await orderDoc(date, sid, seq).get()).data() ?? null;

export async function ordersOfDate(date, { withEmpty = false } = {}) {
  const snap = await db().collection('orders').where('date', '==', date).get();
  return snap.docs.map((d) => d.data()).filter((o) => withEmpty || o.items.length);
}

// 這家店最近一張（配送日早於 date 的）訂單，用來「照上次叫」
// 這家店常叫的品項（AI 叫貨優先比對這些、叫貨頁「常用」）：這個系統的訂單叫越多次越前面，再來是 ERP 銷售紀錄買越多錢的
export async function usualPids(sid, n = 20) {
  const [snap, hist] = await Promise.all([
    db().collection('orders').where('storeId', '==', sid).where('date', '<', '9999').orderBy('date', 'desc').limit(n).get(),
    data('storeHistory/' + sid),
  ]);
  const count = new Map();
  for (const d of snap.docs) for (const i of d.data().items || []) count.set(i.pid, (count.get(i.pid) || 0) + 1);
  const mine = [...count].sort((a, b) => b[1] - a[1]).map(([pid]) => pid);
  const erp = Object.entries(hist?.items || {}).sort((a, b) => b[1] - a[1]).map(([pid]) => pid);
  return [...new Set([...mine, ...erp])];
}

// 匯入 ERP「客戶產品銷售統計表」：rows [{ storeCode, productCode, amount }]，照客戶代號、產品代號對到店家和品項
// 每家店整份換掉（建議匯出最近幾個月的）；同一家店同一個品項的金額加總，買越多越前面
export async function importSales(input, { dry = true } = {}) {
  if (!Array.isArray(input) || !input.length) throw new UserError('Excel 裡沒有讀到銷售紀錄，請確認是 ERP 的客戶產品銷售統計表');
  const [stores, products] = await Promise.all([getStores(), getProducts()]);
  const sOf = new Map(stores.filter((s) => s.code).map((s) => [s.code, s.id]));
  const pOf = new Map(products.filter((p) => p.code).map((p) => [p.code, p.id]));
  const hist = new Map(), missS = new Set();
  let missP = 0, rows = 0;
  for (const r of input.slice(0, 50000)) {
    const sid = sOf.get(clean(r.storeCode, 30)), pid = pOf.get(clean(r.productCode, 20));
    if (!sid) { if (r.storeCode) missS.add(clean(r.storeCode, 30)); continue; }
    if (!pid) { missP++; continue; }
    const m = hist.get(sid) || {};
    m[pid] = Math.round((m[pid] || 0) + Math.max(1, +r.amount || 0));
    hist.set(sid, m);
    rows++;
  }
  if (!hist.size) throw new UserError('沒有對到任何店家，請先「匯入 ERP 客戶」');
  const summary = { stores: hist.size, rows, missStores: [...missS].slice(0, 20), missStoreCount: missS.size, missProducts: missP };
  if (dry) return summary;
  const at = new Date().toISOString(), list = [...hist];
  for (let k = 0; k < list.length; k += 400) {
    const batch = db().batch();
    for (const [sid, items] of list.slice(k, k + 400)) batch.set(doc('storeHistory/' + sid), { items, at });
    await batch.commit();
  }
  return summary;
}

export async function lastOrder(sid, date) {
  const snap = await db().collection('orders').where('storeId', '==', sid).where('date', '<', date).orderBy('date', 'desc').limit(5).get();
  return snap.docs.map((d) => d.data()).find((o) => o.items.length) ?? null;
}

// 這家店這個月到 date 為止累計多少（月結的出貨單上寫「本月累計」）
export async function monthSoFar(storeId, date) {
  return (await monthAmounts(date.slice(0, 7))).filter((r) => r.storeId === storeId && r.date <= date).reduce((a, r) => a + r.amount, 0);
}

// 一整個月每家店每天的金額（讀一份文件）
// 這個月的所有單（列印明細對帳單、銷售統計用）；空單不算
export async function ordersOfMonth(month) {
  const snap = await db().collection('orders').where('date', '>=', month + '-01').where('date', '<=', month + '-31').get();
  return snap.docs.map((d) => d.data()).filter((o) => o.items?.length);
}

export async function monthAmounts(month) {
  const amounts = (await data('monthly/' + month))?.amounts || {};
  // 同一天的補單併成一筆
  const m = new Map();
  for (const [k, amount] of Object.entries(amounts)) {
    const [date, key] = k.split('|');
    const storeId = key.replace(/-\d+$/, '');
    const r = m.get(date + '|' + storeId) || { date, storeId, amount: 0 };
    r.amount += amount;
    m.set(date + '|' + storeId, r);
  }
  return [...m.values()];
}

// 整張訂單覆蓋。by：'店家' 或 '後台'；who：後台是誰改的
// items 可以是陣列，或 (舊訂單) => 陣列：要「在舊的單上加減」時用函式，才不會跟同時間的修改互相蓋掉
// 用 transaction：同一張單同時有人改（店家改單、理貨填實出量、AI 確認），Firestore 會自動重跑，不會遺失修改
export async function saveOrder(sid, date, items, by, who = '', seq = 1, opts = {}) {
  if (!isDate(date)) throw new UserError('配送日不正確');
  if (by === '店家' && date !== openDate()) throw new UserError('這一天已經截單了，請重新整理後再叫貨', 409);
  seq = Math.max(1, Math.floor(Number(seq)) || 1);
  const [products, dayPrices, storeDoc, groups] = await Promise.all([getProducts(), getDayPrices(date), data('stores/' + sid), getPriceGroups()]);
  const pm = new Map(products.map((p) => [p.id, p]));
  const group = groups.find((g) => g.id === storeDoc?.groupId);
  const ref = orderDoc(date, sid, seq);
  const sigRef = doc(`signatures/${date}_${slipKey(sid, seq)}`);

  return db().runTransaction(async (tx) => {
  // 這裡面可能被重跑好幾次，不要有寄訊息之類的副作用
  const [sigSnap, oldSnap] = await Promise.all([tx.get(sigRef), tx.get(ref)]);
  if (sigSnap.exists) throw new UserError('這張配送單已經確認，不能再修改；要追加請開補單', 409);
  // 開新單（補單）時這個序號已經被用過（包含清空的單）：交給 saveNewSlip 換下一號
  if (opts.fresh && oldSnap.exists) throw Object.assign(new Error('SEQ_TAKEN'), { code: 'SEQ_TAKEN' });
  const old = oldSnap.data() ?? null;
  // 交易撞到別人同時改單會重跑：每次都要用這次讀到的最新的單重算，不能改掉外面的 items
  const list = typeof items === 'function' ? items(old) : items;
  const oldMap = new Map((old?.items || []).map((i) => [i.pid, i]));

  const next = [];
  const seen = new Set();
  for (const it of Array.isArray(list) ? list : []) {
    const qty = roundQty(it?.qty);
    if (!(qty > 0) || seen.has(it.pid)) continue;
    if (qty > 999) throw new UserError('數量太大了');
    const p = pm.get(it.pid);
    const was = oldMap.get(it.pid);
    if (!p && !was) continue;
    if (p && !p.on && !was && by.startsWith('店家')) throw new UserError(`「${p.name}」暫時沒有供貨`);
    seen.add(it.pid);
    const src = p || was;
    // 叫貨量沒變的話，保留理貨已經秤好的實出量
    const keepShip = was && was.qty === qty && was.ship != null ? { ship: was.ship } : {};
    const base = p ? dayPrices[it.pid] ?? p.price : was.base ?? was.price;
    next.push({ pid: it.pid, name: src.name, unit: src.unit, base, price: p ? priceFor(base, it.pid, group) : was.price, qty, ...keepShip });
  }
  if (!next.length && !old?.items.length) throw new UserError('還沒選任何品項');
  const idx = (pid) => { const i = products.findIndex((p) => p.id === pid); return i < 0 ? 1e9 : i; };
  next.sort((a, b) => idx(a.pid) - idx(b.pid));

  const changes = [];
  if (old?.items.length) {
    for (const pid of new Set([...oldMap.keys(), ...next.map((i) => i.pid)])) {
      const a = oldMap.get(pid)?.qty || 0;
      const n = next.find((i) => i.pid === pid);
      const b = n?.qty || 0;
      const { name, unit } = n || oldMap.get(pid);
      if (a !== b) changes.push(`${name} ${qtyText(a, unit)} → ${qtyText(b, unit)}`);
    }
  }
  const at = new Date().toISOString();
  const order = {
    date,
    month: date.slice(0, 7),
    storeId: sid,
    seq,
    ...((old?.items.length && old.addon) || by === '店家補單' ? { addon: true } : {}), // 店家自己開的補單
    items: next,
    createdAt: old?.items.length ? old.createdAt : at,
    updatedAt: at,
    log: [
      ...(old?.log || []),
      ...(changes.length ? [{ at, by, who, text: changes.join('、') }] : []),
      // 新訂單只在有特別來源（例如 AI 叫貨）時記一筆
      ...(!old?.items.length && who ? [{ at, by, who, text: '新叫貨：' + next.map((i) => `${i.name} ${qtyText(i.qty, i.unit)}`).join('、') }] : []),
    ],
  };
  tx.set(ref, order);
  tx.set(doc('monthly/' + order.month), { amounts: { [monthKey(date, sid, seq)]: next.length ? amountOf(order) : FieldValue.delete() } }, { merge: true });
  return { order, had: !!old?.items.length, changes };
  });
}

export async function setQty(sid, date, pid, qty, who, seq = 1) {
  return saveOrder(sid, date, (old) => {
    const items = (old?.items || []).filter((i) => i.pid !== pid);
    const at = (old?.items || []).findIndex((i) => i.pid === pid);
    const it = { pid, qty: Math.max(0, roundQty(qty) || 0) };
    if (at >= 0) items.splice(at, 0, it); else items.push(it);
    return items;
  }, '後台', who, seq);
}

// 整張刪除（還沒簽收的才可以）：品項清空、對帳金額移除，改單紀錄會留下刪了什麼
export async function deleteSlip(sid, date, who, seq = 1) {
  const o = await getOrder(date, sid, seq);
  if (!o?.items.length) throw new UserError('這張出貨單已經是空的');
  return saveOrder(sid, date, [], '後台', who ? `${who}・整張刪除` : '整張刪除', seq);
}

// 這家店這天所有有品項的單（含補單），依序號排
export async function slipsOfDay(sid, date) {
  const snap = await db().collection('orders').where('date', '==', date).where('storeId', '==', sid).get();
  return snap.docs.map((d) => d.data()).filter((o) => o.items.length).sort((a, b) => (a.seq || 1) - (b.seq || 1));
}

// 後台開補單：跟原本的單分開，另開一張（原本的單有沒有確認都可以）
export async function newSlip(sid, date, pid, qty, who) {
  if (!(await slipsOfDay(sid, date)).length) throw new UserError('這家店這天還沒有出貨單，直接加品項就好');
  return saveNewSlip(sid, date, [{ pid, qty }], '後台', who);
}

// 開一張新的單：用沒用過的序號（清空的單也不重用，舊的確認連結才不會對到新單）；同時有人開單撞號就換下一號
export async function saveNewSlip(sid, date, items, by, who = '') {
  const snap = await db().collection('orders').where('date', '==', date).where('storeId', '==', sid).get();
  let seq = Math.max(0, ...snap.docs.map((d) => d.data().seq || 1)) + 1;
  for (let i = 0; i < 5; i++, seq++) {
    try { return await saveOrder(sid, date, items, by, who, seq, { fresh: true }); }
    catch (e) { if (e.code !== 'SEQ_TAKEN') throw e; }
  }
  throw new UserError('剛好有人同時在開單，請再按一次');
}

// 店家自己補單（截單後加點）：跟原本的訂單分開。還沒確認的店家補單就繼續加在同一張，確認過了再另開一張
export async function addonSlipOf(sid, date) {
  const slips = await slipsOfDay(sid, date);
  for (const o of slips.filter((x) => x.addon).reverse()) {
    if (!(await doc(`signatures/${date}_${slipKey(sid, o.seq || 1)}`).get()).exists) return o;
  }
  return null;
}
// 這家店現在可以補單的配送日：
//   叫貨中的那天，原本的單已經被後台確認（鎖住）了 → 補那一天（到截單為止）
//   否則 → 已截單、還沒過補單截止時間的那天
export async function addonFor(sid) {
  const D = openDate();
  if (getRulesNow().addon && (await doc(`signatures/${D}_${slipKey(sid, 1)}`).get()).exists) return { date: D, until: cutoffLabel(D), mainLocked: true };
  const A = addonDate();
  return A ? { date: A, until: addonUntilLabel(A), mainLocked: false } : null;
}
export async function saveAddon(sid, date, items) {
  if (date !== (await addonFor(sid))?.date) throw new UserError('補單時間已經過了，要追加請直接留言給老闆', 409);
  const cur = await addonSlipOf(sid, date);
  // 還沒確認的店家補單就加在同一張；沒有的話另開一張新的
  return cur ? saveOrder(sid, date, items, '店家補單', '', cur.seq) : saveNewSlip(sid, date, items, '店家補單');
}

// 計價用的數量：理貨秤過就用實出量，沒秤就用叫貨量
export const billQty = (i) => i.ship ?? i.qty;
export const amountOf = (o) => Math.round(o.items.reduce((a, i) => a + billQty(i) * i.price, 0));

// 理貨填實際秤出的量（0＝缺貨，不出貨也不計價）
export async function setShip(sid, date, pid, ship, who, seq = 1) {
  ship = Math.max(0, roundQty(ship) || 0);
  if (ship > 999) throw new UserError('數量太大了');
  const ref = orderDoc(date, sid, seq);
  const sigRef = doc(`signatures/${date}_${slipKey(sid, seq)}`);
  return db().runTransaction(async (tx) => {
    const [sigSnap, snap] = await Promise.all([tx.get(sigRef), tx.get(ref)]);
    if (sigSnap.exists) throw new UserError('這張配送單已經確認，不能再修改；要追加請開補單', 409);
    const o = snap.data();
    const it = o?.items.find((i) => i.pid === pid);
    if (!it) throw new UserError('這家店這天沒有叫這個品項');
    const before = billQty(it);
    if (before === ship) return { order: o };
    if (ship === it.qty) delete it.ship; else it.ship = ship;
    const at = new Date().toISOString();
    o.updatedAt = at;
    o.log = [...(o.log || []), { at, by: '後台', who, text: `實出 ${it.name} ${qtyText(before, it.unit)} → ${ship ? qtyText(ship, it.unit) : '缺貨'}` }];
    tx.set(ref, o);
    tx.set(doc('monthly/' + o.month), { amounts: { [monthKey(date, sid, seq)]: amountOf(o) } }, { merge: true });
    return { order: o };
  });
}

/* ---------- 收款 ---------- */
// 每筆收款記在「付的是哪個月的貨款」底下，可以分好幾次付；折讓＝抹零、扣款，不收錢但算進已收
export const PAY_METHODS = ['現金', '匯款', '支票', '折讓'];
export const getPaid = async (month) => (await data('paid/' + month))?.stores || {};
// 已收多少：舊資料（整月打勾、沒有明細）當作全部收清
export const paidSum = (rec, billed) => (!rec ? 0 : Array.isArray(rec.list) ? rec.list.reduce((a, p) => a + p.amount, 0) : billed);

// 取消這個月的所有收款（給舊的整月打勾用）
export async function setPaid(month, sid, paid) {
  await doc('paid/' + month).set({ stores: { [sid]: paid ? { at: new Date().toISOString() } : FieldValue.delete() } }, { merge: true });
}

export async function addPayment(month, sid, input, who) {
  const amount = Math.round(Number(input.amount));
  if (!(amount > 0 && amount < 1e8)) throw new UserError('收款金額不正確');
  const date = input.date ? String(input.date) : today();
  if (!isDate(date)) throw new UserError('收款日期不正確');
  const method = PAY_METHODS.includes(input.method) ? input.method : '現金';
  const entry = { id: rid('p'), amount, date, method, note: clean(input.note, 40), by: clean(who, 40), at: new Date().toISOString(), ...(isDate(input.for) ? { for: input.for } : {}) }; // for：現結的店付的是哪一天的貨
  const ref = doc('paid/' + month);
  await db().runTransaction(async (tx) => {
    const rec = (await tx.get(ref)).data()?.stores?.[sid];
    if (rec && !Array.isArray(rec.list)) throw new UserError('這個月之前已經整月打勾收清，要記明細請先按「取消收清」');
    tx.set(ref, { stores: { [sid]: { list: [...(rec?.list || []), entry] } } }, { merge: true });
  });
  return getPaid(month);
}

export async function removePayment(month, sid, id) {
  const ref = doc('paid/' + month);
  await db().runTransaction(async (tx) => {
    const list = (await tx.get(ref)).data()?.stores?.[sid]?.list || [];
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) throw new UserError('找不到這筆收款，可能已經刪掉了', 404);
    tx.set(ref, { stores: { [sid]: next.length ? { list: next } : FieldValue.delete() } }, { merge: true });
  });
  return getPaid(month);
}

/* ---------- 採買進度：這個配送日每個品項要多少、已經買了多少 ---------- */
export const getBought = async (date) => (await data('bought/' + date))?.items || {};
export async function setBought(date, pid, qty) {
  if (!isDate(date)) throw new UserError('日期不正確');
  const q = roundQty(Math.max(0, Number(qty) || 0));
  await doc('bought/' + date).set({ items: { [clean(pid, 40)]: q || FieldValue.delete() } }, { merge: true });
  return getBought(date);
}
export async function addBought(date, pid, qty) {
  await doc('bought/' + date).set({ items: { [pid]: FieldValue.increment(roundQty(qty)) } }, { merge: true });
}
// 還要買多少：叫貨數量加總（以單位為準）減掉已買
export async function buyList(date) {
  const [orders, bought, products] = await Promise.all([ordersOfDate(date), getBought(date), getProducts()]);
  const need = {};
  for (const o of orders) for (const it of o.items) {
    const n = (need[it.pid] ??= { pid: it.pid, name: it.name, unit: it.unit, need: 0, stores: 0 });
    n.need = roundQty(n.need + it.qty); n.stores++;
  }
  const rank = Object.fromEntries(products.map((p, i) => [p.id, i]));
  const sup = Object.fromEntries(products.map((p) => [p.id, p]));
  return Object.values(need).map((n) => ({ ...n, supplier: sup[n.pid]?.supplier || '', supplierCode: sup[n.pid]?.supplierCode || '', bought: roundQty(bought[n.pid] || 0), left: roundQty(Math.max(0, n.need - (bought[n.pid] || 0))) }))
    .sort((a, b) => (rank[a.pid] ?? 999) - (rank[b.pid] ?? 999));
}
