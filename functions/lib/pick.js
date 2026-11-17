// 平板撿貨：誰正在撿哪張單（多台平板分工，不會兩個人撿同一張）、每張單撿到哪
//   picks/{日期}_{店[-補單號]}  { date, key, by, email, at, done, doneAt, items: { pid: true } }
// 不放在訂單裡：saveOrder 每次會重建整張訂單，放進去會被洗掉
import { getFirestore } from 'firebase-admin/firestore';
import { UserError } from './http.js';
import { isDate } from './dates.js';
import { setShip, slipKey } from './shop.js';

const db = () => getFirestore();
const ref = (date, key) => db().doc(`picks/${date}_${key}`);
// 鎖超過 20 分鐘沒動作就算放掉（平板沒電、人走掉），別人可以接手
const STALE = 20 * 60 * 1000;
const stale = (p) => !p?.at || Date.now() - Date.parse(p.at) > STALE;

export async function picksOfDate(date) {
  if (!isDate(date)) throw new UserError('配送日不正確');
  const snap = await db().collection('picks').where('date', '==', date).get();
  return Object.fromEntries(snap.docs.map((d) => { const p = d.data(); return [p.key, { ...p, stale: stale(p) }]; }));
}

// op：take 開始撿（鎖住）、release 放掉、done 撿完、reopen 重新撿；force 搶別人的鎖
export async function setPick(date, sid, seq, op, me, force = false) {
  if (!isDate(date)) throw new UserError('配送日不正確');
  const key = slipKey(sid, Math.max(1, Math.floor(Number(seq)) || 1));
  const r = ref(date, key);
  return db().runTransaction(async (tx) => {
    const p = (await tx.get(r)).data() || { date, key, items: {} };
    const mine = p.email === me.email;
    const at = new Date().toISOString();
    if (op === 'take') {
      if (p.done && !force) throw new UserError(`這張單已經撿完了（${p.by}）`, 409);
      if (p.by && !mine && !stale(p) && !force) throw new UserError(`${p.by} 正在撿這張單`, 409);
      Object.assign(p, { by: me.name, email: me.email, at, done: false });
    } else if (op === 'release') {
      if (!mine && !force) return p;
      delete p.by; delete p.email;
      p.at = at;
    } else if (op === 'done') {
      Object.assign(p, { by: me.name, email: me.email, at, done: true, doneAt: at });
    } else if (op === 'reopen') {
      Object.assign(p, { by: me.name, email: me.email, at, done: false });
    } else throw new UserError('不認得的動作');
    tx.set(r, p);
    return p;
  });
}

// 秤好一項：寫實出量（計價照這個），並記下這項撿過了
export async function pickItem(date, sid, seq, pid, ship, me) {
  const key = slipKey(sid, Math.max(1, Math.floor(Number(seq)) || 1));
  const cur = (await ref(date, key).get()).data();
  if (cur?.by && cur.email !== me.email && !stale(cur)) throw new UserError(`${cur.by} 正在撿這張單`, 409);
  const r = await setShip(sid, date, pid, ship, me.name, seq);
  await ref(date, key).set({ date, key, by: me.name, email: me.email, at: new Date().toISOString(), items: { [pid]: true } }, { merge: true });
  return r;
}
