// LINE 訊息（Flex Message）。給店家的叫貨訊息不放價格，只有對帳單有金額。
import { SHOP } from './config.js';
import { label, cutoffLabel, md, cutoffTime, addonUntilLabel } from './dates.js';
import { qtyText } from './qty.js';

const C = { head: '#1F3A2C', headText: '#EEF3EA', sub: '#A9BFAE', tag: '#F5D547', text: '#1B2A21', muted: '#5B6B60', green: '#06C755' };
export const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

const text = (t, o = {}) => ({ type: 'text', text: String(t || ' '), size: 'sm', color: C.text, wrap: true, ...o });
const row = (l, r, { margin, ...o } = {}) => ({
  type: 'box',
  layout: 'horizontal',
  ...(margin ? { margin } : {}),
  contents: [text(l, { flex: 5, ...o }), text(r, { flex: 3, align: 'end', ...o })],
});
const sep = { type: 'separator', margin: 'md' };
const button = (label, uri) => ({ type: 'button', style: 'primary', color: C.green, height: 'sm', action: { type: 'uri', label, uri } });

function bubble(title, sub, body, footer) {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: C.head,
      contents: [text(title, { color: C.headText, weight: 'bold', size: 'lg' }), ...(sub ? [text(sub, { color: C.tag, size: 'xs', weight: 'bold' })] : [])],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
    ...(footer ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } } : {}),
  };
}
export const flex = (altText, contents) => ({ type: 'flex', altText, contents });

export function welcome(bound) {
  return {
    type: 'text',
    text: bound
      ? `您好，要叫貨直接打字傳過來就好，例如「${SHOP.example}」，也可以拍手寫單。前一天 ${cutoffTime()} 截單，隔天送到。`
      : `您好，這裡是${SHOP.name}。\n第一次使用請點下方「我要叫貨」申請開通，老闆開通後就能直接在 LINE 叫貨。`,
  };
}

// 叫貨單卡片：items 只有品名和數量
export function orderCard(title, store, date, order, url, editable = true) {
  const items = order?.items || [];
  const body = items.length
    ? items.map((i) => row(i.name, qtyText(i.qty, i.unit), { weight: 'bold' }))
    : [text('還沒叫貨', { color: C.muted })];
  const foot = editable ? `共 ${items.length} 項，${cutoffLabel(date)} 前可以修改` : `共 ${items.length} 項，${title.startsWith('補單') ? (order?.addon ? '您自己補的' : '老闆幫您追加的') : '已截單'}`;
  return bubble(title, `${store.name}・${label(date)} 配送`, [...body, sep, text(foot, { size: 'xs', color: C.muted, margin: 'md' })],
    editable ? [button(items.length ? '修改訂單' : '我要叫貨', url)] : null);
}
export const orderMessage = (title, ...args) => flex(`${title}`, orderCard(title, ...args));

// 截單後補單：另開一張，跟原本的訂單分開
export function addonCard(store, date, order, url, until = addonUntilLabel(date)) {
  const items = order?.items || [];
  const body = items.length
    ? [...items.map((i) => row(i.name, qtyText(i.qty, i.unit), { weight: 'bold' })), sep, text(`共 ${items.length} 項，${until} 前可以修改`, { size: 'xs', color: C.muted, margin: 'md' })]
    : [text(`${label(date)} 的貨已經截單或確認了。要加點的話按下面「我要補單」，會另開一張補單，原本的訂單不會變。`), text(`${until} 前可以補`, { size: 'xs', color: C.muted, margin: 'md' })];
  return bubble(items.length ? '我的補單' : '要加點？', `${store.name}・${label(date)} 配送`, body, [button(items.length ? '修改補單' : '我要補單', url)]);
}

export function myOrders(store, cards) {
  return flex('我的訂單', cards.length === 1 ? cards[0] : { type: 'carousel', contents: cards });
}

export function remindText(date) {
  return { type: 'text', text: `提醒您：${label(date)} 配送的貨，${cutoffLabel(date)} 截單，今天還沒叫貨喔！點下方「我要叫貨」就可以叫。` };
}

export function statementMessage(store, month, rows, total, got = 0) {
  const [y, m] = month.split('-');
  return flex(`${+m} 月對帳單 ${money(total)}`, bubble(`${+m} 月對帳單`, `${store.name}・${y}/${m}`, [
    ...rows.map((r) => row(md(r.date), money(r.amount))),
    sep,
    row(`本月應付（${rows.length} 天）`, money(total), { weight: 'bold', size: 'md', margin: 'md' }),
    ...(got ? [row('已收', money(got)), row('尚欠', money(Math.max(0, total - got)), { weight: 'bold' })] : []),
    text(payTermsOf(store), { size: 'xs', color: C.muted }),
  ]));
}

