// 店家圖文選單的「照上次叫」「我的帳款」「回報問題」（都用回覆，不算推播額度）
//   issues/{id}      { id, storeId, storeName, userId, date, seq, pid, name, type, note: [], photos: [], status: 'open' | 'done', at }
//   issueMode/{uid}  { id, at }：剛回報完 10 分鐘內傳的照片或文字，補到那筆回報
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { openDate, today, addDays, label } from '../lib/dates.js';
import { qtyText } from '../lib/qty.js';
import * as shop from '../lib/shop.js';
import * as report from '../lib/report.js';
import { orderMessage, statementMessage, money } from '../lib/messages.js';
import { notifyAdmins, getContent } from '../lib/line.js';
import { saveImage } from './img.js';

const db = () => getFirestore();
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const pbAct = (label, data, text) => ({ type: 'action', action: { type: 'postback', label: label.slice(0, 20), data, displayText: text || label } });
export const ISSUE_TYPES = ['爛掉／壞掉', '數量不對', '送錯品項', '品質不好', '其他'];

export async function storeChat({ e, said, pb, action, store, uid, url, origin }) {
  /* ---------- 照上次叫 ---------- */
  if (said === '照上次叫' || action === 'repeat') {
    const D = openDate();
    const last = await shop.lastOrder(store.id, D);
    const pm = Object.fromEntries((await shop.getProducts()).map((p) => [p.id, p]));
    if (!last) {
      // 還沒在這裡叫過貨：ERP 銷售紀錄只有總金額、沒有每次的數量，不能照著叫；列出常買的，叫貨單「常用」直接選
      const usual = (await shop.usualPids(store.id).catch(() => [])).filter((pid) => pm[pid]?.on).slice(0, 12);
      if (!usual.length) return { type: 'text', text: '還沒有之前的訂單可以照著叫，直接打字叫貨就好，例如「高麗菜10斤」。' };
      return {
        type: 'text',
        text: `還沒有在這裡叫過貨，所以沒有「上次」可以照著叫。\n您平常常買的：\n${usual.map((pid) => `・${pm[pid].name}`).join('\n')}\n\n點下面「打開叫貨單」，第一頁「常用」就是這些，選好數量送出就可以；也可以直接打字，例如「${pm[usual[0]].name} 10${pm[usual[0]].unit || ''}」。`,
        quickReply: { items: [{ type: 'action', action: { type: 'uri', label: '🛒 打開叫貨單', uri: url } }] },
      };
    }
    const items = last.items.filter((i) => pm[i.pid]?.on).map((i) => ({ pid: i.pid, qty: i.qty }));
    const off = last.items.filter((i) => !pm[i.pid]?.on).map((i) => i.name);
    if (action === 'repeat') {
      if (pb.get('from') !== last.date) return { type: 'text', text: '訂單有變動，請再按一次「照上次叫」。' };
      const { order } = await shop.saveOrder(store.id, D, items, '店家', '照上次叫');
      return orderMessage('訂單已收到', store, D, order, url);
    }
    const cur = await shop.getOrder(D, store.id);
    const lines = last.items.map((i) => `・${i.name} ${qtyText(i.qty, i.unit)}${pm[i.pid]?.on ? '' : '（暫停供貨）'}`).join('\n');
    return {
      type: 'text',
      text: `上次（${label(last.date)}）叫了：\n${lines}\n\n${cur?.items.length ? `⚠️ ${label(D)} 已經叫了 ${cur.items.length} 樣，按確認會改成跟上次一樣。\n` : ''}按「確認送出」就照這樣叫 ${label(D)} 的貨${off.length ? `（${off.join('、')}暫停供貨，不會叫）` : ''}。`,
      quickReply: { items: [
        pbAct('✅ 確認送出', `action=repeat&from=${last.date}`, '照上次叫，確認送出'),
        { type: 'action', action: { type: 'uri', label: '✏️ 改一下再送', uri: url } },
      ] },
    };
  }

  /* ---------- 我的帳款 ---------- */
  if (said === '我的帳款' || said === '帳款' || action === 'mybill') {
    const month = today().slice(0, 7);
    if (pb.get('stmt')) {
      const m = /^\d{4}-\d{2}$/.test(pb.get('stmt')) ? pb.get('stmt') : month;
      const [rows, paid] = await Promise.all([shop.monthAmounts(m), shop.getPaid(m)]);
      const mine = rows.filter((r) => r.storeId === store.id).sort((a, b) => a.date.localeCompare(b.date));
      if (!mine.length) return { type: 'text', text: `${+m.slice(5)} 月還沒有送貨紀錄。` };
      const total = mine.reduce((a, r) => a + r.amount, 0);
      return statementMessage(store, m, mine, total, shop.paidSum(paid[store.id], total));
    }
    const ar = (await report.receivables()).find((x) => x.storeId === store.id);
    const soFar = await shop.monthSoFar(store.id, today());
    const owe = (ar?.months || []).filter((m) => m.month !== month);
    const thisLeft = (ar?.months || []).find((m) => m.month === month)?.amount ?? 0;
    const lines = [`${store.name} 的帳款（${store.pay === 'cash' ? '現結' : '月結'}）`, '', `📅 ${+month.slice(5)} 月到今天：${money(soFar)}${soFar && store.pay === 'cash' ? `，還沒付 ${money(thisLeft)}` : ''}`];
    if (owe.length) lines.push('', '還沒付清：', ...owe.reverse().map((m) => `・${+m.month.slice(5)} 月 ${money(m.amount)}`), `合計 ${money(owe.reduce((a, m) => a + m.amount, 0))}`);
    else lines.push('', '✅ 之前的月份都付清了');
    const prev = addDays(month + '-01', -1).slice(0, 7);
    return {
      type: 'text', text: lines.join('\n'),
      quickReply: { items: [pbAct(`📄 ${+month.slice(5)} 月對帳單`, `action=mybill&stmt=${month}`), pbAct(`📄 ${+prev.slice(5)} 月對帳單`, `action=mybill&stmt=${prev}`)] },
    };
  }

  /* ---------- 回報問題 ---------- */
  const modeRef = db().doc('issueMode/' + uid);
  if (said === '回報問題' || action === 'issue') {
    const step = pb.get('step') || '';
    // 1. 選哪一張單：最近三天送的（含補單）
    if (!step) {
      const slips = [];
      for (let d = today(), i = 0; i < 4 && slips.length < 8; i++, d = addDays(d, -1)) slips.push(...(await shop.slipsOfDay(store.id, d)).map((o) => ({ date: d, seq: o.seq || 1, n: o.items.length })));
      if (!slips.length) return { type: 'text', text: '最近三天沒有送貨紀錄。有其他問題直接在這裡留言，老闆看到會回覆您。' };
      return {
        type: 'text', text: '是哪一天的貨有問題？',
        quickReply: { items: [...slips.slice(0, 8).map((s) => pbAct(`${md(s.date)}${s.seq > 1 ? ` 補單${s.seq}` : ''}（${s.n} 樣）`, `action=issue&step=slip&d=${s.date}&s=${s.seq}`)), pbAct('其他／想跟老闆說', 'action=issue&step=other', '其他問題')] },
      };
    }
    if (step === 'other') return { type: 'text', text: '請直接在這裡打字或傳照片說明，老闆看到會回覆您。' };
    const d = pb.get('d'), s = +pb.get('s') || 1;
    const o = (await shop.slipsOfDay(store.id, d)).find((x) => (x.seq || 1) === s);
    if (!o) return { type: 'text', text: '找不到這張單，請再按一次「回報問題」。' };
    // 2. 哪一個品項
    if (step === 'slip') {
      return {
        type: 'text', text: `${md(d)} 的哪一樣有問題？`,
        quickReply: { items: [...o.items.slice(0, 12).map((i) => pbAct(i.name, `action=issue&step=item&d=${d}&s=${s}&p=${i.pid}`)), pbAct('整張單', `action=issue&step=item&d=${d}&s=${s}&p=*`)] },
      };
    }
    const pid = pb.get('p'), it = o.items.find((i) => i.pid === pid);
    const name = pid === '*' ? '整張單' : it?.name || '品項';
    // 3. 什麼問題
    if (step === 'item') {
      return {
        type: 'text', text: `${md(d)} ${name}：是什麼問題？`,
        quickReply: { items: ISSUE_TYPES.map((t, k) => pbAct(t, `action=issue&step=type&d=${d}&s=${s}&p=${pid}&t=${k}`, `${name}：${t}`)) },
      };
    }
    // 4. 存起來、通知老闆；10 分鐘內傳的照片或文字補到這筆
    if (step === 'type') {
      const type = ISSUE_TYPES[+pb.get('t')] || '其他';
      const id = 'i' + crypto.randomBytes(8).toString('hex');
      await db().doc('issues/' + id).set({ id, storeId: store.id, storeName: store.name, userId: uid, date: d, seq: s, pid, name, type, note: [], photos: [], status: 'open', at: new Date().toISOString() });
      await modeRef.set({ id, at: Date.now() });
      await notifyAdmins(`⚠️ 店家回報：${store.name}\n${md(d)}${s > 1 ? ` 補單${s}` : ''} ${name}：${type}\n後台出貨單頁可以看：${origin}/admin`).catch((err) => console.error(err));
      return { type: 'text', text: `已經通知老闆了 🙏\n${md(d)} ${name}：${type}\n\n可以直接**傳照片**或**打字補充**（10 分鐘內），會一起給老闆看。`.replace(/\*\*/g, '') };
    }
    return null;
  }

  // 剛回報完：照片、文字補到那筆回報（不要被當成叫貨）
  const m = (await modeRef.get()).data();
  if (m && Date.now() - m.at < 10 * 60e3 && (said || (e.type === 'message' && e.message.type === 'image'))) {
    const ref = db().doc('issues/' + m.id);
    if (e.message?.type === 'image') {
      const raw = await getContent(e.message.id);
      const jpg = await sharp(raw).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
      await ref.update({ photos: FieldValue.arrayUnion(await saveImage('data:image/jpeg;base64,' + jpg.toString('base64'), origin)) });
      return { type: 'text', text: '收到照片了，已經給老闆看。' };
    }
    await ref.update({ note: FieldValue.arrayUnion(said.slice(0, 200)) });
    await modeRef.delete();
    return { type: 'text', text: '收到了，已經給老闆看。' };
  }
  return null;
}
