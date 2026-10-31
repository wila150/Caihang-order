// 後台帳號與權限：用 Google 帳號登入（Firebase Authentication），或用 LINE 登入（見 linelogin.js，帳號是 users/line:{userId}）
// 老闆在 OWNER_EMAILS 指定；其他人由老闆在「帳號」分頁用 Email 授權，存在 users/{email}
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { UserError } from './http.js';
import { verifySession, lineRole, dropRequest } from './linelogin.js';

export const ROLES = {
  owner: '老闆',
  engineer: '工程師',
  accounting: '會計',
  warehouse: '理貨',
  driver: '司機',
};

// 每個角色能做的事
const CAN = {
  owner: ['*'],
  engineer: ['*'], // 幫店家設定、維護系統的人（ENGINEER_EMAILS），不是老闆
  accounting: ['view', 'bills', 'prices', 'editOrders', 'deleteOrders', 'products', 'remind', 'statement', 'sign'],
  warehouse: ['view', 'editOrders', 'remind', 'sign'],
  driver: ['view', 'sign'],
};
export const can = (role, what) => !!CAN[role] && (CAN[role].includes('*') || CAN[role].includes(what));

const ownerEmails = () => (process.env.OWNER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// 工程師：測試期間可以用「重置測試資料」，在 ENGINEER_EMAILS 指定，其他人看不到
const engineerEmails = () => (process.env.ENGINEER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const userDoc = (email) => getFirestore().doc('users/' + email);
// LINE 帳號（line:U…）的 userId 有分大小寫，不能轉小寫
const normEmail = (e) => { e = String(e || '').trim(); return e.startsWith('line:') ? e : e.toLowerCase(); };

// 驗證登入，回傳 { email, name, role }
export async function signedIn(request) {
  let auth = request.headers.get('authorization') || '';
  // 用 LINE 登入的也存在 cookie（Firebase Hosting 只會轉 __session 這個名字）：手機主畫面的 App 被滑掉後，網頁自己存的資料可能被清掉，cookie 還在
  if (!/^(Line|Bearer) \S/.test(auth)) {
    const c = (request.headers.get('cookie') || '').match(/(?:^|;\s*)__session=([^;]+)/)?.[1];
    if (c) auth = 'Line ' + decodeURIComponent(c);
  }
  // 用 LINE 登入的：角色每次重新查，解除老闆、停用員工馬上生效
  if (auth.startsWith('Line ')) {
    const s = verifySession(auth.slice(5));
    if (!s) throw new UserError('登入已過期，請重新登入', 401);
    const r = await lineRole(s.userId);
    if (!r) throw new UserError('這個 LINE 已經沒有後台權限了，請找老闆', 403);
    return { email: 'line:' + s.userId, name: r.name || s.name || 'LINE 使用者', role: r.role, engineer: false, line: true };
  }
  const token = auth.replace(/^Bearer /, '');
  if (!token) throw new UserError('請先登入', 401);
  let user;
  try { user = await getAuth().verifyIdToken(token); } catch { throw new UserError('登入已過期，請重新登入', 401); }
  const email = normEmail(user.email);
  if (!email || !user.email_verified) throw new UserError('這個帳號的 Email 沒有驗證，請用 Google 帳號登入', 403);
  const doc = (await userDoc(email).get()).data();
  const role = ownerEmails().includes(email) ? 'owner' : engineerEmails().includes(email) ? 'engineer' : doc?.disabled ? null : doc?.role;
  if (!role) throw new UserError(`${email} 沒有後台權限，請老闆到「帳號」加入這個 Email`, 403);
  return { email, name: doc?.name || user.name || email, role, engineer: engineerEmails().includes(email) };
}

export function need(me, what) {
  if (!can(me.role, what)) throw new UserError(`「${ROLES[me.role]}」沒有這個權限`, 403);
}

/* ---------- 帳號管理（老闆） ---------- */
export async function listUsers() {
  const snap = await getFirestore().collection('users').get();
  const owners = ownerEmails(), engineers = engineerEmails().filter((e) => !owners.includes(e));
  const list = snap.docs.map((d) => ({ email: d.id, ...d.data() }));
  for (const e of owners) if (!list.some((u) => u.email === e)) list.push({ email: e, name: '', role: 'owner' });
  // 工程師不出現在帳號清單（老闆和員工都看不到）
  return list
    .filter((u) => !engineers.includes(u.email))
    .map((u) => ({ ...u, fixed: owners.includes(u.email), role: owners.includes(u.email) ? 'owner' : u.role }))
    .sort((a, b) => Object.keys(ROLES).indexOf(a.role) - Object.keys(ROLES).indexOf(b.role));
}

export async function addUser({ email, name, role }) {
  email = normEmail(email);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new UserError('Email 格式不對');
  if (!ROLES[role] || role === 'owner' || role === 'engineer') throw new UserError('請選角色');
  if (engineerEmails().includes(email)) throw new UserError('這個 Email 是工程師，已經有全部權限');
  if (ownerEmails().includes(email)) throw new UserError('這是老闆的 Email，已經有全部權限');
  await userDoc(email).set({ name: String(name || '').trim().slice(0, 20), role, disabled: false });
  return listUsers();
}

// 把用 LINE 申請登入的人加成員工
export async function addLineUser({ userId, name, role }) {
  userId = String(userId || '');
  if (!/^U[0-9a-f]{32}$/.test(userId)) throw new UserError('LINE 帳號不正確');
  if (!ROLES[role] || role === 'owner' || role === 'engineer') throw new UserError('請選角色');
  await userDoc('line:' + userId).set({ name: String(name || '').trim().slice(0, 20), role, disabled: false, line: true });
  await dropRequest(userId);
  return listUsers();
}

export async function updateUser({ email, role, disabled }) {
  email = normEmail(email);
  if (ownerEmails().includes(email) || engineerEmails().includes(email)) throw new UserError('老闆和工程師帳號的權限是固定的（在 OWNER_EMAILS、ENGINEER_EMAILS 設定）');
  const ref = userDoc(email);
  if (!(await ref.get()).exists) throw new UserError('找不到這個帳號', 404);
  const patch = {};
  if (role !== undefined) { if (!ROLES[role] || role === 'owner' || role === 'engineer') throw new UserError('角色不正確'); patch.role = role; }
  if (disabled !== undefined) patch.disabled = !!disabled;
  await ref.update(patch);
  return listUsers();
}

export async function removeUser({ email }) {
  email = normEmail(email);
  if (ownerEmails().includes(email) || engineerEmails().includes(email)) throw new UserError('老闆和工程師帳號不能刪除（在 OWNER_EMAILS、ENGINEER_EMAILS 設定）');
  await userDoc(email).delete();
  return listUsers();
}
