// LINE Messaging API webhook：https://你的網址/api/webhook
import { SHOP } from '../lib/config.js';
import { verifySignature, reply, displayName, notifyAdmins, loading, linkMenu } from '../lib/line.js';
import { bossIds, bindBoss } from '../lib/boss.js';
import { pairApprove } from '../lib/linelogin.js';
import { getFirestore } from 'firebase-admin/firestore';
import * as ex from '../lib/expense.js';
import { supplierLedger, manualPurchase, paySupplier, removeSupplierPay } from '../lib/purchase.js';
import { orderLink } from '../lib/token.js';
import { originOf } from '../lib/http.js';
import { openDate, today, addDays, label, cutoffLabel, getRulesNow, buyDate } from '../lib/dates.js';
import { qtyText } from '../lib/qty.js';
import * as shop from '../lib/shop.js';
import { welcome, orderMessage, orderCard, myOrders, addonCard, flex } from '../lib/messages.js';
import { looksLikeOrder } from '../lib/ai.js';
import { queue, confirmDraft, aiQuotaOk } from '../lib/aiorder.js';
import { storeChat } from './storechat.js';
import { bossInfo } from './bosschat.js';

export async function POST(request) {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get('x-line-signature'))) {
    return new Response('bad signature', { status: 401 });
  }
  const { events = [] } = JSON.parse(raw);
  const origin = originOf(request);
  await Promise.all(events.map((e) => handle(e, origin).catch((err) => console.error(err))));
  return new Response('ok');
}

