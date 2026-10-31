// AI 叫貨流程：webhook 收到 → 建 aiJobs（Firestore 觸發 aiOrder 函式處理）→ 回卡片給店家確認 → 店家按「確認送出」才成立訂單
//   aiJobs/{id}     待處理的訊息（webhook 先存起來，馬上回 200 給 LINE）
//   aiDrafts/{id}   AI 整理好的叫貨單，等店家確認
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import sharp from 'sharp';
import { parseOrder } from './ai.js';
import { reply, push, getContent, notifyAdmins } from './line.js';
import { orderLink } from './token.js';
import { openDate, today, getRulesNow } from './dates.js';
import { roundQty } from './qty.js';
import * as shop from './shop.js';
import { UserError } from './http.js';
import { draftMessage, orderMessage } from './messages.js';
import { readInvoice, savePurchase, purchaseText } from './purchase.js';
import { displayName } from './line.js';

const db = () => getFirestore();

// 用 LINE 的 webhookEventId 當文件 ID：LINE 重送同一個事件時 create 會失敗，就不會重複辨識、重複回卡片
export async function queue(job, eventId) {
  const col = db().collection('aiJobs');
  const ref = eventId ? col.doc(String(eventId).replace(/[^\w-]/g, '')) : col.doc();
  if (eventId && (await db().collection('aiDrafts').doc(ref.id).get()).exists) return; // 已經處理過（aiJobs 處理完會刪掉，所以也查 aiDrafts）
  await ref.create({ ...job, at: new Date().toISOString() }).catch((e) => { if (e.code !== 6) throw e; }); // 6＝ALREADY_EXISTS
}

// 每家店每天最多用幾次 AI（控制 NVIDIA 費用）；超過就請店家用叫貨單
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 30);
export async function aiQuotaOk(storeId) {
  const ref = db().doc(`aiUsage/${today()}_${storeId}`);
  return db().runTransaction(async (tx) => {
    const n = ((await tx.get(ref)).data()?.n || 0) + 1;
    if (n > AI_DAILY_LIMIT) return false;
    tx.set(ref, { n, date: today(), storeId });
    return true;
  });
}
// AI 金鑰失效、額度用完：一天通知老闆一次
async function alertAiDown(err) {
  const ref = db().doc('aiUsage/alert_' + today());
  const first = await ref.create({ at: new Date().toISOString() }).then(() => true, () => false);
  if (first) await notifyAdmins(`⚠️ AI 叫貨今天出錯了：${String(err.message || err).slice(0, 80)}\n店家傳的照片或文字可以到後台「AI 紀錄」用「看照片改單」處理。`).catch(() => {});
}

// 回覆用 replyToken（不算額度），過期了才改推播
async function answer(job, messages) {
  try { await reply(job.replyToken, messages); }
  catch (e) { console.warn('reply 失敗，改用 push', e.message); await push(job.userId, messages); }
}

// 老闆拍上游的進貨單：讀單、核對，回摘要
async function processPurchase(job) {
  try {
    const raw = await getContent(job.messageId);
    const buf = await sharp(raw).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).grayscale().normalize().sharpen().jpeg({ quality: 85 }).toBuffer();
    // 後台看的照片要看得清楚數字，比叫貨單大一點
    const thumb = 'data:image/jpeg;base64,' + (await sharp(raw).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 62, mozjpeg: true }).toBuffer()).toString('base64');
    const inv = await readInvoice('data:image/jpeg;base64,' + buf.toString('base64'));
    if (!inv.lines.length) return answer(job, [{ type: 'text', text: '這張看不出是進貨單（沒讀到品項）。要記帳的話直接打「品名 金額」。' }]);
    const p = await savePurchase({ inv, thumb, by: await displayName(job.userId).catch(() => ''), source: 'line' });
    return answer(job, [{ type: 'text', text: purchaseText(p) }]);
  } catch (e) {
    console.error('進貨單辨識失敗', e);
    await alertAiDown(e);
    return answer(job, [{ type: 'text', text: '抱歉，這張進貨單沒讀成功，請拍清楚一點再傳一次（整張單拍進去、不要反光）。' }]);
  }
}

