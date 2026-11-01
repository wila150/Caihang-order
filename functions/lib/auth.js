// 後台帳號與權限：用 Google 帳號登入（Firebase Authentication），或用 LINE 登入（見 linelogin.js，帳號是 users/line:{userId}）
// 老闆在 OWNER_EMAILS 指定；其他人由老闆在「帳號」分頁用 Email 授權，存在 users/{email}
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { UserError } from './http.js';
import { verifySession, lineRole, dropRequest } from './linelogin.js';

export const ROLES = {
  owner: '老闆',
  engineer: '工程師',
  manager: '老闆娘', // 訪談：接單、價格、對帳、收付款、記帳、報表都能做，帳號和設定還是只有老闆
  accounting: '會計',
  warehouse: '理貨',
  driver: '司機',
};

// 可以給員工的權限（後台「設定 → 權限」老闆勾選）。'users'（帳號、權限、設定）只有老闆和工程師，不能給員工
export const PERMS = {
  view: '看採買總表、出貨單',
  prices: '看和填單價、進價',
  bills: '對帳、收款、報表、記帳',
  statement: '傳收據、對帳單、催款',
  editOrders: '改叫貨／出貨數量、開補單、代客叫貨',
  deleteOrders: '刪除出貨單',
  products: '管理品項',
  stores: '管理店家（開通、報價組）',
  remind: '提醒店家叫貨',
  sign: '確認配送單（簽收）',
};
// 老闆還沒改過時的預設（跟原本寫死的一樣）
export const DEFAULT_CAN = {
  manager: ['view', 'prices', 'bills', 'statement', 'editOrders', 'deleteOrders', 'products', 'stores', 'remind', 'sign'],
  accounting: ['view', 'bills', 'prices', 'editOrders', 'deleteOrders', 'products', 'remind', 'statement', 'sign'],
  warehouse: ['view', 'editOrders', 'remind', 'sign'],
  driver: ['view', 'sign'],
};
const STAFF = Object.keys(DEFAULT_CAN);
const cleanPerms = (a) => [...new Set((Array.isArray(a) ? a : []).filter((p) => p in PERMS))];

// 老闆設定的各角色權限：settings/perms { roles: { accounting: [...], ... } }，快取 30 秒
let permsCache = null, permsAt = 0;
export async function getRolePerms() {
  if (permsCache && Date.now() - permsAt < 30e3) return permsCache;
  const saved = (await getFirestore().doc('settings/perms').get()).data()?.roles || {};
  permsCache = Object.fromEntries(STAFF.map((r) => [r, saved[r] ? cleanPerms(saved[r]) : DEFAULT_CAN[r]]));
  permsAt = Date.now();
  return permsCache;
}
export async function saveRolePerms(roles) {
  const r = Object.fromEntries(STAFF.map((k) => [k, cleanPerms(roles?.[k])]));
  await getFirestore().doc('settings/perms').set({ roles: r });
  permsCache = r; permsAt = Date.now();
  return r;
}

// 這個人實際有的權限：角色的權限＋個人多給的（add）－個人拿掉的（remove）
async function effectivePerms(role, doc) {
  if (role === 'owner' || role === 'engineer') return ['*'];
  const base = (await getRolePerms())[role] || [];
  const add = cleanPerms(doc?.add), remove = cleanPerms(doc?.remove);
  return [...new Set([...base, ...add])].filter((p) => !remove.includes(p));
}
// who：登入的人（signedIn 回傳的 me，有 perms）
export const can = (who, what) => !!who?.perms && (who.perms.includes('*') || who.perms.includes(what));

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
    const doc = r.role === 'owner' ? null : (await userDoc('line:' + s.userId).get()).data();
    return { email: 'line:' + s.userId, name: r.name || s.name || 'LINE 使用者', role: r.role, engineer: false, line: true, perms: await effectivePerms(r.role, doc) };
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
  return { email, name: doc?.name || user.name || email, role, engineer: engineerEmails().includes(email), perms: await effectivePerms(role, doc) };
}

export function need(me, what) {
  if (!can(me, what)) throw new UserError(what in PERMS ? `「${me.name || ROLES[me.role]}」沒有這個權限（${PERMS[what]}），請老闆到「設定 → 權限」打開` : '只有老闆能做這件事', 403);
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

export async function updateUser({ email, role, disabled, add, remove }) {
  email = normEmail(email);
  if (ownerEmails().includes(email) || engineerEmails().includes(email)) throw new UserError('老闆和工程師帳號的權限是固定的（在 OWNER_EMAILS、ENGINEER_EMAILS 設定）');
  const ref = userDoc(email);
  if (!(await ref.get()).exists) throw new UserError('找不到這個帳號', 404);
  const patch = {};
  if (role !== undefined) { if (!ROLES[role] || role === 'owner' || role === 'engineer') throw new UserError('角色不正確'); patch.role = role; }
  if (disabled !== undefined) patch.disabled = !!disabled;
  if (add !== undefined) patch.add = cleanPerms(add);
  if (remove !== undefined) patch.remove = cleanPerms(remove);
  await ref.update(patch);
  return listUsers();
}

export async function removeUser({ email }) {
  email = normEmail(email);
  if (ownerEmails().includes(email) || engineerEmails().includes(email)) throw new UserError('老闆和工程師帳號不能刪除（在 OWNER_EMAILS、ENGINEER_EMAILS 設定）');
  await userDoc(email).delete();
  return listUsers();
}
