// 後台 API：用 Firebase 登入，依角色決定能做什麼（見 lib/auth.js）
import { SHOP } from '../lib/config.js';
import { saveRules, savePalette, savePrints } from '../lib/rules.js';
import { json, fail, readJSON, UserError } from '../lib/http.js';
import { push, linkMenu } from '../lib/line.js';
import { openDate, today, thisMonth, isDate, isMonth, cutoffLabel, getRulesNow } from '../lib/dates.js';
import * as shop from '../lib/shop.js';
import * as ex from '../lib/expense.js';
import { signedIn, need, can, ROLES, listUsers, addUser, addLineUser, updateUser, removeUser } from '../lib/auth.js';
import { lineLogin, lineRequests, dropRequest, pairStart, pairCheck } from '../lib/linelogin.js';
import { remindText, statementMessage, approvedText, dunningText, receiptMessage, slipMessage } from '../lib/messages.js';
import { getFirestore } from 'firebase-admin/firestore';
import { signSlipToken, sign } from '../lib/token.js';
import { originOf } from '../lib/http.js';
import * as report from '../lib/report.js';
import { resetTestData } from '../lib/reset.js';
import { applyDraft } from '../lib/aiorder.js';
import { saveImage } from './img.js';
import { listBoss, newBossCode, unbindBoss } from '../lib/boss.js';
import * as purchase from '../lib/purchase.js';

async function statement(month, storeId) {
  const [all, paid] = await Promise.all([shop.monthAmounts(month), shop.getPaid(month)]);
  const rows = all.filter((r) => r.storeId === storeId).sort((a, b) => a.date.localeCompare(b.date));
  const total = rows.reduce((a, r) => a + r.amount, 0);
  return { rows, total, got: shop.paidSum(paid[storeId], total) };
}

// 店家在 LINE 回報的問題：還沒處理的全部列出來
async function openIssues() {
  const snap = await getFirestore().collection('issues').where('status', '==', 'open').get();
  return snap.docs.map((d) => d.data()).sort((a, b) => b.at.localeCompare(a.at));
}

// 這天各店的簽收紀錄（不含圖片）
async function signaturesOf(date) {
  const snap = await getFirestore().collection('signatures').where('date', '==', date).get();
  return Object.fromEntries(snap.docs.map((d) => { const { png, ...rest } = d.data(); return [rest.key || rest.storeId, { ...rest, hasPng: !!png }]; }));
}

