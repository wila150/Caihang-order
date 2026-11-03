// 操作紀錄：改價、刪單、收款這些重要動作，記下誰、什麼時候、做了什麼（後台「設定 → 操作紀錄」看，只有老闆）
//   auditLog/{自動 id} { at, who, action, text }
import { getFirestore } from 'firebase-admin/firestore';

export const AUDIT_ACTIONS = { price: '改價', delete: '刪單', payment: '收款', unpay: '刪收款', paid: '收清', pay: '結帳方式', store: '換店' };

// 記錄失敗不能擋住原本的動作
export async function audit(me, action, text) {
  if (!text) return;
  try {
    await getFirestore().collection('auditLog').add({ at: new Date().toISOString(), who: me?.name || me?.email || '', action, text: String(text).slice(0, 500) });
  } catch (e) {
    console.error('操作紀錄寫入失敗', e);
  }
}

export async function listAudit(limit = 300) {
  const snap = await getFirestore().collection('auditLog').orderBy('at', 'desc').limit(limit).get();
  return snap.docs.map((d) => d.data());
}