export async function processJob(job, jobId) {
  if (job.type === 'purchase') return processPurchase(job);
  const store = await shop.storeOfUser(job.userId);
  if (!store) return;
  const [products, storeAliases, usual] = await Promise.all([shop.getProducts(), shop.getStoreAliases(store.id), shop.usualPids(store.id).catch(() => [])]);
  const date = openDate();
  const ref = db().collection('aiDrafts').doc(jobId);
  if ((await ref.get()).exists) return; // 重送的事件，處理過了
  // 每一筆都留紀錄（含失敗），後台「AI 紀錄」看得到
  const base = { id: ref.id, storeId: store.id, storeName: store.name, userId: job.userId, date, type: job.type, text: job.text || '', items: [], unknown: [], note: '', createdAt: new Date().toISOString() };
  let image, thumb = '';
  let parsed;
  try {
    if (job.type === 'image') {
      // 縮小再送，AI 比較快，也不會超過大小限制；另外存一張小縮圖給後台看
      const raw = await getContent(job.messageId);
      // 手寫單：轉灰階、拉對比、稍微銳利化，字比較清楚
      const buf = await sharp(raw).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).grayscale().normalize().sharpen().jpeg({ quality: 85 }).toBuffer();
      image = 'data:image/jpeg;base64,' + buf.toString('base64');
      // 原圖不留（在 LINE 那邊）；後台看的縮圖約 50～90KB（看得清楚手寫字），店家確認後就刪，其他的 14 天後自動清掉
      thumb = 'data:image/jpeg;base64,' + (await sharp(raw).rotate().resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 60, mozjpeg: true }).toBuffer()).toString('base64');
    }
    const t = Date.now();
    parsed = await parseOrder({ text: job.text, image, products, storeAliases, usual });
    console.log('AI 叫貨', JSON.stringify({ store: store.name, type: job.type, ms: Date.now() - t, sent: parsed.sent, items: parsed.items.length, unknown: parsed.unknown }));
  } catch (e) {
    console.error('AI 辨識失敗', store.name, job.type, e);
    await alertAiDown(e);
    await ref.set({ ...base, thumb, status: 'error', error: String(e.message || e).slice(0, 300) });
    return answer(job, [{ type: 'text', text: '抱歉，這次沒辦法自動整理，請點下方「我要叫貨」用叫貨單叫，或直接留言給老闆。' }]);
  }
  // 什麼都看不出來（多半是聊天或別的照片），就不打擾店家，但留紀錄
  if (!parsed.items.length && !parsed.unknown.length) {
    await ref.set({ ...base, ...parsed, thumb, status: 'empty' });
    return;
  }
  // 辨識完才決定配送日（照片可能辨識很久，跨過截單）
  //   截單後還能補單：讓店家自己選「補明天的貨」還是「叫下一個配送日」
  //   原本的單已經被老闆確認：加進補單
  const D = openDate();
  const af = await shop.addonFor(store.id);
  const choice = af && !af.mainLocked && af.date !== D ? af.date : null;
  const toAddon = !!(af?.mainLocked && af.date === D);
  const draft = { ...base, ...parsed, date: D, addonDate: choice, thumb, status: 'pending' };
  await ref.set(draft);
  const existing = choice ? null : toAddon ? await shop.addonSlipOf(store.id, D) : await shop.getOrder(D, store.id);
  const editUrl = `${orderLink(job.origin, job.userId)}&d=${ref.id}${toAddon ? '&m=addon' : ''}`;
  await answer(job, [draftMessage(store, draft, { existing: existing?.items || [], toAddon, choice, editUrl, edits: { done: existing?.storeEdits || 0, max: toAddon ? 0 : getRulesNow().maxEdits ?? 2 } })]);
}

