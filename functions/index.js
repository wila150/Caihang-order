// Cloud Functions 進入點：所有 /api/* 都進到這裡
//   /api/webhook  LINE webhook
//   /api/shop     店家叫貨頁
//   /api/admin    後台
import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { gzipSync } from 'node:zlib';
import * as webhook from './api/webhook.js';
import * as shop from './api/shop.js';
import * as admin from './api/admin.js';
import * as sign from './api/sign.js';
import * as info from './api/info.js';
import * as img from './api/img.js';
import { processJob, cleanOldPhotos } from './lib/aiorder.js';
import { loadRules } from './lib/rules.js';

initializeApp();
setGlobalOptions({ region: 'asia-east1', maxInstances: 5 });

// 金鑰放在 Secret Manager：firebase functions:secrets:set LINE_CHANNEL_SECRET
const secrets = [defineSecret('LINE_CHANNEL_SECRET'), defineSecret('LINE_CHANNEL_ACCESS_TOKEN')];
const aiSecrets = [...secrets, defineSecret('NVIDIA_API_KEY')];
const routes = { webhook, shop, admin, sign, info, img };

// invoker: 'public'：LINE、店家、後台都要能呼叫（權限在程式裡檢查）。寫明白，新專案部署時才會自動打開
// 後台上傳進貨單照片要叫 AI 讀（約 20～40 秒），所以 api 也要 NVIDIA 金鑰、時間放寬
export const api = onRequest({ secrets: aiSecrets, cors: false, invoker: 'public', timeoutSeconds: 120 }, async (req, res) => {
  const name = req.path.replace(/^\/api\//, '').replace(/^\//, '').split('/')[0];
  const fn = routes[name]?.[req.method];
  if (!fn) return res.status(404).send('Not found');

  // 轉成標準的 Request，api/*.js 就不用管是跑在哪個平台
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto')?.split(',')[0] || req.protocol;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  const request = new Request(`${proto}://${host}${req.originalUrl}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.rawBody,
  });

  await loadRules(); // 截單時間、公休日、補單規則（後台設定）
  const r = await fn(request);
  r.headers.forEach((v, k) => res.set(k, v));
  let body = Buffer.from(await r.arrayBuffer());
  // 後台一次載入有兩千多個品項（幾百 KB），壓縮後小很多，手機網路比較快
  if (body.length > 2048 && /json|html|text/.test(r.headers.get('content-type') || '') && /\bgzip\b/.test(req.get('accept-encoding') || '')) {
    body = gzipSync(body);
    res.set('Content-Encoding', 'gzip');
    res.set('Vary', 'Accept-Encoding');
  }
  res.status(r.status).send(body);
});

// AI 叫貨：webhook 把店家的文字／照片存進 aiJobs，這裡接手辨識，再回卡片請店家確認
export const aiOrder = onDocumentCreated({ document: 'aiJobs/{id}', secrets: aiSecrets, timeoutSeconds: 120, memory: '512MiB' }, async (event) => {
  const job = event.data?.data();
  if (!job) return;
  try {
    await loadRules();
    await processJob(job, event.params.id);
  } finally {
    await event.data.ref.delete(); // 處理完就刪，replyToken 這類東西不留著
  }
});

// 每天凌晨 4 點清掉 14 天前的 AI 叫貨照片縮圖
export const cleanAiPhotos = onSchedule({ schedule: 'every day 04:00', timeZone: 'Asia/Taipei' }, () => Promise.all([cleanOldPhotos(14), img.cleanOldImages(60)]));
