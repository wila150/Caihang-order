// 上游進貨單核對：老闆拍上游廠商給的出貨單，AI 讀出每一行，系統自己重算，抓上游多算、少算、變貴、送多送少
//   purchases/{id} { id, date, supplier, lines, total, sum, correct, diff, issues, thumb, status, expenseId, by, at }
//     lines：[{ name, qty, unit, price, amount, calc, pid, pname, cost, need }]
//       amount＝單據上寫的金額、calc＝數量×單價（系統算的）、cost＝平常進價、need＝那天要叫的量
//     total＝單據上寫的合計、sum＝每行金額加起來、correct＝每行都照數量×單價算的合計
//     diff＝total − correct（正的＝上游多算、負的＝少算）
//     status：new 還沒看、ok 確認過了
import { getFirestore } from 'firebase-admin/firestore';
import { askJson, baseName } from './ai.js';
import { getProducts, getDayCosts, buyList } from './shop.js';
import { addExpense, removeExpense, PURCHASE, listExpenses, getCats, isPurchase, supplierKeys, findSupplier } from './expense.js';
import { today, isDate, buyDate } from './dates.js';
import { UserError } from './http.js';
import { SHOP } from './config.js';

const db = () => getFirestore();
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const num = (v) => { const n = Number(String(v ?? '').replace(/[,，\s$元]/g, '')); return Number.isFinite(n) ? n : null; };
const r2 = (n) => Math.round(n * 100) / 100;
const TOL = 1; // 四捨五入的誤差，差 1 元以內不算錯

const READ_PROMPT = `你在看台灣${SHOP.kind}的上游廠商（菜商、豬肉商、豆腐商、南北貨行…）開給它的出貨單／送貨單／請款單照片。照單據上寫的原樣讀出來，不要自己算、不要自己改數字，看不清楚的數字填 null。
- supplier：開單的廠商名稱（單據最上面的抬頭或印章；看不出來留空字串）
- date：單據上的日期，西元 YYYY-MM-DD（民國 115 年＝2026 年；看不出來留空字串）
- lines：每一行品項 { name 品名, qty 數量, unit 單位, price 單價, amount 這行的金額 }，數量是「3斤4兩」這種的，qty 換成斤（3.25）
- total：單據上寫的合計／總計金額（沒有寫就 null）
- note：其他寫在單上的字（例如前欠、折讓、運費），沒有就空字串
只輸出 JSON：{"supplier":"","date":"","lines":[{"name":"高麗菜","qty":20,"unit":"斤","price":25,"amount":500}],"total":500,"note":""}`;

// 照片 → 單據內容（照原樣，還沒核對）
export async function readInvoice(image) {
  const j = await askJson([{ role: 'system', content: READ_PROMPT }, { role: 'user', content: [{ type: 'text', text: '請讀出這張進貨單。' }, { type: 'image_url', image_url: { url: image } }] }], { image: true });
  return {
    supplier: clean(j.supplier, 20),
    date: isDate(j.date) ? j.date : '',
    lines: (Array.isArray(j.lines) ? j.lines : []).slice(0, 80).map((l) => ({ name: clean(l?.name, 30), qty: num(l?.qty), unit: clean(l?.unit, 6), price: num(l?.price), amount: num(l?.amount) })).filter((l) => l.name || l.amount != null),
    total: num(j.total),
    note: clean(j.note, 100),
  };
}

// 廠商名稱對到品項上記的廠商（ERP 的供應商名稱）：一樣的、或其中一個包含另一個
function matchSupplier(name, products) {
  const all = [...new Set(products.map((p) => p.supplier).filter(Boolean))];
  const n = clean(name, 20);
  if (!n) return '';
  return all.find((s) => s === n) || all.find((s) => n.includes(s) || s.includes(n)) || findSupplier(n, supplierKeys(all))?.[1] || n;
}

// 品名對到品項：先找這家廠商的，品名一樣 → 去掉括號一樣 → 互相包含；單位一樣的優先
function matchProduct(line, products, supplier) {
  const pool = products.filter((p) => p.supplier === supplier);
  const n = line.name.replace(/\s/g, ''), b = baseName(n);
  for (const list of [pool, products]) {
    const hits = list.filter((p) => p.name === n) .concat(list.filter((p) => baseName(p.name) === b))
      .concat(b.length >= 2 ? list.filter((p) => baseName(p.name).includes(b) || b.includes(baseName(p.name))) : []);
    if (hits.length) return hits.find((p) => p.unit === line.unit || (line.unit === '台斤' && p.unit === '斤') || (/公斤|kg/i.test(line.unit) && p.unit === '公斤')) || hits[0];
  }
  return null;
}

