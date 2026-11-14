// 建立 LINE 圖文選單（會刪掉舊的選單）：
//   店家選單：所有人的預設（我要叫貨、拍照叫貨、照上次叫、我的訂單、我的帳款、回報問題）
//   老闆選單：只套用在 ADMIN_LINE_USER_IDS（記帳、還要買、今日訂單、未收帳款、今日支出、開後台）；要測試叫貨打「店家選單」，切回來打「老闆選單」
// 先產生圖片：node scripts/richmenu/render.mjs veg
// 再建立：LINE_CHANNEL_ACCESS_TOKEN=… node scripts/richmenu/setup.mjs caihang-order
//   （第二個參數是 Firebase 專案，用來讀 functions/.env.<專案> 的 BASE_URL、ADMIN_LINE_USER_IDS）
import fs from 'node:fs';

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) throw new Error('請設定 LINE_CHANNEL_ACCESS_TOKEN');
const project = process.argv[2];
if (!project) throw new Error('請指定 Firebase 專案，例如 node scripts/richmenu/setup.mjs caihang-order');
const env = Object.fromEntries(fs.readFileSync(new URL(`../../functions/.env.${project}`, import.meta.url), 'utf8')
  .split('\n').map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const base = env.BASE_URL || `https://${project}.web.app`;
const admins = (env.ADMIN_LINE_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

const H = { Authorization: `Bearer ${token}` };
const api = async (url, opt = {}) => {
  const r = await fetch(url, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${url} ${r.status} ${t}`);
  return t ? JSON.parse(t) : {};
};
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// 圖片 2500×1686，兩個選單都是 2 排 × 3 格，三欄一樣寬（833／833／834）
const X = [0, 833, 1666], W = [833, 833, 834];
const msg = (text) => ({ type: 'message', label: text, text });

const menus = {
  store: {
    size: { width: 2500, height: 1686 }, selected: true, name: '店家選單', chatBarText: '叫貨選單',
    // 2 排 × 3 格
    // 「我要叫貨」直接打開叫貨頁（LIFF 用 LINE 身分認店家）；沒設定 LIFF 才傳文字讓機器人回連結
    areas: ['我要叫貨', '拍照叫貨', '照上次叫', '我的訂單', '我的帳款', '回報問題'].map((t, i) => ({
      bounds: { x: X[i % 3], y: i < 3 ? 0 : 843, width: W[i % 3], height: 843 },
      action: t === '我要叫貨' && env.LIFF_ID ? { type: 'uri', label: t, uri: `https://liff.line.me/${env.LIFF_ID}?order=1` } : msg(t),
    })),
  },
  boss: {
    size: { width: 2500, height: 1686 }, selected: true, name: '老闆選單', chatBarText: '老闆選單',
    // 2 排 × 3 格；開後台用 openExternalBrowser=1，LINE 改用 Safari／Chrome 開（LINE 內建瀏覽器不能用 Google 登入）
    areas: [msg('記帳'), msg('還要買'), msg('今日訂單'), msg('未收帳款'), msg('今日支出'), { type: 'uri', label: '開後台', uri: `${base}/admin?openExternalBrowser=1` }].map((action, i) => ({
      bounds: { x: X[i % 3], y: i < 3 ? 0 : 843, width: W[i % 3], height: 843 }, action,
    })),
  },
};

const old = (await api('https://api.line.me/v2/bot/richmenu/list')).richmenus || [];
const oldAliases = (await api('https://api.line.me/v2/bot/richmenu/alias/list')).aliases || [];
const ids = {};
for (const [k, menu] of Object.entries(menus)) {
  const { richMenuId } = await api('https://api.line.me/v2/bot/richmenu', json(menu));
  await api(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: fs.readFileSync(new URL(`./menu-${k}.jpg`, import.meta.url)),
  });
  ids[k] = richMenuId;
}
// 別名：richmenuswitch 和 webhook 的「老闆選單」靠這個找到選單
for (const k of Object.keys(ids)) {
  if (oldAliases.some((a) => a.richMenuAliasId === k)) await api(`https://api.line.me/v2/bot/richmenu/alias/${k}`, json({ richMenuId: ids[k] }));
  else await api('https://api.line.me/v2/bot/richmenu/alias', json({ richMenuAliasId: k, richMenuId: ids[k] }));
}
await api(`https://api.line.me/v2/bot/user/all/richmenu/${ids.store}`, { method: 'POST' });
if (admins.length) await api('https://api.line.me/v2/bot/richmenu/bulk/link', json({ richMenuId: ids.boss, userIds: admins }));
for (const m of old) await api(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: 'DELETE' });
console.log(`店家選單（預設）：${ids.store}\n老闆選單：${ids.boss}，套用到 ${admins.length} 個老闆 LINE\n刪除舊選單 ${old.length} 個`);
