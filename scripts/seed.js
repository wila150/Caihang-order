// 模擬器示範資料：先開 npm run emulators，另一個視窗跑 npm run seed
// 只會寫進本機模擬器，不會動到正式的 Firebase
import { initializeApp } from '../functions/node_modules/firebase-admin/lib/app/index.js';
import { getFirestore } from '../functions/node_modules/firebase-admin/lib/firestore/index.js';
import { DEFAULT_PRODUCTS, DEFAULT_UNITS } from '../functions/lib/config.js';
import { openDate, today, addDays, thisMonth } from '../functions/lib/dates.js';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
initializeApp({ projectId: 'caihang-order' });
const db = getFirestore();

// 先清空
for (const c of ['settings', 'stores', 'members', 'pending', 'orders', 'dayPrices', 'monthly', 'paid', 'users']) {
  const snap = await db.collection(c).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

const uid = (n) => `Utest${String(n).padStart(28, '0')}`;
const names = ['阿美麵店', '好味自助餐', '巷口便當', '老張滷味', '小林火鍋', '陳家熱炒'];
const stores = names.map((name, i) => ({
  id: 's' + (i + 1), name, route: i + 1, phone: '', address: '', on: true,
  members: [{ userId: uid(i + 1), name: name + '老闆' }],
}));
const P = DEFAULT_PRODUCTS;
const item = (pid, qty) => { const p = P.find((x) => x.id === pid); return { pid, name: p.name, unit: p.unit, price: p.price, qty }; };

const batchOps = [];
const set = (path, data) => batchOps.push([path, data]);
set('settings/products', { items: P });
set('settings/units', { items: DEFAULT_UNITS });
stores.forEach((s, i) => { set('stores/' + s.id, s); set('members/' + uid(i + 1), { storeId: s.id }); });
set('pending/' + uid(99), { userId: uid(99), name: '王小華', text: '我是巷尾牛肉麵', at: new Date().toISOString() });

const monthly = {};
const put = (date, sid, items, log = []) => {
  const now = new Date().toISOString();
  set(`orders/${date}_${sid}`, { date, month: date.slice(0, 7), storeId: sid, items, createdAt: now, updatedAt: now, log });
  ((monthly[date.slice(0, 7)] ??= {})[`${date}|${sid}`] = Math.round(items.reduce((a, i) => a + i.qty * i.price, 0)));
};
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const first = addDays(thisMonth() + '-01', -1).slice(0, 7) + '-01';
for (let d = first; d <= today(); d = addDays(d, 1)) {
  for (const s of stores) {
    if (rnd() < 0.25) continue;
    const n = 2 + Math.floor(rnd() * 4);
    const picks = [...new Set(Array.from({ length: n }, () => P[Math.floor(rnd() * P.length)].id))];
    put(d, s.id, picks.map((pid) => item(pid, 1 + Math.floor(rnd() * 8))));
  }
}
const D = openDate();
put(D, 's1', [item('p1', 3), item('p5', 2), item('p9', 1)]);
put(D, 's2', [item('p1', 10), item('p7', 3), item('p13', 2)], [{ at: new Date().toISOString(), by: '店家', text: '蒜末 2 斤 → 3 斤' }]);
put(D, 's3', [item('p2', 5), item('p6', 4)]);
put(D, 's5', [item('p3', 1), item('p5', 5), item('p10', 2), item('p12', 1)]);
for (const [m, amounts] of Object.entries(monthly)) set('monthly/' + m, { amounts });

for (let i = 0; i < batchOps.length; i += 400) {
  const b = db.batch();
  batchOps.slice(i, i + 400).forEach(([path, data]) => b.set(db.doc(path), data));
  await b.commit();
}

// 後台測試帳號：模擬器的 Google 登入視窗按「Add new account」，輸入下面的 Email 就能登入
const accounts = [['account@test.com', '會計小美', 'accounting'], ['warehouse@test.com', '理貨阿明', 'warehouse'], ['driver@test.com', '司機阿忠', 'driver']];
for (const [email, name, role] of accounts) await db.doc('users/' + email).set({ name, role, disabled: false });
console.log(`已寫入示範資料：6 家店、${D} 叫貨中、1 筆開通申請`);
console.log('後台測試帳號（Google 登入視窗按 Add new account 輸入）：owner@test.com 老闆／account@test.com 會計／warehouse@test.com 理貨／driver@test.com 司機');