async function handle(e, origin) {
  const uid = e.source?.userId;
  if (!uid || !e.replyToken || e.source.type !== 'user') return;
  const store = await shop.storeOfUser(uid);
  const url = orderLink(origin, uid);
  const say = (...messages) => reply(e.replyToken, messages);

  if (e.type === 'follow') return say(welcome(!!store));

  const said = e.type === 'message' && e.message.type === 'text' ? e.message.text.trim() : '';
  const pb = e.type === 'postback' ? new URLSearchParams(e.postback.data) : new URLSearchParams();
  const action = pb.get('action') || '';
  const wantsOrder = action === 'order' || /叫貨|叫菜|訂貨|下單|訂購/.test(said);
  const wantsMine = action === 'mine' || /^(我的訂單|查訂單|訂單查詢)$/.test(said);

  if (/^我的\s*id$/i.test(said)) {
    return say({ type: 'text', text: `您的 LINE userId：\n${uid}\n\n要設成老闆，請到後台「設定 → 老闆的 LINE」產生綁定碼，在這裡傳「綁定老闆 綁定碼」。` });
  }
  // 後台登入碼：後台登入畫面顯示 6 位數，在 LINE 傳「後台登入 123456」就登入（手機主畫面的 App 用）
  const pairCode = said.match(/^後台登入\s*(\d{6})$/)?.[1];
  if (pairCode) return say({ type: 'text', text: (await pairApprove(uid, await displayName(uid), pairCode)).text });
  // 綁定老闆：後台產生 6 位數綁定碼，老闆在 LINE 傳「綁定老闆 123456」
  const bossCode = said.match(/^綁定老闆\s*(\d{6})$/)?.[1];
  if (bossCode) {
    try {
      const name = await displayName(uid);
      const r = await bindBoss(uid, name, bossCode);
      if (r.already) return say({ type: 'text', text: '您已經是老闆了，傳「老闆選單」可以切到老闆選單。' });
      await linkMenu(uid, 'boss').catch((err) => console.error(err));
      await getFirestore().doc('adminMode/' + uid).set({ mode: 'boss' }, { merge: true });
      await notifyAdmins(`👑 ${name || '（未知名稱）'} 綁定成老闆的 LINE 了。不是你們的人的話，到後台「設定 → 老闆的 LINE」解除。`).catch(() => {});
      return say({ type: 'text', text: '✅ 已綁定成老闆！下面換成老闆選單了：\n・記帳：直接打「油錢 500」\n・還要買、今日訂單、未收帳款都在選單上\n・店家叫貨、開通申請會通知您\n\n要測試叫貨，傳「店家選單」切過去。' });
    } catch (err) {
      if (err.status) return say({ type: 'text', text: err.message });
      throw err;
    }
  }
  if (action === 'contact' || /^聯絡(我們|老闆)?$/.test(said)) {
    return say({ type: 'text', text: `直接在這裡留言就可以，老闆看到會回覆您。${SHOP.phone ? `\n急事請打 ${SHOP.phone}` : ''}` });
  }

  // 掃店家的綁定 QR Code：聊天室帶好「綁定 XXXXXXXX」，送出就自動綁好（回覆不算訊息額度）
  const bindCode = said.match(/^綁定\s*([A-Za-z0-9]{6,12})$/)?.[1];
  if (bindCode) {
    try {
      const name = await displayName(uid);
      const r = await shop.bindByInvite(uid, name, bindCode);
      if (r.already) return say({ type: 'text', text: `您已經綁定「${r.store.name}」了，要叫貨直接打字傳過來就好。` });
      if (process.env.BIND_NOTIFY !== 'off') await notifyAdmins(`🔗 ${r.store.name} 多綁了一個 LINE：${name || '（未知名稱）'}\n不是你們的人的話，到後台「店家」解除：${origin}/admin`).catch(() => {});
      return say({ type: 'text', text: `✅ 已綁定「${r.store.name}」，可以叫貨了！\n\n・直接打字傳過來，例如「${SHOP.example}」\n・或在紙上寫好，點「拍照叫貨」拍照` });
    } catch (err) {
      if (err.status) return say({ type: 'text', text: err.message });
      throw err;
    }
  }

  // 記帳：老闆的 LINE（設定檔 ADMIN_LINE_USER_IDS 或在 LINE 綁定的）打「油錢 500」就記一筆支出。
  // 在老闆選單時「油錢 500」直接記；切到店家選單（測試叫貨）時要加「記帳」開頭，不然會被當成叫貨
  if ((await bossIds()).includes(uid)) {
    const r = await bossChat({ said, pb, action, store, uid, e, origin });
    if (r) return say(r);
    if (r === false) return;
  }

  // 還沒開通的人
  if (!store) {
    // 已經綁定、但店家被設成暫停合作：不要當成新申請
    if (await shop.isPausedMember(uid)) return say({ type: 'text', text: '您的店家目前暫停叫貨，有問題請直接在這裡留言給老闆。' });
    // 新店家自己開通：請他填店名、地址、電話（叫貨頁的表單），填完馬上能叫貨；先傳的叫貨內容會留著，開通後幫他整理
    if (getRulesNow().autoJoin !== false) {
      const orderText = said && looksLikeOrder(said) ? said : '';
      if (!(wantsOrder || wantsMine || orderText || said === '拍照叫貨' || action === 'photo' || (e.type === 'message' && e.message.type === 'image'))) return;
      await shop.addPending(uid, await displayName(uid), '', { order: orderText });
      return say({
        type: 'template',
        altText: '第一次叫貨，請先填店家資料',
        template: {
          type: 'buttons',
          text: `第一次使用，請先填店家資料（店名、地址、電話），填完馬上就能叫貨。${orderText ? '\n剛剛傳的叫貨內容會幫您留著。' : ''}`,
          actions: [{ type: 'uri', label: '📝 填店家資料', uri: url }],
        },
      });
    }
    if (wantsOrder || wantsMine || said === '拍照叫貨' || action === 'photo' || (e.type === 'message' && e.message.type === 'image')) {
      const name = await displayName(uid);
      const isNew = await shop.addPending(uid, name);
      if (isNew) await notifyAdmins(`🧄 有人申請叫貨帳號：${name || '（未知名稱）'}\n到後台「店家」開通：${origin}/admin`);
      return say({ type: 'text', text: '您還沒開通叫貨帳號，已經通知老闆了。\n請直接回覆您的「店名」，方便老闆幫您開通，開通後會再通知您。' });
    }
    // 申請中的人回覆的文字（通常是店名）記下來給老闆看；只記第一句，不會被後來的話蓋掉
    if (said && (await shop.getPending(uid))) {
      const saved = await shop.addPending(uid, '', said, { keepText: true });
      return say({ type: 'text', text: saved ? `收到「${said.slice(0, 20)}」，老闆開通後會通知您。` : '已經通知老闆了，開通後會通知您。' });
    }
    return;
  }

  // 店家確認配送單後按「回傳給老闆」帶過來的訊息
  if (/^已(確認|簽收)/.test(said)) return say({ type: 'text', text: '收到您的確認，謝謝！' });
  // 開通表單送出後，叫貨頁用店家的身分傳這句進來
  // 圖文選單：照上次叫、我的帳款、回報問題（回報後補的照片也在這裡處理，不會被當成叫貨）
  const sc = await storeChat({ e, said, pb, action, store, uid, url, origin });
  if (sc) return say(sc);
  if (said === '開通完成') return say({ type: 'text', text: `✅「${store.name}」開通好了！\n\n要叫貨直接打字傳過來就好，例如：\n${SHOP.example}\n也可以點下方「拍照叫貨」拍手寫單。` });

  // 圖文選單「拍照叫貨」：回快速回覆按鈕，點了直接開相機或相簿（圖文選單本身不能開相機）
  if (said === '拍照叫貨' || action === 'photo') {
    return say({
      type: 'text',
      text: '請拍一張叫貨單（手寫的也可以），或從相簿選照片。\n傳過來後大約 20 秒，會整理好給您確認。',
      quickReply: { items: [
        { type: 'action', action: { type: 'camera', label: '📷 拍照' } },
        { type: 'action', action: { type: 'cameraRoll', label: '🖼 從相簿選' } },
      ] },
    });
  }

  // AI 叫貨（放在關鍵字前面，「幫我叫貨 大蒜3」才會走 AI）：直接打字（像「大蒜3、去皮15斤」）或傳手寫單照片，交給 aiOrder 函式處理
  const isAiText = said && looksLikeOrder(said) && !/有問題|不對|少了|壞|爛|\?|？/.test(said);
  const isAiImage = e.type === 'message' && e.message.type === 'image';
  if (process.env.AI_ORDER !== 'off' && (isAiText || isAiImage) && !(await aiQuotaOk(store.id))) {
    return say({ type: 'text', text: '今天用 AI 整理的次數太多了，請點下方「我要叫貨」→「用清單選」，或直接留言給老闆。' });
  }
  if (process.env.AI_ORDER !== 'off') {
    // AI 讀的時候先顯示「…」（文字約 5 秒、照片約 20 秒）
    // 回報配送單有問題、問問題這類訊息不要送去 AI 叫貨
    if (said && looksLikeOrder(said) && !/有問題|不對|少了|壞|爛|\?|？/.test(said)) return loading(uid, 20).then(() => queue({ type: 'text', text: said, userId: uid, replyToken: e.replyToken, origin }, e.webhookEventId));
    if (e.type === 'message' && e.message.type === 'image') return loading(uid, 60).then(() => queue({ type: 'image', messageId: e.message.id, userId: uid, replyToken: e.replyToken, origin }, e.webhookEventId));
  }

  // 叫貨頁送出後，LIFF 會用店家的身分傳這幾句話進來，這裡回訂單卡（回覆不算訊息額度）
  const fromLiff = said.match(/^(訂單已送出|訂單已更新|取消今天的訂單)$/);
  const AF = await shop.addonFor(store.id);
  const A = AF?.date;
  const addonUrl = `${url}&m=addon`;
  // 截單後加點：補單跟原本的訂單分開，另開一張
  if (/^(補單|加點|追加|補單已送出|補單已更新|取消補單)$/.test(said)) {
    if (!A) return say({ type: 'text', text: '現在沒有可以補單的配送日。要叫貨請點「我要叫貨」；急著加點請直接留言給老闆。' });
    if (said === '取消補單') return say({ type: 'text', text: '好的，補單已取消。' });
    const o = await shop.addonSlipOf(store.id, A);
    return say(flex(said.startsWith('補單已') ? said : '補單', addonCard(store, A, o, addonUrl, AF.until)));
  }
  // 圖文選單「我要叫貨」：店家平常都直接傳訊息，所以請他直接打字（AI 整理好再給他確認），點選單選品項只留成備用
  if (!fromLiff && wantsOrder && process.env.AI_ORDER !== 'off') {
    const D = openDate();
    const o = await shop.getOrder(D, store.id);
    const has = o?.items?.length ? o.items : [];
    const lines = has.slice(0, 8).map((i) => `・${i.name} ${qtyText(i.qty, i.unit)}`).join('\n') + (has.length > 8 ? `\n…共 ${has.length} 樣` : '');
    const text = has.length
      ? `${label(D)} 配送已經叫了：\n${lines}\n\n要加或改，直接打字傳過來就好，例如：\n「再加 ${SHOP.example.split(/[、,，]/)[0]}」「${has[0].name}改成 5」「${has[0].name}不要了」`
      : `要叫什麼，直接打字傳過來就好 👇\n例如：${SHOP.example}\n\n一行一樣，或用頓號隔開都可以，傳了會整理好給您確認。`;
    return say({
      type: 'text',
      text: `${text}\n${cutoffLabel(D)} 截單，${label(D)} 送到。`,
      quickReply: { items: [
        { type: 'action', action: { type: 'message', label: '📷 拍照叫貨', text: '拍照叫貨' } },
        { type: 'action', action: { type: 'message', label: '📋 我的訂單', text: '我的訂單' } },
        { type: 'action', action: { type: 'uri', label: '☰ 用清單選', uri: url } },
      ] },
    });
  }
  if (fromLiff || wantsOrder) {
    const D = openDate();
    const o = await shop.getOrder(D, store.id);
    if (said === '取消今天的訂單') return say({ type: 'text', text: '好的，這次的訂單已取消。' });
    const title = fromLiff ? (said === '訂單已更新' ? '訂單已更新' : '訂單已收到') : '叫貨單';
    // 還能補單的話，多附一張補單卡片（回覆不算訊息額度）
    if (!fromLiff && A) return say(flex('叫貨單', { type: 'carousel', contents: [orderCard(AF.mainLocked ? '已確認' : title, store, D, o, url, !AF.mainLocked), addonCard(store, A, await shop.addonSlipOf(store.id, A), addonUrl, AF.until)] }));
    return say(orderMessage(title, store, D, o, url));
  }

  if (wantsMine) {
    const D = openDate();
    const cards = [];
    // 今天要送的、已截單還沒送的（例如今晚截單後問明天的貨），連補單一起列
    for (let d = today(); d <= D; d = addDays(d, 1)) {
      // 叫貨中的那張可以修改，沒叫貨也要顯示（按鈕是「我要叫貨」）
      if (d === D) cards.push(orderCard('我的訂單', store, D, await shop.getOrder(D, store.id), url));
      for (const o of await shop.slipsOfDay(store.id, d)) {
        const seq = o.seq || 1;
        if (d === D && seq === 1) continue;
        const title = seq > 1 || o.addon ? `補單 #${seq}` : d === today() ? '今天配送' : '已截單';
        cards.push(orderCard(title, store, d, o, url, false));
      }
    }
    return say(myOrders(store, cards.slice(-12)));
  }
  // AI 叫貨：店家按「確認送出」
  if (action === 'aiok') { const r = await confirmDraft(uid, pb.get('id'), origin, pb.get('to') || '', pb.get('force') === '1'); return say(...(Array.isArray(r) ? r : [r])); }

  // 其他訊息不自動回覆，讓老闆在 LINE 官方帳號後台手動回
}

