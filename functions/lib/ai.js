// AI 辨識叫貨：把店家在 LINE 打的字或手寫單照片，對應到品項清單
// 用 NVIDIA（build.nvidia.com）的 OpenAI 相容 API；要換模型或服務，改 AI_MODEL／AI_BASE_URL 就好
import { roundQty } from './qty.js';
import { SHOP, PRESET } from './config.js';

const BASE = process.env.AI_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const MODEL = process.env.AI_MODEL || 'z-ai/glm-5.3-flash';

// 看起來像在叫貨：有數字，或「三斤」「半包」這種說法
export const looksLikeOrder = (text) =>
  text.length <= 400 && (/\d/.test(text) || /[一二兩三四五六七八九十半][\s]*(斤|兩|包|箱|袋|盒|公斤|把|顆|罐|件|籃|綑|紮|簍)/.test(text));

const aliasesOf = (p) => (Array.isArray(p.alias) ? p.alias : String(p.alias || '').split(/[、,，]/)).map((s) => s.trim()).filter(Boolean);

/* ---------- 品項多的時候（匯入 ERP 後兩千多項）只送可能相關的，AI 比較快、比較便宜，也比較不會選錯 ---------- */
export const FULL_MAX = 300; // 品項不超過這個數就整份送（原本的做法）
// 品名去掉括號裡的單位、規格：「高麗菜(公)」「高麗菜(件)」都是「高麗菜」
export const baseName = (n) => String(n).replace(/[（(][^）)]*[）)]/g, '').replace(/[\s　]/g, '');
const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
// text：店家打的字（照片是先抄出來的字）；usual：這家店常叫的 pid；回傳要送給 AI 的品項
export function pickCandidates(text, products, { usual = [], storeAliases = [] } = {}) {
  if (products.length <= FULL_MAX) return products;
  const t = String(text || '').replace(/[\s　]/g, '');
  const tg = grams(t), tc = new Set(t);
  const score = (w) => {
    w = baseName(w);
    if (!w) return 0;
    if (t.includes(w)) return 100 + w.length; // 整個品名都有寫到
    if (w.length < 2) return 0;
    const g = [...grams(w)], hit = g.filter((x) => tg.has(x)).length;
    if (hit / g.length >= 0.5) return 10 * hit; // 寫了一部分（高麗菜苗 ↔ 高麗菜）
    const c = [...new Set(w)], same = c.filter((x) => tc.has(x)).length;
    return w.length >= 3 && same / c.length >= 0.66 ? same : 0; // 錯字（高利菜 ↔ 高麗菜）
  };
  // 只寫一兩個字的（蛋、豆干）：品名有包含的都算（雞蛋、水煮蛋、白豆干）
  const short = [...new Set(String(text || '').split(/[\d０-９.．,，、;；:：\n\s　xX×*＊()（）\[\]]+|[一二兩三四五六七八九十百半]+(?=[斤兩包箱袋盒把顆罐件籃綑紮簍板條塊瓶片隻尾捆])|(?<=[^\s])(?:斤|兩|公斤|包|箱|袋|盒|把|顆|罐|件|籃|綑|紮|簍|板|條|塊|瓶|片|隻|尾|捆)(?=$|[\s\d、,，])/))].map((w) => w.trim()).filter((w) => w.length && w.length <= 2);
  const best = new Map();
  for (const p of products) {
    const s = Math.max(score(p.name), ...aliasesOf(p).map(score), short.some((w) => baseName(p.name).includes(w)) ? 50 : 0);
    if (s) best.set(p.id, s);
  }
  // 同一個菜的其他單位（高麗菜、高麗菜(公)、高麗菜(件)）一起送，AI 才能照客人寫的單位選
  const hitBase = new Map();
  for (const p of products) if (best.has(p.id)) hitBase.set(baseName(p.name), Math.max(hitBase.get(baseName(p.name)) || 0, best.get(p.id)));
  const ranked = products.filter((p) => hitBase.has(baseName(p.name))).sort((a, b) => hitBase.get(baseName(b.name)) - hitBase.get(baseName(a.name)) || (best.get(b.id) || 0) - (best.get(a.id) || 0));
  const keep = new Set([...ranked.slice(0, 200).map((p) => p.id), ...usual.slice(0, 60), ...storeAliases.map((a) => a.pid)]);
  return products.filter((p) => keep.has(p.id));
}