// LINE 登入憑證放進 cookie（30 天）；登出時清掉
function withSession(res, session, maxAge) {
  res.headers.append('Set-Cookie', `__session=${encodeURIComponent(session)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  return res;
}

async function pushToStore(store, messages) {
  if (!store.members.length) throw new UserError(`「${store.name}」還沒綁定 LINE 帳號`);
  const results = await Promise.allSettled(store.members.map((m) => push(m.userId, messages)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  results.filter((r) => r.status === 'rejected').forEach((r) => console.error(r.reason));
  if (!ok) throw new UserError('LINE 訊息沒送出，可能是本月訊息額度用完了');
  return ok;
}

// 理貨、司機看不到單價：單價（price）、基本價（base）、進價（cost）、建議售價（listPrice）都拿掉
const noPriceItem = ({ price, base, ...i }) => i;
const noPriceProduct = ({ price, cost, listPrice, ...p }) => p;

export async function GET(request) {
  try {
    // 登入畫面用：LINE 登入要的 LIFF ID（不用登入）
    if (new URL(request.url).searchParams.get('lineConfig')) return json({ liffId: SHOP.liffId || '', basicId: SHOP.basicId || '' });
    const me = await signedIn(request);
    need(me, 'view');
    const q = new URL(request.url).searchParams;
    // 簽名圖另外載（列印、查看時才需要）
    if (q.get('sig')) {
      need(me, 'view');
      const s = (await getFirestore().doc('signatures/' + q.get('sig').replace(/[^\w-]/g, '')).get()).data();
      return json({ signature: s || null });
    }
    // AI 叫貨紀錄（最近 30 筆）
    // 對照改單：這筆 AI 紀錄那天、那家店目前的訂單
    if (q.get('aiorder')) {
      need(me, 'editOrders');
      const d = (await getFirestore().doc('aiDrafts/' + q.get('aiorder').replace(/[^\w-]/g, '')).get()).data();
      if (!d) throw new UserError('找不到這筆紀錄', 404);
      const [order, sig] = await Promise.all([shop.getOrder(d.date, d.storeId), getFirestore().doc(`signatures/${d.date}_${d.storeId}`).get()]);
      return json({ draft: d, order: order?.items.length ? { items: order.items.map(({ pid, name, unit, qty }) => ({ pid, name, unit, qty })) } : null, signed: sig.exists });
    }
    if (q.get('ai')) {
      need(me, 'editOrders');
      const snap = await getFirestore().collection('aiDrafts').orderBy('createdAt', 'desc').limit(30).get();
      return json({ drafts: snap.docs.map((d) => d.data()) });
    }
    // 列印整月的單子（明細對帳單、客戶產品銷售統計表）才載：這個月每張單的品項
    if (q.get('orders')) {
      need(me, 'bills');
      const m = isMonth(q.get('orders')) ? q.get('orders') : thisMonth();
      return json({ month: m, orders: await shop.ordersOfMonth(m) });
    }
    // 進貨單分頁：這個月的進貨單（照片點開才載）
    if (q.get('purchases')) {
      need(me, 'prices');
      const m = isMonth(q.get('purchases')) ? q.get('purchases') : thisMonth();
      return json({ month: m, purchases: await purchase.listPurchases(m) });
    }
    if (q.get('ledger')) {
      need(me, 'prices');
      const m = isMonth(q.get('ledger')) ? q.get('ledger') : thisMonth();
      return json({ month: m, ledger: await purchase.supplierLedger(m) });
    }
    if (q.get('purchaseImg')) {
      need(me, 'prices');
      return json({ thumb: await purchase.purchaseThumb(q.get('purchaseImg')) });
    }
    // 報表分頁另外載（要讀整個月的訂單）
    if (q.get('report')) {
      need(me, 'bills');
      const m = isMonth(q.get('report')) ? q.get('report') : thisMonth();
      const [r, ar] = await Promise.all([report.monthReport(m), report.receivables()]);
      return json({ ...r, receivables: ar });
    }
    const date = isDate(q.get('date')) ? q.get('date') : openDate();
    const month = isMonth(q.get('month')) ? q.get('month') : thisMonth();
    const bills = can(me.role, 'bills');
    const [stores, products, pending, monthRows, paid, dayOrders, dayPrices, units, users, priceGroups, storeAliases] = await Promise.all([
      shop.getStores(), shop.getProducts(),
      can(me.role, 'stores') ? shop.listPending() : [],
      bills ? shop.monthAmounts(month) : [],
      bills ? shop.getPaid(month) : {},
      shop.ordersOfDate(date, { withEmpty: true }),
      shop.getDayPrices(date),
      shop.getUnits(),
      can(me.role, 'users') ? listUsers() : [],
      can(me.role, 'prices') ? shop.getPriceGroups() : [],
      can(me.role, 'products') ? shop.allStoreAliases() : {},
    ]);
    const showPrices = can(me.role, 'prices') || bills;
    return json({
      me: { ...me, roleName: ROLES[me.role], can: ['bills', 'prices', 'editOrders', 'products', 'stores', 'remind', 'statement', 'users', 'sign', 'deleteOrders'].filter((w) => can(me.role, w)) },
      // 工程師這個角色只有工程師自己看得到
      roles: me.role === 'engineer' ? ROLES : Object.fromEntries(Object.entries(ROLES).filter(([k]) => k !== 'engineer')),
      shop: { name: SHOP.name, phone: SHOP.phone, payTerms: SHOP.payTerms, basicId: SHOP.basicId, logo: SHOP.logo },
      categories: await shop.getCategories(),
      units,
      cutoffLabel: cutoffLabel(openDate()),
      rules: getRulesNow(),
      today: today(),
      openDate: openDate(),
      date,
      month,
      stores,
      // 理貨、司機看不到單價
      products: can(me.role, 'prices') ? products : products.map(noPriceProduct),
      pending,
      orders: (showPrices ? dayOrders : dayOrders.map((o) => ({ ...o, items: o.items.map(noPriceItem) }))).filter((o) => o.items.length),
      // 被取消／刪除的單只留紀錄
      emptyLogs: dayOrders.filter((o) => !o.items.length).map((o) => ({ storeId: o.storeId, seq: o.seq || 1, log: o.log || [] })),
      signatures: await signaturesOf(date),
      // 出貨單印過的紀錄：{ 單號key: { q, p, at, by } }，畫面比對現在的內容，看是不是印過後又改了
      printed: (await getFirestore().doc('printed/' + date).get()).data()?.slips || {},
      bossLine: can(me.role, 'users') ? await listBoss() : null,
      lineReqs: can(me.role, 'users') ? await lineRequests() : [],
      dayPrices: showPrices ? dayPrices : {},
      dayCosts: can(me.role, 'prices') ? await shop.getDayCosts(date) : {},
      bought: await shop.getBought(date),
      issues: await openIssues(),
      monthRows,
      paid,
      users,
      priceGroups,
      storeAliases,
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request) {
  try {
    const b = await readJSON(request);
    // 用 LINE 登入（還沒登入，不用驗證）
    if (b.action === 'lineLogin') return json(await lineLogin(String(b.accessToken || '')));
    if (b.action === 'pairStart') return json(await pairStart());
    if (b.action === 'pairCheck') {
      const r = await pairCheck(b.id);
      return r.session ? withSession(json(r), r.session, 30 * 86400) : json(r);
    }
    if (b.action === 'logout') return withSession(json({ ok: true }), '', 0);
    const me = await signedIn(request);
    const store = async () => {
      const s = (await shop.getStores()).find((x) => x.id === b.storeId);
      if (!s) throw new UserError('找不到這家店', 404);
      return s;
    };

    switch (b.action) {
      case 'setQty': {
        need(me, 'editOrders');
        await store();
        const r = await shop.setQty(b.storeId, b.date, b.pid, b.qty, me.name, b.seq);
        if (!can(me.role, 'prices')) r.order.items = r.order.items.map(noPriceItem);
        return json(r);
      }
      case 'setShip': {
        need(me, 'editOrders');
        await store();
        const r = await shop.setShip(b.storeId, b.date, b.pid, b.ship, me.name, b.seq);
        if (!can(me.role, 'prices')) r.order.items = r.order.items.map(noPriceItem);
        return json(r);
      }
      case 'resetTestData': {
        if (!me.engineer) throw new UserError('沒有這個權限', 403);
        if (b.confirm !== '重置') throw new UserError('請輸入「重置」確認');
        return json({ deleted: await resetTestData() });
      }
      case 'deleteSlip': {
        need(me, 'deleteOrders');
        await store();
        return json(await shop.deleteSlip(b.storeId, b.date, me.name, b.seq));
      }
      case 'newSlip': {
        need(me, 'editOrders');
        await store();
        const r = await shop.newSlip(b.storeId, b.date, b.pid, b.qty, me.name);
        if (!can(me.role, 'prices')) r.order.items = r.order.items.map(noPriceItem);
        return json(r);
      }
      case 'dayPrices':
        need(me, 'prices');
        return json({ dayPrices: await shop.setDayPrices(b.date, b.prices, b.costs) });
      case 'renameCategory':
        need(me, 'products');
        return json(await shop.renameCategory(String(b.from || ''), b.to));
      case 'categories':
        need(me, 'products');
        return json({ categories: await shop.saveCategories(b.categories) });
      case 'units':
        need(me, 'products');
        return json({ units: await shop.saveUnits(b.units) });
      case 'products':
        need(me, 'products');
        return json({ products: await shop.saveProducts(b.products) });
      case 'importErp':
        need(me, 'products');
        return json(await shop.importErp(b.rows, { dry: b.dry !== false, removeOthers: !!b.removeOthers }));
      case 'priceGroups':
        need(me, 'stores');
        return json({ priceGroups: await shop.savePriceGroups(b.priceGroups) });
      // 上游進貨單：後台上傳照片（瀏覽器先縮小）→ 讀單、核對
      case 'purchaseUpload': {
        need(me, 'prices');
        const image = String(b.image || ''), thumb = String(b.thumb || '');
        if (!/^data:image\/jpeg;base64,/.test(image) || image.length > 2.5e6 || thumb.length > 1.2e6) throw new UserError('照片格式不對或太大');
        const inv = await purchase.readInvoice(image);
        if (!inv.lines.length) throw new UserError('這張看不出是進貨單（沒讀到品項），請拍清楚一點');
        const p = await purchase.savePurchase({ inv, thumb: /^data:image\/jpeg;base64,/.test(thumb) ? thumb : '', by: me.name, source: 'admin' });
        const { thumb: _t, ...rest } = p;
        return json({ purchase: { ...rest, hasThumb: !!_t } });
      }
      case 'purchaseUpdate':
        need(me, 'prices');
        return json({ purchase: await purchase.updatePurchase(b.id, b) });
      case 'purchaseExpense':
        need(me, 'prices');
        return json(await purchase.setPurchaseExpense(b.id, !!b.on));
      case 'supplierPay':
        need(me, 'prices');
        await purchase.paySupplier(b, me.name);
        return json({ ok: true });
      case 'supplierPayDel':
        need(me, 'prices');
        await purchase.removeSupplierPay(b.id);
        return json({ ok: true });
      case 'supplierMode':
        need(me, 'prices');
        await purchase.setSupplierMode(b.supplier, b.pay);
        return json({ ok: true });
      // 電腦打的進貨單：一行一行（品名、數量、單位、單價、金額），合計自動算
      case 'purchaseTyped': {
        need(me, 'prices');
        const lines = (Array.isArray(b.lines) ? b.lines : []).filter((l) => String(l?.name || '').trim() && (Number(l.amount) > 0 || (Number(l.qty) > 0 && Number(l.price) >= 0)));
        if (!String(b.supplier || '').trim()) throw new UserError('請填廠商');
        if (!lines.length) throw new UserError('至少要打一行品項');
        const p = await purchase.savePurchase({ inv: { supplier: b.supplier, date: b.date, note: b.note, lines: lines.map((l) => ({ name: l.name, qty: l.qty === '' ? null : Number(l.qty), unit: l.unit, price: l.price === '' ? null : Number(l.price), amount: l.amount === '' || l.amount == null ? null : Number(l.amount) })), total: null }, by: me.name, source: 'typed' });
        const { thumb: _t, ...rest } = p;
        return json({ purchase: { ...rest, hasThumb: false } });
      }
      case 'purchaseManual':
        need(me, 'prices');
        return json({ purchase: await purchase.manualPurchase(b, me.name) });
      case 'purchaseRemove':
        need(me, 'prices');
        await purchase.removePurchase(b.id);
        return json({ ok: true });
      case 'importSales':
        need(me, 'stores');
        return json(await shop.importSales(b.rows, { dry: b.dry !== false }));
      case 'chainGroups':
        need(me, 'stores');
        return json(await shop.chainGroups());
      case 'importErpStores':
        need(me, 'stores');
        return json(await shop.importErpStores(b.rows, { dry: b.dry !== false }));
      case 'stores':
        need(me, 'stores');
        return json({ stores: await shop.saveStores(b.stores) });
      case 'invite':
        need(me, 'stores');
        await store();
        return json({ invite: await shop.storeInvite(b.storeId, !!b.renew) });
      case 'approve': {
        need(me, 'stores');
        const s = await shop.approve(b.userId, { storeId: b.storeId, newStore: b.newStore });
        await push(b.userId, [approvedText(s)]).catch((err) => console.error(err));
        return json({ store: s });
      }
      case 'reject':
        need(me, 'stores');
        await shop.reject(b.userId);
        return json({ ok: true });
      case 'unbind':
        need(me, 'stores');
        await shop.unbind(b.userId);
        return json({ ok: true });
      case 'remind': {
        need(me, 'remind');
        const date = openDate();
        const stores = (await shop.getStores()).filter((s) => b.storeIds?.includes(s.id) && s.members.length);
        const res = await Promise.allSettled(stores.map((s) => pushToStore(s, [remindText(date)])));
        return json({ sent: res.filter((r) => r.status === 'fulfilled').length, total: stores.length });
      }
      case 'statement': {
        need(me, 'statement');
        if (!isMonth(b.month)) throw new UserError('月份不正確');
        const s = await store();
        const { rows, total, got } = await statement(b.month, s.id);
        if (!rows.length) throw new UserError('這個月沒有送貨紀錄');
        // 附上後台畫好的對帳單圖片（跟列印的一樣），再加對帳單卡片
        const pics = Array.isArray(b.images) ? await Promise.all(b.images.slice(0, 1).map(async (d) => { const url = await saveImage(d, originOf(request)); return { type: 'image', originalContentUrl: url, previewImageUrl: url }; })) : [];
        await pushToStore(s, [...pics, statementMessage(s, b.month, rows, total, got)]);
        return json({ ok: true });
      }
      case 'paid': {
        need(me, 'bills');
        if (!isMonth(b.month)) throw new UserError('月份不正確');
        await store();
        await shop.setPaid(b.month, b.storeId, !!b.paid);
        return json({ paid: await shop.getPaid(b.month) });
      }
      case 'storePay':
        need(me, 'bills');
        return json({ stores: await shop.setStorePay(b.storeId, b.pay) });
      case 'payment':
        need(me, 'bills');
        if (!isMonth(b.month)) throw new UserError('月份不正確');
        await store();
        return json({ paid: await shop.addPayment(b.month, b.storeId, b, me.name || me.email) });
      case 'removePayment':
        need(me, 'bills');
        if (!isMonth(b.month)) throw new UserError('月份不正確');
        return json({ paid: await shop.removePayment(b.month, b.storeId, String(b.id || '')) });
      // 印了出貨單：記下印的時候的數量（q）和單價（p）簽章，之後有改就提醒重印
      case 'printed': {
        need(me, 'view');
        if (!isDate(b.date) || !b.slips || typeof b.slips !== 'object') throw new UserError('格式錯誤');
        const at = new Date().toISOString(), by = me.name || me.email;
        const slips = Object.fromEntries(Object.entries(b.slips).slice(0, 500).map(([k, v]) => [String(k).slice(0, 40), { q: String(v?.q ?? '').slice(0, 4000), p: v?.p == null ? null : String(v.p).slice(0, 4000), at, by }]));
        await getFirestore().doc('printed/' + b.date).set({ slips }, { merge: true });
        return json({ printed: (await getFirestore().doc('printed/' + b.date).get()).data()?.slips || {} });
      }
      case 'receipt': {
        need(me, 'statement');
        if (!isDate(b.date)) throw new UserError('日期不正確');
        const stores = (await shop.getStores()).filter((s) => b.storeIds?.includes(s.id) && s.members.length);
        const orders = await shop.ordersOfDate(b.date);
        // 當天單價沒填完不能傳收據（不然收據用的是上次的價格，之後填了正式價格就對不上）
        const dp = await shop.getDayPrices(b.date);
        const missing = [...new Set(orders.filter((o) => stores.some((s) => s.id === o.storeId)).flatMap((o) => o.items).filter((i) => !(i.pid in dp)).map((i) => i.name))];
        // 後台確認過「先傳出貨單」（noPrice）才改傳不含金額的出貨單，單價填好後再傳收據
        const slipOnly = missing.length > 0 && !!b.noPrice;
        if (missing.length && !slipOnly) throw new UserError(`${b.date.slice(5).replace('-', '/')} 還有 ${missing.length} 個品項沒填單價（${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}），先到「單價」頁填完再傳收據`);
        // 一家店有補單的話，每張各一則收據（LINE 一次最多 5 則）
        const res = await Promise.allSettled(stores.map((s) => {
          const mine = orders.filter((x) => x.storeId === s.id).sort((a, c) => (a.seq || 1) - (c.seq || 1)).slice(0, 5);
          if (!mine.length) return Promise.reject(new Error('沒有訂單'));
          if (slipOnly) return pushToStore(s, mine.map((o) => slipMessage(s, b.date, o, shop.billQty)));
          return shop.monthSoFar(s.id, b.date).then((soFar) => pushToStore(s, mine.map((o) => receiptMessage(s, b.date, o, shop.billQty, soFar))));
        }));
        const at = new Date().toISOString();
        await Promise.all(orders.filter((o) => stores.some((s, i) => s.id === o.storeId && res[i].status === 'fulfilled'))
          .map((o) => getFirestore().doc(`orders/${b.date}_${shop.slipKey(o.storeId, o.seq || 1)}`).update(slipOnly ? { slipSentAt: at } : { receiptSentAt: at })));
        return json({ sent: res.filter((r) => r.status === 'fulfilled').length, total: stores.length, slipOnly });
      }
      case 'signLink': {
        need(me, 'sign');
        if (!isDate(b.date)) throw new UserError('日期不正確');
        const s = await store();
        const seq = Math.max(1, Math.floor(Number(b.seq)) || 1);
        if (!(await shop.getOrder(b.date, s.id, seq))?.items.length) throw new UserError('這張出貨單沒有品項');
        return json({ url: `${originOf(request)}/sign?t=${signSlipToken(b.date, shop.slipKey(s.id, seq))}` });
      }
      case 'sign': {
        need(me, 'sign');
        if (!isDate(b.date)) throw new UserError('日期不正確');
        const s = await store();
        // 後台「直接確認」不用簽名圖
        const png = String(b.png || '');
        if (png && (!/^data:image\/png;base64,/.test(png) || png.length > 300000)) throw new UserError('簽名圖片不正確');
        const seq = Math.max(1, Math.floor(Number(b.seq)) || 1);
        const key = shop.slipKey(s.id, seq);
        if ((await getFirestore().doc(`signatures/${b.date}_${key}`).get()).exists) throw new UserError('這張配送單已經確認過了', 409);
        if (!(await shop.getOrder(b.date, s.id, seq))?.items.length) throw new UserError('這張出貨單沒有品項');
        const signer = String(b.signer || '').trim().slice(0, 20);
        const rec = { date: b.date, storeId: s.id, seq, key, ...(png ? { png } : {}), signer, by: me.name, at: new Date().toISOString() };
        await getFirestore().doc(`signatures/${b.date}_${key}`).create(rec).catch((e) => { if (e.code === 6) throw new UserError('這張配送單剛剛已經確認過了', 409); throw e; }); // create：已經有人確認就失敗，不會互相蓋掉
        return json({ signature: { ...rec, png: undefined, hasPng: !!png } });
      }
      // 老闆的 LINE：產生綁定碼、解除（解除後選單換回店家選單）
      case 'bossCode':
        need(me, 'users');
        await newBossCode();
        return json({ bossLine: await listBoss() });
      case 'bossUnbind': {
        need(me, 'users');
        const uid = String(b.userId || '');
        await linkMenu(uid, 'store').catch((e) => console.error(e));
        return json({ bossLine: await unbindBoss(uid) });
      }
      case 'palette':
        need(me, 'users');
        return json({ palette: await savePalette(String(b.palette || '')) });
      case 'prints':
        need(me, 'users');
        return json({ prints: await savePrints(b.prints || {}) });
      case 'rules':
        need(me, 'users');
        return json({ rules: await saveRules(b.rules || {}), openDate: openDate(), cutoffLabel: cutoffLabel(openDate()) });
      // AI 紀錄「看不懂」→ 加成叫法（理貨也可以加，因為只影響 AI 辨識，不影響價格）
      case 'addAlias': {
        need(me, 'editOrders');
        if (b.storeId) await store();
        const r = await shop.addAlias({ text: b.text, pid: b.pid, storeId: b.storeId || '' });
        return json({ products: r.products, ...(b.storeId ? { storeId: b.storeId, storeAliases: r.storeAliases } : {}) });
      }
      case 'removeStoreAlias': {
        need(me, 'products'); // 叫法都在品項頁管理
        const s = await store();
        return json({ storeId: s.id, storeAliases: await shop.removeStoreAlias(s.id, String(b.text || '')) });
      }
      case 'aiApply': {
        need(me, 'editOrders');
        const r = await applyDraft(String(b.id || ''), b.items, me.name);
        return json({ order: { date: r.order.date, items: r.order.items.map(({ pid, name, unit, qty }) => ({ pid, name, unit, qty })) } });
      }
      case 'costTypes':
        need(me, 'bills');
        return json({ costTypes: await report.saveCostTypes(b.costTypes) });
      // 代客叫貨：電話叫貨時，後台直接打開這家店的叫貨單（跟店家在 LINE 看到的一樣）
      case 'proxyLink': {
        need(me, 'editOrders');
        const s = await store();
        const d = String(b.draftId || '').replace(/[^\w-]/g, '');
        return json({ url: `${originOf(request)}/?t=${sign('store:' + s.id)}&proxy=1${d ? `&d=${d}` : ''}` });
      }
      // 店家回報處理好了；有寫回覆就用 LINE 傳給回報的人（用 1 則推播額度）
      case 'issueDone': {
        need(me, 'editOrders');
        const ref = getFirestore().doc('issues/' + String(b.id || '').replace(/[^\w-]/g, '_'));
        const it = (await ref.get()).data();
        if (!it) throw new UserError('找不到這筆回報', 404);
        const reply = String(b.reply || '').trim().slice(0, 300);
        if (reply) await push(it.userId, [{ type: 'text', text: `關於您回報的 ${it.date.slice(5).replace('-', '/')} ${it.name}（${it.type}）：\n${reply}` }]);
        await ref.update({ status: 'done', doneBy: me.name || me.email, doneAt: new Date().toISOString(), reply });
        return json({ issues: await openIssues() });
      }
      case 'bought':
        need(me, 'view');
        return json({ bought: await shop.setBought(b.date, String(b.pid || ''), b.qty) });
      case 'expenseAdd':
        need(me, 'bills');
        await ex.addExpense(b, { by: me.name || me.email, source: 'admin' });
        return json(await report.monthReport(isMonth(b.month) ? b.month : String(b.date || '').slice(0, 7)));
      case 'expenseUpdate': {
        need(me, 'bills');
        const old = await ex.getExpense(b.id);
        const e = await ex.updateExpense(b.id, b);
        if (old && old.cat !== e.cat) await ex.learnWord(e.item, e.cat);
        return json(await report.monthReport(isMonth(b.month) ? b.month : e.month));
      }
      case 'expenseRemove':
        need(me, 'bills');
        await ex.removeExpense(b.id);
        return json(await report.monthReport(b.month));
      case 'expenseCats':
        need(me, 'bills');
        await ex.saveCats(b.cats);
        return json(await report.monthReport(b.month));
      case 'costs':
        need(me, 'bills');
        if (!isMonth(b.month)) throw new UserError('月份不正確');
        await report.saveCosts(b.month, b);
        return json(await report.monthReport(b.month));
      case 'dunning': {
        need(me, 'statement');
        const s = await store();
        const ar = (await report.receivables()).find((x) => x.storeId === s.id);
        if (!ar) throw new UserError(`「${s.name}」沒有未收款`);
        // 附上還沒收完那幾個月的對帳單（LINE 一次最多 5 則：最多 4 張＋1 則提醒）。
        // 後台有畫好對帳單圖片（images）就傳圖片，沒有就傳對帳單卡片
        const months = ar.months.slice(0, 4).reverse();
        const imgs = Array.isArray(b.images) ? b.images.slice(0, 4) : [];
        const stmts = imgs.length
          ? await Promise.all(imgs.map(async (d) => { const url = await saveImage(d, originOf(request)); return { type: 'image', originalContentUrl: url, previewImageUrl: url }; }))
          : await Promise.all(months.map(async (m) => { const st = await statement(m.month, s.id); return statementMessage(s, m.month, st.rows, st.total, st.got); }));
        await pushToStore(s, [...stmts, dunningText(s, ar)]);
        return json({ ok: true });
      }
      case 'addUser':
        need(me, 'users');
        return json({ users: await addUser(b) });
      case 'updateUser':
        need(me, 'users');
        if (b.email === me.email) throw new UserError('不能改自己的帳號');
        return json({ users: await updateUser(b) });
      // 用 LINE 申請登入的人：加成員工，或忽略
      case 'addLineUser':
        need(me, 'users');
        return json({ users: await addLineUser(b), lineReqs: await lineRequests() });
      case 'dropLineReq':
        need(me, 'users');
        await dropRequest(String(b.userId || ''));
        return json({ lineReqs: await lineRequests() });
      case 'removeUser':
        need(me, 'users');
        if (b.email === me.email) throw new UserError('不能刪除自己的帳號');
        return json({ users: await removeUser(b) });
    }
    throw new UserError('不支援的操作');
  } catch (e) {
    return fail(e);
  }
}