/* ---------- 記帳（老闆的 LINE） ---------- */
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const mdOf = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const HOWTO = '記帳直接打「品名 金額」就好，例如：\n・進貨 七美 12000（跟七美進貨）\n・已付 七美 12000（付錢給七美）\n・油錢 500\n・昨天 紙箱 800\n金額可以打 1.2萬、3千；一次打好幾行就記好幾筆。\n\n查帳打「今天支出」「本月支出」；廠商打「應付帳款」「七美要付多少」。';

// LINE 按鈕最多 13 個：品項分類（ERP 有 35 類）放後面，油錢、薪水這些才按得到
// 舊的品項分類（換成廠商後藏起來的）不出現在按鈕
const byUse = (cats) => [...cats.filter((c) => !c.product), ...cats.filter((c) => c.product && !c.hidden)];

function savedReply(e, cats, head = '✅ 已記帳') {
  const others = byUse(cats).map((c) => c.name).filter((n) => n !== e.cat).slice(0, 10);
  return {
    type: 'text',
    text: `${head}\n${mdOf(e.date)} ${e.item} ${money(e.amount)}${e.payee ? `（${e.payee}）` : ''}${e.note ? `\n備註：${e.note}` : ''}\n分類：${e.cat}${e.cat === ex.OTHER ? '\n分類不對的話點下面改，下次打一樣的字就會記住' : ''}`,
    quickReply: { items: [
      { type: 'action', action: { type: 'postback', label: '↩ 取消這筆', data: `action=expdel&id=${e.id}`, displayText: '取消這筆' } },
      // 連續記同一家：點一下再打金額就好
      { type: 'action', action: { type: 'postback', label: `＋ 再記 ${e.cat}`.slice(0, 20), data: `action=expick&cat=${encodeURIComponent(e.cat)}`, displayText: `再記 ${e.cat}` } },
      ...others.map((n) => ({ type: 'action', action: { type: 'postback', label: `改成 ${n}`.slice(0, 20), data: `action=expcat&id=${e.id}&cat=${encodeURIComponent(n)}`, displayText: `改成 ${n}` } })),
    ] },
  };
}

