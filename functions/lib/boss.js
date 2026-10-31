// 老闆的 LINE：收開通／叫貨通知、用老闆選單記帳
//   來源有兩個：設定檔 ADMIN_LINE_USER_IDS（要部署才能改），和後台產生綁定碼、老闆在 LINE 傳「綁定老闆 123456」綁的
//   settings/bossLine { ids: [{ userId, name, at }], code: { code, exp } }
import crypto from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { UserError } from './http.js';

const ref = () => getFirestore().doc('settings/bossLine');
const CODE_MIN = 30; // 綁定碼幾分鐘內有效

export const envBossIds = () => (process.env.ADMIN_LINE_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// 每則 LINE 訊息都要判斷是不是老闆，快取 30 秒
let cache = null, cachedAt = 0;
export async function bossIds() {
  if (!cache || Date.now() - cachedAt > 30e3) {
    cache = ((await ref().get()).data()?.ids || []).map((x) => x.userId);
    cachedAt = Date.now();
  }
  return [...new Set([...envBossIds(), ...cache])];
}
const reset = () => { cache = null; };

// 後台看的名單：設定檔的只顯示、不能在這裡解除
export async function listBoss() {
  const d = (await ref().get()).data() || {};
  const code = d.code && d.code.exp > Date.now() ? d.code : null;
  return { ids: d.ids || [], envCount: envBossIds().length, code };
}

// 產生綁定碼：6 位數，30 分鐘內有效，用一次就失效；再產生一次舊的就作廢
export async function newBossCode() {
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const exp = Date.now() + CODE_MIN * 60e3;
  await ref().set({ code: { code, exp } }, { merge: true });
  return { code, exp };
}

// 老闆在 LINE 傳「綁定老闆 123456」
// 猜錯 5 次這組碼就作廢（6 位數，免得被亂試）
const MAX_TRIES = 5;
export async function bindBoss(userId, name, code) {
  const r = await getFirestore().runTransaction(async (tx) => {
    const d = (await tx.get(ref())).data() || {};
    const ids = d.ids || [];
    if (envBossIds().includes(userId) || ids.some((x) => x.userId === userId)) return { already: true };
    if (!d.code || d.code.exp < Date.now()) return { bad: true };
    if (d.code.code !== code) {
      const tries = (d.code.tries || 0) + 1;
      tx.set(ref(), { code: tries >= MAX_TRIES ? null : { ...d.code, tries } }, { merge: true });
      return { bad: true };
    }
    tx.set(ref(), { ids: [...ids, { userId, name: String(name || '').slice(0, 40), at: new Date().toISOString() }], code: null }, { merge: true });
    return { already: false };
  });
  if (r.bad) throw new UserError('綁定碼不對或過期了，請老闆到後台「設定 → 老闆的 LINE」重新產生。');
  reset();
  return r;
}

export async function unbindBoss(userId) {
  const d = (await ref().get()).data() || {};
  await ref().set({ ids: (d.ids || []).filter((x) => x.userId !== userId) }, { merge: true });
  reset();
  return listBoss();
}
