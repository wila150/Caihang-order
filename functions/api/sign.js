// 確認配送單：配貨完，老闆把連結貼到 LINE 聊天室，店家點開核對品項和數量、按確認，再電子簽名
// （現場簽收用紙本，印出來給客戶用筆簽或免簽）
import { getFirestore } from 'firebase-admin/firestore';
import { SHOP } from '../lib/config.js';
import { verifySlipToken } from '../lib/token.js';
import { json, fail, readJSON, UserError } from '../lib/http.js';
import { label, getRulesNow } from '../lib/dates.js';
import * as shop from '../lib/shop.js';

async function slipOf(token) {
  const t = verifySlipToken(token);
  if (!t) throw new UserError('這個連結已經過期或不正確，請跟老闆要新的連結', 401);
  const [store, order, sig, dayPrices] = await Promise.all([
    getFirestore().doc('stores/' + t.storeId).get().then((d) => d.data()),
    shop.getOrder(t.date, t.storeId, t.seq),
    getFirestore().doc(`signatures/${t.date}_${t.key}`).get().then((d) => d.data()),
    shop.getDayPrices(t.date),
  ]);
  if (!store || !order?.items.length) throw new UserError('找不到這張配送單，可能已經取消了', 404);
  // 補送、換貨不收費：不顯示金額
  return { t, store, order, sig, priced: !order.free && order.items.every((i) => i.pid in dayPrices) };
}

export async function GET(request) {
  try {
    const { t, store, order, sig, priced } = await slipOf(new URL(request.url).searchParams.get('t'));
    // 單價還沒全部確認（先出貨後補價）就只給數量，金額之後看對帳單
    const items = order.items.map((i) => {
      const q = shop.billQty(i);
      return { name: i.name, unit: i.unit, qty: q, ordered: i.qty, ...(priced ? { price: i.price, amount: Math.round(q * i.price) } : {}) };
    });
    return json({
      shopName: SHOP.name,
      palette: getRulesNow().palette,
      logo: SHOP.logo,
      basicId: SHOP.basicId,
      store: store.name,
      date: t.date,
      dateLabel: label(t.date),
      seq: t.seq,
      free: { resend: '補送', exchange: '換貨' }[order.free] || '',
      items,
      total: priced ? shop.amountOf(order) : null,
      confirmed: sig ? { at: sig.at, signer: sig.signer } : null,
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request) {
  try {
    const b = await readJSON(request);
    const { t, sig } = await slipOf(b.t);
    if (sig) throw new UserError('這張配送單已經確認過了', 409);
    if (b.confirmed !== true) throw new UserError('請先勾選「品項和數量正確」');
    // 貨物照片（選填）：手機先縮成 JPEG 再傳；店家不在（放門口）時可以只拍照、不簽名
    const photo = String(b.photo || '');
    if (photo && (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 700000)) throw new UserError('照片格式不對或太大，請重拍一次');
    const absent = !!b.absent;
    if (absent && !photo) throw new UserError('店家不在的話，請拍一張貨物放置的照片');
    const png = String(b.png || '');
    if (!absent && (!/^data:image\/png;base64,/.test(png) || png.length > 300000)) throw new UserError('請先簽名');
    const signer = String(b.signer || '').trim().slice(0, 20) || (absent ? '店家不在（拍照留存）' : '');
    const rec = { date: t.date, storeId: t.storeId, seq: t.seq, key: t.key, ...(absent ? {} : { png }), ...(photo ? { hasPhoto: true } : {}), signer, by: absent ? '送貨拍照' : '店家線上確認', at: new Date().toISOString() };
    await getFirestore().doc(`signatures/${t.date}_${t.key}`).create(rec).catch((e) => { if (e.code === 6) throw new UserError('這張配送單剛剛已經確認過了', 409); throw e; }); // create：已經有人確認就失敗，不會互相蓋掉
    // 照片另外存（簽收文件會跟著每天的出貨單一起讀，不要讓它變大）；留存當品質、少給爭議的憑證，不自動刪
    if (photo) await getFirestore().doc(`signPhotos/${t.date}_${t.key}`).set({ data: photo, at: rec.at });
    return json({ confirmed: { at: rec.at, signer: rec.signer } });
  } catch (e) {
    return fail(e);
  }
}