// 老闆的 LINE：老闆選單（記帳）和店家選單（測試叫貨）可以切換；在老闆選單時打「品名 金額」就是記帳
const STORE_MENU = /^(我要叫貨|拍照叫貨|照上次叫|我的訂單|我的帳款|回報問題)$/;
const modeRef = (uid) => getFirestore().doc('adminMode/' + uid);
async function bossChat({ said, pb, action, store, uid, e, origin }) {
  if (action === 'menu') {
    await modeRef(uid).set({ mode: pb.get('to') === 'store' ? 'store' : 'boss' }, { merge: true });
    return false; // 圖文選單切換，不用回覆
  }
  if (/^(老闆選單|老闆模式)$/.test(said) || /^(店家選單|店家模式)$/.test(said)) {
    const mode = /老闆/.test(said) ? 'boss' : 'store';
    await linkMenu(uid, mode);
    await modeRef(uid).set({ mode }, { merge: true });
    return { type: 'text', text: mode === 'boss' ? '已切到老闆選單：打「油錢 500」就能記帳。' : '已切到店家選單，可以測試叫貨。要切回來打「老闆選單」。' };
  }
  // 今日訂單、未收帳款（老闆選單和店家選單都能查）
  const info = await bossInfo({ said, pb, action });
  if (info) return info;
  const m = (await modeRef(uid).get()).data() || {};
  // 老闆選單時傳照片＝上游的進貨單：讀單、核對上游有沒有算錯（店家選單時傳照片照樣是測試叫貨）
  if (e?.type === 'message' && e.message.type === 'image' && (m.mode || 'boss') === 'boss') {
    await loading(uid, 60);
    await queue({ type: 'purchase', messageId: e.message.id, userId: uid, replyToken: e.replyToken, origin }, e.webhookEventId);
    return false;
  }
  // 按「記帳」選了分類：10 分鐘內打的「品名 金額」記到這一類
  let pick = m.pick && Date.now() - m.pick.at < 10 * 60e3 ? m.pick.cat : '';
  // 選了分類後改按店家選單（我要叫貨、回報問題…）或打叫貨的話：不是要記帳，取消剛剛選的分類
  if (pick && (STORE_MENU.test(said) || /叫貨|叫菜|訂貨|下單/.test(said) || ['order', 'mine', 'photo'].includes(action))) {
    pick = '';
    await modeRef(uid).set({ pick: null }, { merge: true });
  }
  return expenseChat({ said, pb, action, store: (m.mode || 'boss') === 'store' ? store : null, uid, pick });
}