// AI 整理的品項套到現有的單上：add 加上去、set 改成、remove 不要了
export function applyOps(oldItems, ops) {
  const items = (oldItems || []).map((i) => ({ pid: i.pid, qty: i.qty }));
  for (const it of ops) {
    const same = items.find((x) => x.pid === it.pid);
    const op = it.op || 'add';
    if (op === 'remove') { if (same) items.splice(items.indexOf(same), 1); }
    else if (op === 'set') { if (same) same.qty = it.qty; else items.push({ pid: it.pid, qty: it.qty }); }
    else if (same) same.qty = roundQty(same.qty + it.qty); else items.push({ pid: it.pid, qty: it.qty });
  }
  return items;
}
const sameItems = (a, b) => JSON.stringify(a.map((i) => `${i.pid}:${i.qty}:${i.op || 'add'}`).sort()) === JSON.stringify(b.map((i) => `${i.pid}:${i.qty}:${i.op || 'add'}`).sort());

// 店家按「確認送出」
// 連按兩下或 LINE 重送 postback 時，只有第一次會成立：先用 transaction 把狀態從 pending 改成 confirming（搶到的才往下做）
export async function confirmDraft(userId, id, origin, to = '', force = false) {
  const ref = db().collection('aiDrafts').doc(String(id || '').replace(/[^\w-]/g, '') || '_');
  const store = await shop.storeOfUser(userId);
  if (!store) return { type: 'text', text: '找不到這張叫貨單，請重新傳一次。' };
  const D = openDate();
  const af = await shop.addonFor(store.id);
  // 決定要放哪一張單：店家選了補單、原本的單已確認、或卡片送到之後剛好過了截單（還能補單就自動改成補單）
  const pick = (d) => {
    if (to === 'addon') return af && af.date === (d.addonDate || d.date) ? { date: af.date, addon: true } : null;
    if (d.date === D) return { date: D, addon: !!(af?.mainLocked && af.date === D) };
    if (af && af.date === d.date) return { date: d.date, addon: true, late: true };
    return null;
  };
  // 同樣的內容 15 分鐘內已經確認過（多半是照片傳了兩次）：先問一下，免得叫兩倍
  if (!force) {
    const d0 = (await ref.get()).data();
    const t0 = d0 && pick(d0);
    if (d0?.status === 'pending' && t0) {
      const since = Date.now() - 15 * 60e3;
      const recent = (await db().collection('aiDrafts').where('storeId', '==', store.id).where('status', '==', 'confirmed').get()).docs.map((x) => x.data())
        .filter((x) => x.id !== d0.id && (x.confirmedAt?.toMillis?.() || 0) > since && x.target === `${t0.date}${t0.addon ? '+' : ''}` && sameItems(x.items, d0.items));
      if (recent.length) return {
        type: 'text', text: '這張跟剛才確認送出的一模一樣，是不是照片傳了兩次？\n真的要再加一次的話，按下面「再加一次」。',
        quickReply: { items: [{ type: 'action', action: { type: 'postback', label: '再加一次', data: `action=aiok&id=${d0.id}&to=${to}&force=1`, displayText: '再加一次' } }] },
      };
    }
  }
  const claim = await db().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || d.storeId !== store.id) return { msg: '找不到這張叫貨單，請重新傳一次。' };
    if (d.status !== 'pending') return { msg: '這張叫貨單已經處理過了，點「我的訂單」可以查看。' };
    const t = pick(d);
    if (!t) { tx.update(ref, { status: 'expired' }); return { msg: to === 'addon' ? '補單時間已經過了，要追加請直接留言給老闆。' : '這張叫貨單的配送日已經截單了，請點「我要叫貨」重新叫。' }; }
    tx.update(ref, { status: 'confirming' });
    return { d, t };
  });
  if (!claim.d) return { type: 'text', text: claim.msg };
  const { d, t } = claim;
  let saved;
  try {
    // 在 saveOrder 的 transaction 裡讀最新的單再套用
    const merge = (old) => applyOps(old?.items, d.items);
    saved = t.addon ? await shop.saveAddon(store.id, t.date, merge)
      : await shop.saveOrder(store.id, t.date, merge, '店家', d.type === 'image' ? 'LINE 照片叫貨' : 'LINE 文字叫貨');
  } catch (e) {
    // 只有「訂單沒存成功」才放回 pending，店家可以再按一次；存成功之後的錯誤不能放回去，不然會重複加
    await ref.update({ status: 'pending' }).catch(() => {});
    if (e.status) return { type: 'text', text: e.message };
    throw e;
  }
  await ref.update({ status: 'confirmed', confirmedAt: FieldValue.serverTimestamp(), thumb: FieldValue.delete(), target: `${t.date}${t.addon ? '+' : ''}`, savedSeq: saved.order.seq || 1 });
  const card = t.addon ? orderMessage(saved.had ? '補單已更新' : '補單已收到', store, t.date, saved.order, orderLink(origin, userId), false)
    : orderMessage(saved.had ? '訂單已更新' : '訂單已收到', store, t.date, saved.order, orderLink(origin, userId));
  return t.late ? [{ type: 'text', text: '剛剛已經過了截單時間，幫您改成補單了（另開一張，原本的單不變）。' }, card] : card;
}

