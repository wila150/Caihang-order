// 後台首頁的提醒（不用推播額度）：今天要收帳的店家、快到期的支票、今天要付的廠商
import { today, thisMonth, addDays } from './dates.js';
import * as shop from './shop.js';
import { receivables } from './report.js';
import { supplierLedger } from './purchase.js';

// 「每月 N 號」碰到小月：31 號在 30 天的月份就是月底那天
const lastDay = (m) => +addDays(addDays(m + '-01', 31).slice(0, 7) + '-01', -1).slice(8, 10);
const dueToday = (day, d = today()) => !!day && +d.slice(8, 10) === Math.min(day, lastDay(d.slice(0, 7)));
const prevMonth = (m) => addDays(m + '-01', -1).slice(0, 7);

export async function todoList() {
  const d = today(), m = thisMonth();
  const months = [];
  for (let x = m, i = 0; i < 12; i++, x = prevMonth(x)) months.push(x);
  const [stores, ar, paidDocs, ledgers] = await Promise.all([
    shop.getStores(), receivables(), Promise.all(months.map((x) => shop.getPaid(x))), Promise.all([prevMonth(m), m].map((x) => supplierLedger(x))),
  ]);
  const arOf = new Map(ar.map((r) => [r.storeId, r.total]));
  const collect = stores.filter((s) => dueToday(s.payDay, d) && arOf.get(s.id) >= 1).map((s) => ({ storeId: s.id, name: s.name, left: arOf.get(s.id) }));

  // 支票：還沒兌現、3 天內到期（含已經過期的）
  const soon = addDays(d, 3), name = new Map(stores.map((s) => [s.id, s.name]));
  const checks = [];
  months.forEach((x, i) => {
    for (const [sid, rec] of Object.entries(paidDocs[i])) {
      for (const p of rec?.list || []) {
        if (p.check && !p.check.cashed && p.check.due && p.check.due <= soon) checks.push({ month: x, storeId: sid, id: p.id, name: name.get(sid) || sid, amount: p.amount, no: p.check.no, due: p.check.due, late: p.check.due < d });
      }
    }
  });
  checks.sort((a, b) => a.due.localeCompare(b.due));

  // 廠商：今天是付款日、上個月＋這個月還沒付清
  const owe = new Map();
  for (const L of ledgers) for (const r of L) if (r.pay !== 'cash' && r.left >= 1) {
    const o = owe.get(r.supplier) || { supplier: r.supplier, left: 0, payDay: r.payDay };
    o.left += r.left; o.payDay = o.payDay || r.payDay;
    owe.set(r.supplier, o);
  }
  const pay = [...owe.values()].filter((o) => dueToday(o.payDay, d)).sort((a, b) => b.left - a.left);

  return { date: d, collect, checks, pay };
}