async function expenseChat({ said, pb, action, store, uid, pick }) {
  if (action === 'expick') {
    const cat = pb.get('cat') || '';
    await modeRef(uid).set({ pick: { cat, at: Date.now() } }, { merge: true });
    const eg = (await ex.getCats()).find((c) => c.name === cat)?.words?.[0];
    return { type: 'text', text: `記「${cat}」：請打品名和金額，例如\n${eg ? `${eg} 1500` : `${cat} 500`}\n只打金額也可以。` };
  }
  // 取消剛登記的付款
  if (action === 'paydel') {
    await removeSupplierPay(pb.get('id')).catch(() => {});
    return { type: 'text', text: '已取消這筆付款' };
  }
  // 一次記好幾筆的「全部取消」（記帳和付款都有）
  if (action === 'expdelm') {
    const ids = String(pb.get('ids') || '').split(',').filter(Boolean).slice(0, 20);
    const done = await Promise.all(ids.map((id) => (id.startsWith('p:') ? removeSupplierPay(id.slice(2)) : ex.removeExpense(id)).then(() => 1, () => 0)));
    return { type: 'text', text: `已取消 ${done.reduce((a, b) => a + b, 0)} 筆` };
  }
  if (action === 'expdel') {
    try {
      const e = await ex.removeExpense(pb.get('id'));
      return { type: 'text', text: `已取消：${mdOf(e.date)} ${e.item} ${money(e.amount)}` };
    } catch (err) { if (err.status) return { type: 'text', text: err.message }; throw err; }
  }
  if (action === 'expcat') {
    try {
      const e = await ex.updateExpense(pb.get('id'), { cat: pb.get('cat') });
      await ex.learnWord(e.item, e.cat);
      return savedReply(e, await ex.getCats(), `已改成「${e.cat}」，下次打「${e.item}」會自動分到這裡`);
    } catch (err) { if (err.status) return { type: 'text', text: err.message }; throw err; }
  }
  if (!said) return null;
  if (/^(記帳說明|怎麼記帳)$/.test(said)) return { type: 'text', text: HOWTO };
  if (/^(還要買|還要買什麼|採買|採買清單|還缺什麼|要買什麼)$/.test(said)) return buyText();
  // 應付帳款：「應付帳款」「要付多少」列每家；「聯興要付多少」「上個月 聯興 要付多少」看一家
  const ap = said.match(/^(上個月|這個月|本月)?\s*(.*?)\s*(這個月|本月|上個月)?\s*(要付多少錢?|還要付多少錢?|應付多少|欠多少|應付帳款)$/);
  if (ap) return payText(ap[1] || ap[3] || '', ap[2]);
  // 手動登記進貨單（要付的帳，不是已經付的錢）：「進貨單 聯興 12350」
  const mp = said.match(/^進貨單\s*(\S+?)\s*[$＄]?\s*([\d,]+)\s*元?$/);
  if (mp) {
    try {
      const p = await manualPurchase({ supplier: mp[1], total: mp[2].replace(/,/g, '') }, '老闆 LINE');
      return { type: 'text', text: `🧾 已登記進貨單：${p.supplier} ${money(p.total)}（${mdOf(p.date)}）\n這是要付的帳；付錢的時候打「${p.supplier} ${p.total}」記付款。\n打「${p.supplier}要付多少」可以看這個月的帳。` };
    } catch (err) { if (err.status) return { type: 'text', text: err.message }; throw err; }
  }
  // 圖文選單「記帳」：先選分類
  if (said === '記帳') {
    const cats = await frequentCats();
    return {
      type: 'text',
      text: '要記哪一類？點下面的分類，再打「品名 金額」。\n也可以直接打，例如「高麗菜 1500」「油錢 500」，會自動分類。',
      quickReply: { items: byUse(cats).slice(0, 13).map((c) => ({ type: 'action', action: { type: 'postback', label: c.name.slice(0, 20), data: `action=expick&cat=${encodeURIComponent(c.name)}`, displayText: `記${c.name}` } })) },
    };
  }
  const q = said.match(/^(今天|今日|昨天|本月|這個月|上個月)(支出|花費|記帳|開銷)(明細)?$/);
  if (q) {
    const t = today();
    const month = q[1] === '上個月' ? addDays(t.slice(0, 7) + '-01', -1).slice(0, 7) : t.slice(0, 7);
    const day = q[1] === '昨天' ? addDays(t, -1) : /今/.test(q[1]) ? t : null;
    const list = (await ex.listExpenses(day ? day.slice(0, 7) : month)).filter((e) => !day || e.date === day);
    const title = day ? `${mdOf(day)} 支出` : `${+month.slice(5)} 月支出`;
    if (!list.length) return { type: 'text', text: `${title}：還沒有記帳。\n${HOWTO}` };
    const sum = ex.summarize(list);
    const detail = day ? list.map((e) => `・${e.item} ${money(e.amount)}${e.payee ? `（${e.payee}）` : ''}`) : sum.by.map(([c, v]) => `・${c} ${money(v)}`);
    return { type: 'text', text: `${title} ${list.length} 筆，共 ${money(sum.total)}\n${detail.slice(0, 30).join('\n')}${detail.length > 30 ? '\n…' : ''}\n\n明細在後台「報表」頁` };
  }
  // 切到店家選單（測試叫貨）時：要「記帳」開頭才算記帳；老闆選單：打「品名 金額」就記
  const prefixed = /^(記帳|支出)\s*[:：]?\s*\S/.test(said);
  if (store && !prefixed && !pick) return null;
  // 「已付 七美 12000」：付給廠商（登記付款，跟後台「記付款」一樣），不是進貨
  if (!pick && !store) {
    const rows0 = said.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    if (rows0.length === 1) {
      const pay = await payLine(said);
      if (pay) {
        const x = await paySupplier(pay, (await displayName(uid)) || '老闆 LINE');
        const r = (await supplierLedger(x.month)).find((y) => y.supplier === x.supplier);
        return {
          type: 'text',
          text: `💰 已付 ${x.supplier} ${money(x.amount)}（${mdOf(x.date)}）${x.note ? `\n備註：${x.note}` : ''}${r ? `\n${+x.month.slice(5)} 月${r.left > 0 ? `還要付 ${money(r.left)}` : r.left < 0 ? `多付了 ${money(-r.left)}` : '付清了'}（進貨 ${money(r.total)}，已付 ${money(r.paid)}）` : ''}`,
          quickReply: { items: [{ type: 'action', action: { type: 'postback', label: '↩ 取消這筆', data: `action=paydel&id=${x.id}`, displayText: '取消這筆付款' } }] },
        };
      }
    }
  }
  // 一次好幾行，每行一筆：「進貨 七美 12000↵已付 聯興 5000↵油錢 500」
  const rows = said.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (rows.length > 1 && !pick) {
    const parsed = await Promise.all(rows.map(async (x) => [x, await payLine(x), ex.parseExpenseText(x.replace(/^(記帳|支出)\s*[:：]?\s*/, ''))]));
    if (parsed.filter(([, a, p]) => a || p).length >= 2 || (prefixed && parsed.some(([, a, p]) => a || p))) {
      const by = (await displayName(uid)) || '老闆 LINE';
      const saved = [];
      for (const [, a, p] of parsed.filter(([, a, p]) => a || p).slice(0, 20)) {
        if (a) { const x = await paySupplier(a, by); saved.push({ id: 'p:' + x.id, text: `💰 已付 ${x.supplier} ${money(x.amount)}`, amount: x.amount }); }
        else { const e = await ex.addExpense(p, { by, source: 'line' }); saved.push({ id: e.id, text: `・${e.payee ? `進貨 ${e.payee}` : e.cat} ${e.item !== '進貨' && e.item !== e.cat ? e.item + ' ' : ''}${money(e.amount)}`, amount: e.amount }); }
      }
      const bad = parsed.filter(([, a, p]) => !a && !p).map(([x]) => x);
      return {
        type: 'text',
        text: [`✅ 記了 ${saved.length} 筆`, ...saved.map((x) => x.text), ...(bad.length ? ['', `看不懂、沒記：${bad.join('、')}`] : [])].join('\n'),
        quickReply: { items: [{ type: 'action', action: { type: 'postback', label: '↩ 全部取消', data: `action=expdelm&ids=${saved.map((x) => x.id).join(',')}`, displayText: '全部取消' } }] },
      };
    }
  }
  // 選了分類後只打金額（「1500」）：品名就用分類名稱
  const p = ex.parseExpenseText(said) || (pick && /^[$＄]?\s*\d[\d,]*\s*(元|塊)?$/.test(said) ? ex.parseExpenseText(`${pick} ${said}`) : null);
  if (!p) return prefixed || pick ? { type: 'text', text: `看不懂金額。${HOWTO}` } : null;
  if (pick) { p.cat = pick; await modeRef(uid).set({ pick: null }, { merge: true }); }
  const e = await ex.addExpense(p, { by: (await displayName(uid)) || '老闆 LINE', source: 'line' });
  const r = savedReply(e, await ex.getCats());
  // 有數量的進貨（高麗菜20斤）：順便回這樣還要買多少
  if (e.buy) {
    const it = (await shop.buyList(e.buy.date)).find((x) => x.pid === e.buy.pid);
    const c = e.costSync;
    r.text += `\n💲 進價 $${e.buy.cost}/${e.buy.unit}（${qtyText(e.buy.qty, e.buy.unit)} $${e.amount.toLocaleString('en-US')}）`;
    if (c) r.text += c.times > 1 ? `\n　${label(e.buy.date)} 買了 ${c.times} 次，平均 $${c.avg}/${e.buy.unit}，已填進單價頁的進價` : `\n　已填進 ${label(e.buy.date)} 單價頁的進價`;
    r.text += it ? `\n\n🛒 ${label(e.buy.date)} ${it.name}：要 ${qtyText(it.need, it.unit)}，已買 ${qtyText(it.bought, it.unit)}${it.left ? `，還要 ${qtyText(it.left, it.unit)}` : '，✅ 買齊了'}` : `\n\n🛒 ${label(e.buy.date)} 沒有店家叫${e.buy.name}，已記成多買 ${qtyText(e.buy.qty, e.buy.unit)}`;
  }
  return r;
}