// 核對：每行數量×單價、加總、跟單據合計比；再跟平常進價、那天要叫的量比
export async function checkInvoice(inv, date) {
  const [products, costs, need] = await Promise.all([getProducts(), getDayCosts(date), buyList(date).catch(() => [])]);
  const supplier = matchSupplier(inv.supplier, products);
  const needOf = new Map(need.map((x) => [x.pid, x.need]));
  const issues = [];
  const lines = inv.lines.map((l, i) => {
    const calc = l.qty != null && l.price != null ? Math.round(l.qty * l.price) : null;
    const p = matchProduct(l, products, supplier);
    const cost = p ? (costs[p.id] ?? p.cost ?? null) : null;
    const out = { ...l, calc, pid: p?.id || '', pname: p?.name || '', cost, need: p ? needOf.get(p.id) ?? null : null };
    if (calc != null && l.amount != null && Math.abs(calc - l.amount) > TOL) issues.push({ type: 'line', i, text: `第 ${i + 1} 行 ${l.name}：${l.qty}×${l.price}＝${calc}，單上寫 ${l.amount}（${l.amount > calc ? '多算' : '少算'} ${Math.abs(l.amount - calc)}）` });
    if (l.amount == null && calc == null) issues.push({ type: 'read', i, text: `第 ${i + 1} 行 ${l.name}：金額看不清楚，請在後台補上` });
    if (cost != null && l.price != null && p.unit === l.unit && Math.abs(l.price - cost) >= 0.5) issues.push({ type: 'price', i, text: `${l.name} 單價 ${l.price}，平常 ${cost}（${l.price > cost ? '貴' : '便宜'} ${r2(Math.abs(l.price - cost))}）` });
    if (out.need != null && l.qty != null && p.unit === l.unit && Math.abs(l.qty - out.need) > 0.01) issues.push({ type: 'qty', i, text: `${l.name} 送 ${l.qty}${l.unit}，這天要叫 ${out.need}${p.unit}（${l.qty > out.need ? '多' : '少'} ${r2(Math.abs(l.qty - out.need))}）` });
    return out;
  });
  const sum = lines.reduce((a, l) => a + (l.amount ?? l.calc ?? 0), 0);
  const correct = lines.reduce((a, l) => a + (l.calc ?? l.amount ?? 0), 0);
  const total = inv.total ?? sum;
  if (inv.total != null && Math.abs(inv.total - sum) > TOL) issues.unshift({ type: 'sum', text: `每行加起來 ${sum}，單上合計寫 ${inv.total}（${inv.total > sum ? '多算' : '少算'} ${Math.abs(inv.total - sum)}）` });
  const diff = Math.round(total - correct);
  return { supplier, lines, total, sum, correct, diff, issues };
}

// LINE 回老闆的摘要
export function purchaseText(p) {
  const bad = p.issues.filter((x) => x.type === 'sum' || x.type === 'line');
  const head = `🧾 ${p.supplier || '（看不出廠商）'} 進貨單 ${p.lines.length} 項\n單上合計 ${p.total.toLocaleString('en-US')}，照數量×單價算 ${p.correct.toLocaleString('en-US')}`;
  const verdict = Math.abs(p.diff) <= TOL ? '✅ 金額對得上' : p.diff > 0 ? `⚠️ 上游多算 ${p.diff.toLocaleString('en-US')} 元` : `⚠️ 上游少算 ${(-p.diff).toLocaleString('en-US')} 元`;
  const other = p.issues.filter((x) => x.type !== 'sum' && x.type !== 'line');
  return [head, verdict, ...bad.map((x) => '・' + x.text), ...(other.length ? ['', '其他要注意：', ...other.slice(0, 8).map((x) => '・' + x.text), ...(other.length > 8 ? [`…還有 ${other.length - 8} 項`] : [])] : []),
    '', 'AI 可能讀錯字，有疑問到後台「進貨單」看照片、改數字。'].join('\n');
}

// 存一張（LINE 拍的、後台上傳的都走這裡）
export async function savePurchase({ inv, thumb = '', by = '', source = 'line' }) {
  // 電腦打的照填的日期；照片讀出來的日期太新（讀錯）就用採買日
  const date = isDate(inv.date) && (source === 'typed' || inv.date <= today()) ? inv.date : buyDate();
  const checked = await checkInvoice(inv, date);
  const ref = db().collection('purchases').doc();
  const p = { id: ref.id, date, month: date.slice(0, 7), ...checked, note: inv.note || '', thumb, status: 'new', expenseId: '', by: clean(by, 40), source, at: new Date().toISOString() };
  await ref.set(p);
  return p;
}