// 叫貨頁「用叫貨單修改」時帶入 AI 整理的品項
export async function draftFor(userId, id) {
  const d = (await db().collection('aiDrafts').doc(id).get()).data();
  const store = await shop.storeOfUser(userId);
  if (!d || !store || d.storeId !== store.id || d.status !== 'pending') return null;
  // 只帶還能用的：那天還在叫貨中，或還能補單
  const af = await shop.addonFor(store.id);
  if (d.date !== openDate() && !(af && (af.date === d.date || af.date === d.addonDate))) return null;
  return { id: d.id, date: d.date, addonDate: d.addonDate || null, items: d.items.map(({ pid, qty, op }) => ({ pid, qty, op: op || 'add' })), unknown: d.unknown };
}

// 後台「對照改單」：行政看著照片把這家店那天的訂單改好（整張單照畫面上的存）
export async function applyDraft(id, items, who) {
  const ref = db().collection('aiDrafts').doc(String(id).replace(/[^\w-]/g, '') || '_');
  const d = (await ref.get()).data();
  if (!d) throw new UserError('找不到這筆 AI 紀錄，請重新整理', 404);
  const note = `${who}・對照${d.type === 'image' ? '照片' : '訊息'}`;
  const signed = async (seq) => (await db().doc(`signatures/${d.date}_${shop.slipKey(d.storeId, seq)}`).get()).exists;
  let r;
  if (!(await signed(1))) r = await shop.saveOrder(d.storeId, d.date, items, '後台', note + '改單');
  // 原本的單已經確認（鎖住）：另開一張補單；同一筆紀錄再按儲存，就改同一張補單，不會一直多開
  else if (d.handledSeq && d.handledSeq > 1 && !(await signed(d.handledSeq))) r = await shop.saveOrder(d.storeId, d.date, items, '後台', note + '改補單', d.handledSeq);
  else r = await shop.saveNewSlip(d.storeId, d.date, items, '後台', note + '開補單');
  await ref.update({ status: 'admin', handledBy: who, handledAt: new Date().toISOString(), handledSeq: r.order.seq || 1 });
  return r;
}

// 店家改用叫貨單送出：只有這家店自己的、還在等確認的草稿才標記
export async function markDraftUsed(id, storeId) {
  const ref = db().collection('aiDrafts').doc(String(id).replace(/[^\w-]/g, '') || '_');
  const d = (await ref.get()).data();
  if (d?.storeId === storeId && d.status === 'pending') await ref.update({ status: 'edited', thumb: FieldValue.delete() }).catch(() => {});
}

// 每天清一次：14 天前的照片縮圖刪掉（文字紀錄留著）
export async function cleanOldPhotos(days = 14) {
  const before = new Date(Date.now() - days * 86400e3).toISOString();
  const snap = await db().collection('aiDrafts').where('createdAt', '<', before).get();
  const old = snap.docs.filter((d) => d.data().thumb);
  for (let i = 0; i < old.length; i += 400) {
    const b = db().batch();
    old.slice(i, i + 400).forEach((d) => b.update(d.ref, { thumb: FieldValue.delete() }));
    await b.commit();
  }
  console.log(`清掉 ${old.length} 張 AI 叫貨照片縮圖`);
}