// 應付帳款：這個月（或上個月）每家廠商進了多少、付了多少、還要付多少
async function payText(when, name) {
  const month = (when === '上個月' ? addDays(today().slice(0, 7) + '-01', -1) : today()).slice(0, 7);
  const L = await supplierLedger(month), mm = +month.slice(5, 7);
  const who = String(name || '').replace(/^(付|給)/, '').trim();
  if (who) {
    const r = L.find((x) => x.supplier.includes(who) || who.includes(x.supplier));
    if (!r) return { type: 'text', text: `${mm} 月沒有「${who}」的進貨單或付款紀錄。拍上游的出貨單傳過來，或打「進貨單 ${who} 金額」登記。` };
    return { type: 'text', text: [`🏭 ${r.supplier} ${mm} 月`, `進貨 ${r.invoices.length} 筆 ${money(r.total)}`, `已付 ${money(r.paid)}`, r.left > 0 ? `👉 還要付 ${money(r.left)}` : r.left < 0 ? `多付了 ${money(-r.left)}` : '✅ 付清了',
      ...(r.over ? [`（其中上游多算 ${money(r.over)}，付錢前先確認）`] : []),
      ...(r.items.length ? ['', '買了什麼：', ...r.items.slice(0, 15).map((x) => `・${x.name} ${+x.qty.toFixed(2)}${x.unit} ${money(x.amount)}`), ...(r.items.length > 15 ? [`…還有 ${r.items.length - 15} 樣，到後台「進貨單 → 廠商總帳」看`] : [])] : []),
      '', '進貨：', ...r.invoices.slice(-10).map((x) => `・${mdOf(x.date)} ${money(x.total)}${x.lines.length ? `（${x.lines.length} 項）` : ''}`),
      ...(r.payments.length ? ['', '付款：', ...r.payments.slice(-10).map((x) => `・${mdOf(x.date)} ${money(x.amount)}`)] : [])].join('\n') };
  }
  const owe = L.filter((r) => r.left > 0);
  if (!L.length) return { type: 'text', text: `${mm} 月還沒有進貨單。拍上游的出貨單傳過來，或打「進貨單 廠商 金額」登記。` };
  // 每家分開列，不加總
  return { type: 'text', text: [`🏭 ${mm} 月各廠商還要付`, '', ...(owe.length ? owe.map((r) => `・${r.supplier}：${money(r.left)}（進貨 ${money(r.total)}，已付 ${money(r.paid)}）`) : ['✅ 都付清了']), '', '打「聯興要付多少」看一家的明細。'].join('\n') };
}