const pref = (id) => {
  const k = clean(id, 40);
  if (!/^[\w-]+$/.test(k)) throw new UserError('找不到這張進貨單', 404);
  return db().doc('purchases/' + k);
};

// 後台列表：這個月的（不含照片，照片點開才載）
export async function listPurchases(month) {
  const snap = await db().collection('purchases').where('month', '==', month).get();
  return snap.docs.map((d) => { const { thumb, ...p } = d.data(); return { ...p, hasThumb: !!thumb }; }).sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
}
export async function purchaseThumb(id) { return (await pref(id).get()).data()?.thumb || ''; }

// 後台改了（AI 讀錯的字、日期、廠商）：重新核對；確認過、記過帳的金額也跟著改
export async function updatePurchase(id, input) {
  const r = pref(id), old = (await r.get()).data();
  if (!old) throw new UserError('找不到這張進貨單', 404);
  const inv = {
    supplier: clean(input.supplier ?? old.supplier, 20),
    date: isDate(input.date) ? input.date : old.date,
    lines: (Array.isArray(input.lines) ? input.lines : old.lines).slice(0, 80).map((l) => ({ name: clean(l.name, 30), qty: num(l.qty), unit: clean(l.unit, 6), price: num(l.price), amount: num(l.amount) })).filter((l) => l.name || l.amount != null),
    total: input.total === undefined ? old.total : num(input.total),
  };
  const checked = await checkInvoice(inv, inv.date);
  const p = { ...old, ...checked, date: inv.date, month: inv.date.slice(0, 7), status: input.status === 'ok' ? 'ok' : input.status === 'new' ? 'new' : old.status };
  if (old.expenseId) await syncExpense(p);
  await r.set(p);
  const { thumb, ...rest } = p;
  return { ...rest, hasThumb: !!thumb };
}

// 記成進貨支出（記帳的「進貨付款」，付給這家廠商），之後改單金額會跟著改；不記了就刪掉那筆帳
async function syncExpense(p) {
  if (p.expenseId) await removeExpense(p.expenseId).catch(() => {});
  const e = await addExpense({ date: p.date, amount: p.total, cat: PURCHASE, item: `${p.supplier || '上游'} 進貨單`, payee: p.supplier, note: p.diff ? `上游${p.diff > 0 ? '多算' : '少算'} ${Math.abs(p.diff)}` : '' }, { by: '進貨單', source: 'purchase' });
  p.expenseId = e.id;
}
export async function setPurchaseExpense(id, on) {
  const r = pref(id), p = (await r.get()).data();
  if (!p) throw new UserError('找不到這張進貨單', 404);
  if (on) await syncExpense(p);
  else { if (p.expenseId) await removeExpense(p.expenseId).catch(() => {}); p.expenseId = ''; }
  await r.set(p);
  return { id: p.id, expenseId: p.expenseId };
}

