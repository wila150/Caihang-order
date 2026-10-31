import crypto from 'node:crypto';
import { bossIds, envBossIds } from './boss.js';

const API = 'https://api.line.me/v2/bot';

export function verifySignature(raw, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('base64'));
  const got = Buffer.from(signature);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function call(path, body) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  // 本機模擬器設成 dry-run：只印出來，不真的送
  if (!token || token === 'dry-run') {
    console.log('[LINE 未設定，略過]', path, JSON.stringify(body).slice(0, 300));
    return;
  }
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LINE ${path} ${r.status}: ${await r.text()}`);
}

export const reply = (replyToken, messages) => call('/message/reply', { replyToken, messages });
export const push = (to, messages) => call('/message/push', { to, messages });
// 聊天室顯示「…」載入動畫（像對方正在輸入），不算訊息額度；機器人傳出訊息就自動消失。秒數 5～60，要是 5 的倍數
export const loading = (userId, seconds) =>
  call('/chat/loading/start', { chatId: userId, loadingSeconds: Math.min(60, Math.max(5, Math.ceil(seconds / 5) * 5)) }).catch((e) => console.warn('loading', e.message));

export async function displayName(userId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || token === 'dry-run') return '';
  const r = await fetch(`${API}/profile/${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.ok ? (await r.json()).displayName || '' : '';
}

// 店家傳來的照片原檔
export async function getContent(messageId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`LINE content ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// 老闆的 LINE：設定檔的加上在 LINE 綁定的（見 boss.js）
export const adminIds = envBossIds;

export async function notifyAdmins(text) {
  const results = await Promise.allSettled((await bossIds()).map((id) => push(id, [{ type: 'text', text }])));
  results.filter((r) => r.status === 'rejected').forEach((r) => console.error(r.reason));
}

// 老闆的 LINE 切換圖文選單（老闆選單／店家選單），alias 在 scripts/richmenu/setup.mjs 建立
export async function linkMenu(userId, alias) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || token === 'dry-run') return console.log('[LINE 未設定，略過] 切換選單', alias);
  const r = await fetch(`${API}/richmenu/alias/${alias}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`找不到圖文選單「${alias}」，請先跑 scripts/richmenu/setup.mjs`);
  await call(`/user/${encodeURIComponent(userId)}/richmenu/${(await r.json()).richMenuId}`, {});
}