// 「已付 七美 12000」「付款 聯興 5000 匯款」：認得的廠商才算付款；「付房租 20000」這種照樣是記帳
const PAY_RE = /^(已付|付款|付給)\s*/;
async function payLine(text) {
  if (!PAY_RE.test(text)) return null;
  const p = ex.parseExpenseText(text.replace(PAY_RE, ''));
  if (!p) return null;
  const hit = ex.findSupplier(`${p.item}${p.payee}${p.note}`, ex.supplierKeys((await ex.getCats()).filter((c) => c.supplier).map((c) => c.name)));
  return hit ? { supplier: hit[1], amount: p.amount, date: p.date, note: p.note.replace(hit[0], '').trim() } : null;
}

// 記帳按鈕：這兩個月記最多次的分類（廠商）排前面，再來是其他支出分類
async function frequentCats() {
  const t = today(), [cats, a, b] = await Promise.all([ex.getCats(), ex.listExpenses(t.slice(0, 7)), ex.listExpenses(addDays(t.slice(0, 7) + '-01', -1).slice(0, 7))]);
  const n = {};
  for (const e of [...a, ...b]) n[e.cat] = (n[e.cat] || 0) + 1;
  const used = cats.filter((c) => n[c.name] && !c.hidden).sort((x, y) => n[y.name] - n[x.name]);
  return [...used, ...byUse(cats).filter((c) => !used.includes(c))];
}