/* ---------- 廠商總帳（應付帳款）：每家廠商這個月進了多少、付了多少、還要付多少 ---------- */
//   進貨＝進貨單（拍照、手動登記）＋記帳的進貨（LINE 打「進貨 七美 12000」，付給這家的）
//   已付＝後台登記的付款（supplierPays/{id} { supplier, date, month, amount, note, by }，不算支出，免得報表重複扣）
//   現付的廠商（settings/suppliers { 名稱: { pay: 'cash' } }）：進貨就算付了
const norm = (s) => clean(s, 20).replace(/[\s　]/g, '');
const sameSup = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };
export const getSupplierModes = async () => (await db().doc('settings/suppliers').get()).data() || {};
export async function setSupplierMode(supplier, pay) {
  const s = clean(supplier, 20);
  if (!s) throw new UserError('請選廠商');
  await db().doc('settings/suppliers').set({ [s]: { pay: pay === 'cash' ? 'cash' : 'month' } }, { merge: true });
}
// 付款日：每月幾號付這家廠商（0＝沒設定）；那天後台首頁會提醒還欠多少
export async function setSupplierPayDay(supplier, day) {
  const s = clean(supplier, 20), n = Math.floor(Number(day)) || 0;
  if (!s) throw new UserError('請選廠商');
  if (n < 0 || n > 31) throw new UserError('付款日要填 1～31，月底填 31');
  await db().doc('settings/suppliers').set({ [s]: { payDay: n } }, { merge: true });
}
export async function supplierLedger(month) {
  const [ps, ex, cats, paySnap, modes] = await Promise.all([listPurchases(month), listExpenses(month), getCats(), db().collection('supplierPays').where('month', '==', month).get(), getSupplierModes()]);
  const map = new Map();
  const row = (name) => {
    const k = [...map.keys()].find((x) => sameSup(x, name)) ?? name;
    if (!map.has(k)) map.set(k, { supplier: k, invoices: [], payments: [], total: 0, over: 0, under: 0, paid: 0 });
    return map.get(k);
  };
  const addItem = (r, name, unit, qty, amount) => {
    const k = `${name}|${unit}`, it = (r.items ||= new Map()).get(k) || { name, unit, qty: 0, amount: 0, times: 0 };
    it.qty = r2(it.qty + (qty || 0)); it.amount += amount || 0; it.times++;
    r.items.set(k, it);
  };
  for (const p of ps) {
    const r = row(p.supplier || '（看不出廠商）');
    r.invoices.push({ id: p.id, date: p.date, total: p.total, diff: p.diff, status: p.status, manual: p.source === 'manual', note: p.note || '',
      lines: p.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, price: l.price, amount: l.amount ?? l.calc })) });
    // 品項合計：同品名同單位加起來（這個月跟這家買了多少）
    for (const l of p.lines) addItem(r, l.name, l.unit, l.qty, l.amount ?? l.calc ?? 0);
    r.total += p.total;
    if (p.diff > 1) r.over += p.diff; else if (p.diff < -1) r.under -= p.diff;
  }
  // 記帳的進貨（LINE「進貨 七美 12000」）：記進這家的帳；進貨單按過「記成進貨支出」的不要重複算
  for (const e of ex.filter((x) => isPurchase(x.cat, cats) && x.payee && x.source !== 'purchase')) {
    const r = row(e.payee);
    r.invoices.push({ id: 'e:' + e.id, date: e.date, total: e.amount, diff: 0, fromExpense: true, note: [e.item !== '進貨' && e.item, e.note, e.source === 'line' ? 'LINE 記帳' : '記帳', e.by].filter(Boolean).join('・'), lines: [] });
    r.total += e.amount;
  }
  for (const d of paySnap.docs) {
    const x = d.data(), r = row(x.supplier);
    r.payments.push({ id: x.id, date: x.date, amount: x.amount, note: x.note, by: x.by });
    r.paid += x.amount;
  }
  return [...map.values()].map((r) => {
    const cash = Object.entries(modes).find(([k]) => sameSup(k, r.supplier))?.[1]?.pay === 'cash';
    // 現付：進貨就付了，不用另外登記付款
    const paid = cash ? r.total : r.paid;
    const payDay = Object.entries(modes).find(([k]) => sameSup(k, r.supplier))?.[1]?.payDay || 0;
    return { ...r, pay: cash ? 'cash' : 'month', payDay, paid, items: [...(r.items?.values() || [])].sort((a, b) => b.amount - a.amount), left: Math.round(r.total - paid) };
  }).sort((a, b) => b.left - a.left || b.total - a.total || a.supplier.localeCompare(b.supplier, 'zh-Hant'));
}

// 後台登記付款給廠商（不記成支出：進貨已經算過成本了）
export async function paySupplier({ supplier, amount, date, note }, by) {
  const s = clean(supplier, 20), a = num(amount);
  if (!s) throw new UserError('請選廠商');
  if (!(a > 0)) throw new UserError('金額不正確');
  const d = isDate(date) ? date : today();
  const ref = db().collection('supplierPays').doc();
  const x = { id: ref.id, supplier: s, date: d, month: d.slice(0, 7), amount: Math.round(a), note: clean(note, 40), by: clean(by, 40), at: new Date().toISOString() };
  await ref.set(x);
  return x;
}
export async function removeSupplierPay(id) {
  const k = clean(id, 40);
  if (!/^[\w-]+$/.test(k)) throw new UserError('找不到這筆付款', 404);
  await db().doc('supplierPays/' + k).delete();
}

// 沒有拍照的進貨：手動登記廠商、日期、金額
export async function manualPurchase({ supplier, date, total, note }, by) {
  const amount = num(total);
  if (!clean(supplier, 20)) throw new UserError('請填廠商');
  if (!(amount > 0)) throw new UserError('金額不正確');
  const d = isDate(date) ? date : today();
  const ref = db().collection('purchases').doc();
  const p = { id: ref.id, date: d, month: d.slice(0, 7), supplier: clean(supplier, 20), lines: [], total: Math.round(amount), sum: Math.round(amount), correct: Math.round(amount), diff: 0, issues: [], note: clean(note, 100), thumb: '', status: 'ok', expenseId: '', by: clean(by, 40), source: 'manual', at: new Date().toISOString() };
  await ref.set(p);
  return p;
}

export async function removePurchase(id) {
  const r = pref(id), p = (await r.get()).data();
  if (p?.expenseId) await removeExpense(p.expenseId).catch(() => {});
  await r.delete();
}