// 清單裡用短編號（1、2、3…）代替品項 id，送出去的字比較少
function systemPrompt(products, storeAliases = [], usual = new Set()) {
  const catalog = products.map((p, i) => { const a = aliasesOf(p); const k = (p.packs || []).map((x) => `1${x.unit}=${x.n}${p.unit}`); return `${i + 1}｜${p.name}｜${p.unit}${k.length ? `｜換算：${k.join('、')}` : ''}${a.length ? `｜也寫作：${a.join('、')}` : ''}${usual.has(p.id) ? '｜常叫' : ''}`; }).join('\n');
  const ref = new Map(products.map((p, i) => [p.id, i + 1]));
  const mine = storeAliases.filter((a) => ref.has(a.pid)).map((a) => `「${a.text}」→ ${ref.get(a.pid)}（${products[ref.get(a.pid) - 1].name}）`);
  return `你是台灣${SHOP.kind}的叫貨助理。把客人（餐廳、小吃店）傳來的叫貨內容，對應到下面的品項清單，只輸出 JSON，不要任何解釋。

品項清單（編號｜品名｜單位｜客人常見的其他寫法）：
${catalog}
${mine.length ? `
這家店的專屬叫法（跟上面衝突時，以這裡為準）：
${mine.join('\n')}
` : ''}
規則：
- 先比對「也寫作」和專屬叫法，客人寫的跟這些叫法一樣或只差錯字、簡寫時，直接對到那個品項。
- 台灣慣用說法：${PRESET.aiRule}「半斤」＝0.5 斤；1 斤＝16 兩，例如「一斤二兩」＝1.125 斤。「斤」「台斤」是同一個（600 公克）；1 公斤＝1000 公克＝約 1.667 台斤，清單單位是斤、客人寫公斤時要換算（例如 3 公斤＝5 斤），清單單位是公斤、客人寫斤時反過來換算。
- 品項有「換算」時，客人用那個包裝單位叫（例如「高麗菜2件」，換算 1件=10斤），qty 要乘成品項的單位（20），raw 保留原本寫法。
- 同一個菜有好幾個品項、只差單位或規格（例如「高麗菜｜斤」「高麗菜(公)｜公斤」「高麗菜(件)｜件」）：客人寫的單位是哪個就選單位一樣的那個；沒寫單位時選標「常叫」的，都沒有就選單位是斤的。括號裡寫「切」「絲」「去皮」這種是加工過的，客人有寫才選。
- 數量沒寫單位時，用該品項的單位。客人寫的單位和清單不同時（例如清單是「包」客人寫「斤」），照清單單位換算不了就放進 unknown。
- 對不到清單的品項放進 unknown，保留客人原本的寫法，不要硬塞到相近的品項。
- 照片：先把每一行字照原樣抄到 lines（看不清楚的字用 ? 代替），再一行一行對應品項。手寫的「斤」常寫成「斤」「f」「厂」，「包」常寫成「包」「勹」「ㄅ」，阿拉伯數字和國字都要認。
- 照片裡的日期、店名、電話不是品項，不要放進 items 或 unknown。
- op 表示要怎麼改這次的單：一般叫貨是 "add"（加上去）；客人說「改成」「改為」「只要」某數量是 "set"（qty 是改完的數量）；說「不要了」「取消」「刪掉」是 "remove"（qty 填 0）。
- 叫貨的數量，斤以下用兩（1/16 斤）為單位，例如 1 公斤換成斤是 1.6875（1斤11兩），不要有很多位小數。
- 不是叫貨的訊息（例如抱怨品質、問問題、聊天、回報配送單有問題）items 和 unknown 都留空陣列。
- note 放客人的其他交代（例如送貨時間），沒有就留空字串。

輸出格式：{"lines":["大蒜3","香菜兩把"],"items":[{"pid":12,"qty":3,"op":"add","raw":"大蒜3"}],"unknown":["香菜兩把"],"note":""}（pid 是清單最前面的編號；打字叫貨時 lines 可以是空陣列）`;
}

// 照片先只抄字（提示很短、很快），再拿抄出來的字去對品項；品項多的時候才這樣分兩步
const READ_PROMPT = `你在看台灣餐廳傳給${SHOP.kind}的手寫或印出來的叫貨單照片。把每一行叫貨內容照原樣抄下來（品名、數量、單位），看不清楚的字用 ? 代替。手寫的「斤」常寫成「f」「厂」，「包」常寫成「勹」「ㄅ」，阿拉伯數字和國字都要認。日期、店名、電話不要抄；其他交代（送貨時間等）放 note。只輸出 JSON：{"lines":["高麗菜 3斤","香菜兩把"],"note":""}`;