// 「還要買」：現在採買的配送日，還沒買齊的品項
async function buyText() {
  const D = buyDate();
  const list = await shop.buyList(D);
  if (!list.length) return { type: 'text', text: `${label(D)} 還沒有店家叫貨。` };
  const left = list.filter((x) => x.left > 0), done = list.length - left.length;
  if (!left.length) return { type: 'text', text: `✅ ${label(D)} 的 ${list.length} 樣都買齊了！` };
  const pk = Object.fromEntries((await shop.getProducts()).map((p) => [p.id, p.packs?.[0]]));
  const about = (x) => (pk[x.pid] ? `約 ${+(x.left / pk[x.pid].n).toFixed(1)} ${pk[x.pid].unit}` : '');
  // 品項有記廠商（匯入 ERP 產品時帶進來）就依廠商分組，照廠商去叫貨
  const bySup = left.some((x) => x.supplier);
  // 廠商照 ERP 廠商代碼排（F01、F02…），沒有代碼的照名稱，沒有廠商的放最後
  const supKey = (x) => (x.supplier ? (x.supplierCode || '~') + x.supplier : '\uffff');
  if (bySup) left.sort((a, b) => supKey(a).localeCompare(supKey(b), 'zh-Hant'));
  let last = null;
  const head = (x) => { if (!bySup || x.supplier === last) return ''; last = x.supplier; return `【${x.supplier || '其他'}】\n`; };
  const lines = left.map((x) => `${head(x)}・${x.name} ${qtyText(x.left, x.unit)}${about(x) ? `（${about(x)}）` : ''}${x.bought ? `\n　要 ${qtyText(x.need, x.unit)}，已買 ${qtyText(x.bought, x.unit)}` : ''}`);
  return {
    type: 'text',
    text: `🛒 ${label(D)} 還要買 ${left.length} 樣${done ? `（已買齊 ${done} 樣）` : ''}：\n${lines.slice(0, 40).join('\n')}${lines.length > 40 ? '\n…' : ''}\n\n買了就記帳，例如「${left[0].name}${qtyText(left[0].left, left[0].unit).replace(' ', '')} 金額」，會自動扣掉。`,
    quickReply: { items: [{ type: 'action', action: { type: 'message', label: '🔄 再看一次', text: '還要買' } }] },
  };
}
