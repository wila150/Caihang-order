// 後台用 LINE 登入：用店家叫貨頁同一個 LIFF 拿 LINE 的 access token，伺服器確認是我們的 LIFF 發的，再發自己的登入憑證（30 天）
//   老闆（綁定過的老闆 LINE）直接有老闆權限；其他人第一次登入變成申請（lineLoginReq/{userId}），老闆在「後台帳號」選角色加入
//   員工的帳號存在 users/line:{userId}（跟 Google 帳號 users/{email} 放一起）
import crypto from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { UserError } from './http.js';
import { SHOP } from './config.js';
import { bossIds } from './boss.js';
import { notifyAdmins } from './line.js';

const DAYS = 30;
const secret = () => {
  const s = process.env.LINE_CHANNEL_SECRET;
  if (s) return s;
  if (process.env.FUNCTIONS_EMULATOR === 'true') return 'dev';
  throw new Error('尚未設定 LINE_CHANNEL_SECRET');
};
const mac = (s) => crypto.createHmac('sha256', 'admin-line:' + secret()).update(s).digest('base64url');
const b64 = (s) => Buffer.from(s).toString('base64url');

// 確認 access token 是我們這個 LIFF（同一個 LINE Login channel）發的，再拿 userId 和名字
export async function lineProfile(accessToken) {
  const channel = String(SHOP.liffId || '').split('-')[0];
  if (!channel) throw new UserError('還沒設定 LIFF_ID，不能用 LINE 登入');
  const v = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`);
  const vj = await v.json().catch(() => ({}));
  if (!v.ok || String(vj.client_id) !== channel || !(vj.expires_in > 0)) throw new UserError('LINE 登入失敗，請再試一次', 401);
  const p = await fetch('https://api.line.me/v2/profile', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!p.ok) throw new UserError('拿不到 LINE 帳號資料，請再試一次', 401);
  const { userId, displayName } = await p.json();
  return { userId, name: String(displayName || '').slice(0, 40) };
}

// 這個 LINE 在後台是什麼角色：綁定的老闆 → owner；老闆加入的員工 → 那個角色；都不是 → null
export async function lineRole(userId) {
  if ((await bossIds()).includes(userId)) return { role: 'owner' };
  const d = (await getFirestore().doc('users/line:' + userId).get()).data();
  return d && !d.disabled && d.role ? { role: d.role, name: d.name } : null;
}

// 用 LINE 登入：有權限就發登入憑證；沒有就記成申請，等老闆加入
export async function lineLogin(accessToken) {
  const { userId, name } = await lineProfile(accessToken);
  if (!(await lineRole(userId))) {
    const ref = getFirestore().doc('lineLoginReq/' + userId);
    // 第一次申請才通知老闆
    if (!(await ref.get()).exists) await notifyAdmins(`🔑 ${name || '有人'} 想用 LINE 登入後台，到「設定 → 後台帳號」選角色加入。`).catch(() => {});
    await ref.set({ userId, name, at: new Date().toISOString() });
    throw new UserError(`「${name}」還沒有後台權限，已經通知老闆。請老闆到「設定 → 後台帳號」加入你，再登入一次。`, 403);
  }
  const exp = Math.floor(Date.now() / 1000) + DAYS * 86400;
  const payload = `${userId}.${exp}.${b64(name)}`;
  return { session: `${b64(payload)}.${mac(payload)}`, name };
}

// 驗證登入憑證，回傳 { userId, name }；角色每次重新查（解除老闆、停用員工馬上生效）
export function verifySession(token) {
  const [p64, sig] = String(token || '').split('.');
  if (!p64 || !sig) return null;
  const payload = Buffer.from(p64, 'base64url').toString();
  const want = Buffer.from(mac(payload)), got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const [userId, exp, n64] = payload.split('.');
  if (!userId || !(+exp > Date.now() / 1000)) return null;
  return { userId, name: Buffer.from(n64 || '', 'base64url').toString() };
}

export async function lineRequests() {
  const snap = await getFirestore().collection('lineLoginReq').get();
  return snap.docs.map((d) => d.data()).sort((a, b) => b.at.localeCompare(a.at));
}
export const dropRequest = (userId) => getFirestore().doc('lineLoginReq/' + userId).delete();
