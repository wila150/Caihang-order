// 重置測試資料（只有工程師能用）：清掉訂單、採買、帳務、進貨，保留品項、店家、LINE 綁定、帳號、設定、店家叫法和 ERP 購買習慣
// 新增會隨著叫貨、記帳產生的資料時，記得加進這裡
import { getFirestore } from 'firebase-admin/firestore';

export const RESET_COLLECTIONS = [
  'orders', 'signatures', 'printed', 'monthly', 'paid', 'dayPrices', 'costs', 'bought', // 訂單、簽收、印過沒、對帳、單價、採買進度
  'expenses', 'purchases', 'supplierPays', // 記帳、上游進貨單、付廠商的錢
  'aiDrafts', 'aiJobs', 'aiUsage', 'issues', 'issueMode', 'pushImages', // AI 叫貨、店家回報、推播圖片
];

export async function resetTestData() {
  const db = getFirestore();
  const deleted = {};
  for (const name of RESET_COLLECTIONS) {
    const ref = db.collection(name);
    deleted[name] = (await ref.count().get()).data().count;
    await db.recursiveDelete(ref);
  }
  return deleted;
}