// AI 整理好的叫貨單，請店家確認
// AI 整理好的叫貨單：直接寫出送出後會變成多少（加上去／改成／不要了）
//   choice：截單後還能補單的日期，讓店家選「補這天」或「叫下一個配送日」
export function draftMessage(store, draft, { existing = [], toAddon = false, choice = null, editUrl }) {
  const before = new Map(existing.map((i) => [i.pid, i.qty]));
  const body = draft.items.map((i) => {
    const op = i.op || 'add';
    if (choice) return row(i.name, op === 'remove' ? '不要了' : `${op === 'set' ? '改成 ' : ''}${qtyText(i.qty, i.unit)}`, { weight: 'bold' });
    const b = before.get(i.pid) || 0;
    const after = op === 'remove' ? 0 : op === 'set' ? i.qty : b + i.qty;
    const right = after === 0 ? (b ? '不要了' : '—') : b ? `${qtyText(b, i.unit)} → ${qtyText(after, i.unit)}` : qtyText(after, i.unit);
    return row(i.name, right, { weight: 'bold' });
  });
  if (draft.unknown.length) {
    body.push(sep, text('看不懂、沒有加進來的：', { size: 'xs', color: C.muted, margin: 'md' }), text(draft.unknown.join('、'), { size: 'sm', color: '#B23A2E' }));
  }
  if (draft.note) body.push(text(`備註：${draft.note}`, { size: 'xs', color: C.muted }));
  const D = draft.date;
  const tip = choice ? `${label(choice)} 的貨已經截單了。要補到 ${label(choice)}（另開補單），還是叫 ${label(D)} 的貨？`
    : toAddon ? `原本的單老闆已經確認了，會加進另一張補單。${cutoffLabel(D)} 前可以補。`
    : existing.length ? `會改到您這次已叫的單（右邊是送出後的數量）。${cutoffLabel(D)} 截單。` : `按「確認送出」才會成立訂單。${cutoffLabel(D)} 截單。`;
  body.push(sep, text(tip, { size: 'sm', color: C.text, margin: 'md', wrap: true }));
  const btn = (labelText, to) => ({ type: 'button', style: 'primary', color: C.green, height: 'sm', action: { type: 'postback', label: labelText, data: `action=aiok&id=${draft.id}${to ? `&to=${to}` : ''}`, displayText: labelText } });
  const buttons = !draft.items.length ? [] : choice ? [btn(`補 ${md(choice)} 的貨`, 'addon'), btn(`叫 ${md(D)} 的貨`, 'next')] : [btn('確認送出', '')];
  return flex('幫您整理的叫貨單，請確認', bubble('幫您整理的叫貨單', `${store.name}・${choice ? '請選配送日' : `${label(D)} 配送${toAddon ? '（補單）' : ''}`}`, body, [
    ...buttons,
    { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '用叫貨單修改', uri: editUrl } },
  ]));
}

// 電子收據：實出量 × 單價
// 付款方式：現結的店每次送貨付清；月結照老闆設定的條件（PAY_TERMS）
export const payTermsOf = (store) => (store?.pay === 'cash' ? '現結：收貨時請付清本單金額，謝謝。' : SHOP.payTerms);

// soFar：月結的店這個月到這天為止的累計金額（含這張）
export function receiptMessage(store, date, order, billQty, soFar = null) {
  const total = Math.round(order.items.reduce((a, i) => a + billQty(i) * i.price, 0));
  const body = order.items.map((i) => {
    const q = billQty(i);
    return {
      type: 'box', layout: 'vertical', contents: [
        row(i.name, money(q * i.price), { weight: 'bold' }),
        text(q ? `${qtyText(q, i.unit)} × ${money(i.price)}${i.ship != null && i.ship !== i.qty ? `（叫 ${qtyText(i.qty, i.unit)}）` : ''}` : '缺貨', { size: 'xxs', color: C.muted }),
      ],
    };
  });
  const slip = order.seq > 1 ? ` 補單 #${order.seq}` : '';
  return flex(`${md(date)}${slip} 收據 ${money(total)}`, bubble(`${md(date)} 出貨收據${slip}`, `${store.name}・${label(date)}`, [
    ...body,
    sep,
    row('合計', money(total), { weight: 'bold', size: 'md', margin: 'md' }),
    ...(store.pay === 'cash'
      ? [row('本次應付（現結）', money(total), { weight: 'bold', color: C.alert || '#C0392B' })]
      : soFar != null ? [row(`${+date.slice(5, 7)} 月累計（月結）`, money(soFar), { size: 'sm' })] : []),
    text(`本單兼收據。${payTermsOf(store)}`, { size: 'xxs', color: C.muted }),
  ]));
}

// 出貨單（不含金額）：單價還沒填就先讓店家核對品項和數量，金額之後在收據或對帳單上
export function slipMessage(store, date, order, billQty) {
  const body = order.items.map((i) => {
    const q = billQty(i);
    const changed = i.ship != null && i.ship !== i.qty;
    return {
      type: 'box', layout: 'vertical', contents: [
        row(i.name, q ? qtyText(q, i.unit) : '缺貨', { weight: 'bold' }),
        ...(changed ? [text(`叫 ${qtyText(i.qty, i.unit)}`, { size: 'xxs', color: C.muted })] : []),
      ],
    };
  });
  const slip = order.seq > 1 ? ` 補單 #${order.seq}` : '';
  return flex(`${md(date)}${slip} 出貨單`, bubble(`${md(date)} 出貨單${slip}`, `${store.name}・${label(date)}`, [
    ...body,
    sep,
    text('單價確認後，金額會在收據或對帳單上通知您。', { size: 'xxs', color: C.muted }),
  ]));
}

export function dunningText(store, ar) {
  const lines = ar.months.slice().reverse().map((m) => `・${+m.month.slice(5)} 月 ${money(m.amount)}${m.billed > m.amount ? `（已付 ${money(m.billed - m.amount)}，還差這些）` : ''}`);
  return { type: 'text', text: `${store.name} 您好，提醒您以下貨款還沒收到：\n${lines.join('\n')}\n合計 ${money(ar.total)}\n${payTermsOf(store)}\n已經付款的話請忽略，謝謝！` };
}

export function approvedText(store) {
  return { type: 'text', text: `已幫您開通「${store.name}」的叫貨帳號！\n點下方「我要叫貨」就可以開始叫貨。` };
}