// 呼叫 AI 拿 JSON；偶爾回空白或格式跑掉，再試一次
async function askJson(messages, { image = false } = {}) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('尚未設定 NVIDIA_API_KEY');
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(image ? 55000 : 30000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0, max_tokens: 2000 }),
    });
    // 金鑰失效、額度用完這種錯，重試也沒用
    if (r.status === 401 || r.status === 403) throw new Error(`AI 金鑰被拒絕（${r.status}）：請到 build.nvidia.com 換新的 API key`);
    if (!r.ok) { lastErr = new Error(`AI ${r.status}: ${(await r.text()).slice(0, 200)}`); continue; }
    const out = (await r.json()).choices?.[0]?.message?.content || '';
    const m = out.match(/\{[\s\S]*\}/);
    try { if (m) return JSON.parse(m[0]); } catch {}
    lastErr = new Error('AI 沒有回傳 JSON：' + out.slice(0, 200));
  }
  throw lastErr;
}

// text 或 image（data:image/jpeg;base64,…）擇一
// usual：這家店常叫的 pid（叫越多越前面）
export async function parseOrder({ text, image, products, storeAliases = [], usual = [] }) {
  const on = products.filter((p) => p.on);
  const big = on.length > FULL_MAX;
  let read = null;
  // 品項多：照片先抄字，後面跟打字叫貨一樣處理
  if (image && big) {
    read = await askJson([{ role: 'system', content: READ_PROMPT }, { role: 'user', content: [{ type: 'text', text: '請抄出這張叫貨單。' }, { type: 'image_url', image_url: { url: image } }] }], { image: true });
    read.lines = (Array.isArray(read.lines) ? read.lines : []).map((s) => String(s)).filter(Boolean);
    if (!read.lines.length) return { items: [], unknown: [], lines: [], note: String(read.note || '').slice(0, 100), model: MODEL, sent: 0 };
    text = read.lines.join('\n') + (read.note ? `\n（備註：${read.note}）` : '');
  }
  const list = big ? pickCandidates(text, on, { usual, storeAliases }) : on;
  const user = image && !big
    ? [{ type: 'text', text: '這是客人的手寫叫貨單照片，請整理成 JSON。' }, { type: 'image_url', image_url: { url: image } }]
    : text;
  const j = await askJson([{ role: 'system', content: systemPrompt(list, storeAliases, new Set(usual.slice(0, 60))) }, { role: 'user', content: user }], { image: image && !big });
  if (read) { j.lines = read.lines; if (!j.note && read.note) j.note = read.note; }

  // 只收清單裡、有上架的品項，同一品項合併；pid 是清單的短編號（舊格式送 id 也認得）
  const pm = new Map(on.map((p) => [p.id, p]));
  const items = [];
  for (const it of Array.isArray(j.items) ? j.items : []) {
    const p = list[Number(it?.pid) - 1] || pm.get(it?.pid);
    const op = it?.op === 'set' || it?.op === 'remove' ? it.op : 'add'; // 加上去／改成／不要了
    // 斤的品項對齊到兩（1/16 斤），公斤換算後才不會出現 1.6667 斤這種數字
    const raw = op === 'remove' ? 0 : Number(it?.qty);
    const qty = p?.unit === '斤' ? Math.round(raw * 16) / 16 : roundQty(raw);
    if (!p || (op !== 'remove' && !(qty > 0)) || qty > 999) { if (it?.raw) (j.unknown ||= []).push(String(it.raw)); continue; }
    const same = items.find((x) => x.pid === p.id);
    if (same && same.op === 'add' && op === 'add') same.qty = roundQty(same.qty + qty);
    else if (same) Object.assign(same, { op, qty });
    else items.push({ pid: p.id, name: p.name, unit: p.unit, qty, op, raw: String(it.raw || '').slice(0, 40) });
  }
  const unknown = (Array.isArray(j.unknown) ? j.unknown : []).map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 10);
  const lines = (Array.isArray(j.lines) ? j.lines : []).map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 30);
  return { items, unknown, lines, note: String(j.note || '').slice(0, 100), model: MODEL, sent: list.length };
}
