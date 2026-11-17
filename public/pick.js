/* ---------- 平板撿貨：全螢幕、一張單一張單秤 ----------
   用後台主程式的 D、api、SM、sortItems、okey、qtyText、toast… （admin.html 先載入）
   秤：藍牙 BLE 收秤送出的字串（秤要開「連續輸出」），或「模擬秤」先試流程
   多台平板分工：點一張單就鎖住（picks/{日期}_{單}），別台看到「誰撿貨中」；20 分鐘沒動作自動放掉 */
(() => {
const PK = { view: 'list', key: '', cur: '', picks: {}, poll: 0, lock: null, q: '',
  scale: { mode: 'sim', kg: 0, stable: false, dev: null, at: 0, hist: [] } };
const CFG_KEY = 'pickCfg';
const cfg = Object.assign({ unit: 'kg', tare: 0, tol: 3, tts: true }, (() => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch { return {}; } })());
const saveCfg = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {} };

// 秤的單位：重量類品項才秤，其他（箱、包、把…）用點的
const KG_PER = { '斤': 0.6, '台斤': 0.6, '公斤': 1, 'kg': 1, '兩': 0.0375, '克': 0.001, '公克': 0.001, 'g': 0.001 };
const weighable = (u) => u in KG_PER;
// kg → 品項單位；斤取到「兩」（1/16 斤），其他到小數第 2 位
const toUnit = (kg, u) => { const v = kg / KG_PER[u]; return u === '斤' || u === '台斤' ? Math.round(v * 16) / 16 : Math.round(v * 100) / 100; };
const netKg = () => Math.max(0, +(PK.scale.kg - (+cfg.tare || 0)).toFixed(3));

/* ---------- 畫面 ---------- */
const css = `
#pickApp{position:fixed;inset:0;z-index:900;background:var(--bg);color:var(--ink);display:flex;flex-direction:column;font-size:17px;overscroll-behavior:contain}
#pickApp[hidden]{display:none}
#pickApp .pk-top{display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top,0px)) 16px 10px;background:var(--surface);border-bottom:1px solid var(--line);flex-wrap:wrap}
#pickApp .pk-top h2{margin:0;font-size:20px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pickApp button{font:inherit;cursor:pointer;border-radius:12px;border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:10px 14px;min-height:48px}
#pickApp .pk-scale{font-size:15px;display:flex;align-items:center;gap:6px}
#pickApp .pk-dot{width:10px;height:10px;border-radius:50%;background:var(--muted)}
#pickApp .pk-dot.on{background:var(--line-green)}
#pickApp .pk-body{flex:1;overflow:auto;padding:14px 16px calc(14px + env(safe-area-inset-bottom,0px))}
#pickApp .pk-search{width:100%;font:inherit;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--surface);color:var(--ink);margin-bottom:12px}
#pickApp .pk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
#pickApp .pk-card{text-align:left;display:flex;flex-direction:column;gap:6px;padding:14px;min-height:110px;box-shadow:var(--shadow)}
#pickApp .pk-card b{font-size:19px}
#pickApp .pk-card small{color:var(--muted)}
#pickApp .pk-card.busy{border-color:var(--gold);background:var(--tag-soft)}
#pickApp .pk-card.done{opacity:.6}
#pickApp .pk-card.mine{border:2px solid var(--leaf)}
#pickApp .pk-bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden}
#pickApp .pk-bar i{display:block;height:100%;background:var(--leaf)}
#pickApp .pk-chip{display:inline-block;font-size:13px;padding:2px 8px;border-radius:99px;background:var(--leaf-soft);color:var(--leaf)}
#pickApp .pk-chip.busy{background:var(--tag);color:var(--tag-ink)}
#pickApp .pk-slip{display:grid;grid-template-columns:minmax(220px,34%) 1fr;gap:14px;height:100%}
#pickApp .pk-items{overflow:auto;display:flex;flex-direction:column;gap:6px}
#pickApp .pk-it{display:flex;justify-content:space-between;gap:8px;text-align:left;min-height:52px;align-items:center}
#pickApp .pk-it.cur{border:2px solid var(--leaf);background:var(--leaf-soft)}
#pickApp .pk-it.ok{color:var(--muted)}
#pickApp .pk-it.ok span:first-child::before{content:"✓ ";color:var(--leaf);font-weight:700}
#pickApp .pk-it.short span:first-child::before{content:"✕ ";color:var(--alert);font-weight:700}
#pickApp .pk-main{display:flex;flex-direction:column;gap:12px;min-width:0}
#pickApp .pk-name{font-size:34px;font-weight:700;line-height:1.2}
#pickApp .pk-want{font-size:22px;color:var(--muted)}
#pickApp .pk-weigh{flex:1;min-height:180px;border-radius:18px;border:3px solid var(--line);background:var(--surface);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;touch-action:pan-y;user-select:none;-webkit-user-select:none;position:relative}
#pickApp .pk-weigh.ok{border-color:var(--leaf);background:var(--leaf-soft)}
#pickApp .pk-weigh.warn{border-color:var(--gold);background:var(--tag-soft)}
#pickApp .pk-big{font-size:clamp(48px,9vw,96px);font-weight:800;font-variant-numeric:tabular-nums;line-height:1}
#pickApp .pk-diff{font-size:22px}
#pickApp .pk-hint{position:absolute;bottom:8px;font-size:13px;color:var(--muted)}
#pickApp .pk-acts{display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px}
#pickApp .pk-go{background:var(--leaf);color:#fff;border-color:var(--leaf);font-size:22px;font-weight:700;min-height:64px}
#pickApp .pk-go:disabled{opacity:.45}
#pickApp .pk-step{display:flex;align-items:center;justify-content:center;gap:14px}
#pickApp .pk-step button{font-size:30px;width:72px;height:72px}
#pickApp .pk-sim{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:14px;color:var(--muted)}
#pickApp .pk-sim input[type=range]{flex:1;min-width:160px}
#pickApp .pk-done{text-align:center;padding:40px 10px;display:flex;flex-direction:column;gap:14px;align-items:center}
#pickApp .pk-set{display:grid;gap:14px;max-width:520px}
#pickApp .pk-set label{display:flex;justify-content:space-between;align-items:center;gap:12px}
#pickApp .pk-set input,#pickApp .pk-set select{font:inherit;padding:8px 10px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink);width:140px}
@media (max-width:700px){#pickApp .pk-slip{grid-template-columns:1fr}#pickApp .pk-items{max-height:30vh}}
`;
document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);
document.body.insertAdjacentHTML('beforeend', `<div id="pickApp" hidden role="dialog" aria-label="平板撿貨"><div class="pk-top" id="pkTop"></div><div class="pk-body" id="pkBody"></div></div>`);
const el = (id) => document.getElementById(id);

const orders = () => D.orders.filter((o) => o.items.length);
const routeOf = (o) => SM()[o.storeId]?.route ?? 999;
const pickOf = (k) => PK.picks[k] || {};
const doneSet = (k) => pickOf(k).items || {};
const signed = (k) => !!D.signatures?.[k];
const isMine = (p) => p.email && p.email === D.me.email;
const busyBy = (p) => (p.by && !p.done && !p.stale && !isMine(p) ? p.by : '');

function render() {
  const sc = PK.scale;
  const scaleTxt = sc.mode === 'ble' ? (sc.dev ? `藍牙秤 ${sc.dev.name || ''}` : '藍牙秤（沒連上）') : '模擬秤';
  el('pkTop').innerHTML = `<button data-pk="${PK.view === 'list' ? 'close' : 'back'}">‹ ${PK.view === 'list' ? '回後台' : '店家列表'}</button>
    <h2>${PK.view === 'slip' ? esc(slipName(PK.key)) : `${esc(dlabel(D.date))} 撿貨`}</h2>
    <span class="pk-scale"><span class="pk-dot ${sc.mode === 'sim' || sc.dev ? 'on' : ''}"></span>${esc(scaleTxt)}</span>
    <button data-pk="ble">${sc.dev ? '換秤' : '連接藍牙秤'}</button><button data-pk="set" aria-label="撿貨設定">⚙</button>`;
  el('pkBody').innerHTML = PK.view === 'list' ? listHtml() : PK.view === 'set' ? setHtml() : slipHtml();
  if (PK.view === 'slip') bindSwipe();
}

function listHtml() {
  const q = PK.q.trim().toLowerCase();
  const L = orders().filter((o) => !q || storeHit(SM()[o.storeId] || {}, q)).sort((a, b) => routeOf(a) - routeOf(b) || (a.seq || 1) - (b.seq || 1));
  const cards = L.map((o) => {
    const k = okey(o), p = pickOf(k), ds = doneSet(k);
    const n = o.items.length, got = o.items.filter((i) => ds[i.pid]).length;
    const by = busyBy(p);
    const st = signed(k) ? '<span class="pk-chip">已簽收</span>' : p.done ? '<span class="pk-chip">✓ 撿完</span>' : by ? `<span class="pk-chip busy">🔒 ${esc(by)} 撿貨中</span>` : isMine(p) && !p.stale ? '<span class="pk-chip">我正在撿</span>' : got ? '<span class="pk-chip">撿到一半</span>' : '';
    return `<button class="pk-card ${by ? 'busy' : ''} ${p.done || signed(k) ? 'done' : ''} ${isMine(p) && !p.done ? 'mine' : ''}" data-pkopen="${esc(k)}">
      <b>${esc(slipName(k))}</b><small>第 ${esc(routeOf(o))} 站 · ${got}/${n} 項</small>
      <span class="pk-bar"><i style="width:${n ? Math.round(got / n * 100) : 0}%"></i></span>${st}</button>`;
  }).join('');
  const all = orders().length, fin = orders().filter((o) => pickOf(okey(o)).done || signed(okey(o))).length;
  return `<input class="pk-search" id="pkQ" type="search" placeholder="找店家" value="${esc(PK.q)}" aria-label="找店家">
    <p style="margin:0 0 10px;color:var(--muted)">撿完 ${fin}/${all} 張　點一張單開始撿，別台平板會看到「撿貨中」</p>
    <div class="pk-grid">${cards || '<div class="empty">這天還沒有訂單</div>'}</div>`;
}

function setHtml() {
  return `<div class="pk-set">
    <label>秤顯示的單位<select data-pkcfg="unit"><option value="kg" ${cfg.unit === 'kg' ? 'selected' : ''}>公斤 kg</option><option value="斤" ${cfg.unit === '斤' ? 'selected' : ''}>台斤</option></select></label>
    <label>籃子重（公斤，會扣掉）<input data-pkcfg="tare" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(cfg.tare)}"></label>
    <label>誤差多少算 OK（%）<input data-pkcfg="tol" type="number" inputmode="decimal" step="1" min="0" value="${esc(cfg.tol)}"></label>
    <label>語音播報<select data-pkcfg="tts"><option value="1" ${cfg.tts ? 'selected' : ''}>開</option><option value="" ${cfg.tts ? '' : 'selected'}>關</option></select></label>
    <label>秤<select data-pkcfg="mode"><option value="sim" ${PK.scale.mode === 'sim' ? 'selected' : ''}>模擬秤（測試用）</option><option value="ble" ${PK.scale.mode === 'ble' ? 'selected' : ''}>藍牙秤</option></select></label>
    <p style="color:var(--muted);margin:0">藍牙秤要用 iPad 的 Bluefy 瀏覽器（Safari 不支援藍牙），秤要設成「連續輸出」。設定只存在這台平板。</p>
    <button data-pk="back">完成</button></div>`;
}

/* ---------- 單張撿貨 ---------- */
const curOrder = () => orderOf(PK.key);
const itemsOf = (o) => sortItems(o.items);
const nextPid = (o, after) => {
  const L = itemsOf(o), ds = doneSet(PK.key);
  const i = L.findIndex((x) => x.pid === after);
  return [...L.slice(i + 1), ...L.slice(0, i + 1)].find((x) => !ds[x.pid])?.pid || '';
};
// 跟叫貨量差多少：誤差設定的 % 或 1 兩（0.0625 斤）取大的
function judge(it, v) {
  if (!(v > 0)) return { cls: '', txt: '放上秤' };
  const tol = Math.max(it.qty * (+cfg.tol || 0) / 100, it.unit === '斤' ? 0.0625 : 0.01);
  const d = v - it.qty;
  if (Math.abs(d) <= tol) return { cls: 'ok', txt: '✓ 剛好' };
  return { cls: 'warn', txt: `${d > 0 ? '多' : '少'} ${qtyText(Math.abs(Math.round(d * 10000) / 10000), it.unit)}` };
}

function slipHtml() {
  const o = curOrder();
  if (!o) return '<div class="empty">這張單不見了（可能被刪掉），回列表</div>';
  const ds = doneSet(PK.key), L = itemsOf(o);
  // cur：null＝剛打開（跳到第一個還沒秤的）；''＝全部秤完（顯示完成畫面）
  if (PK.cur == null || (PK.cur && !L.some((i) => i.pid === PK.cur))) PK.cur = nextPid(o, '') || (L.every((i) => ds[i.pid]) ? '' : L[0]?.pid);
  const lock = signed(PK.key);
  const list = L.map((i) => {
    const q = billQty(i);
    return `<button class="pk-it ${i.pid === PK.cur ? 'cur' : ''} ${ds[i.pid] ? (q === 0 ? 'short' : 'ok') : ''}" data-pkit="${i.pid}"><span>${esc(i.name)}</span><span>${ds[i.pid] ? (q === 0 ? '缺貨' : esc(qtyText(q, i.unit))) : esc(qtyText(i.qty, i.unit))}</span></button>`;
  }).join('');
  const all = L.every((i) => ds[i.pid]);
  let main;
  if (lock) main = `<div class="pk-done"><b>這張單已經簽收，不能再改</b><button data-pk="back">回列表</button></div>`;
  else if (all && !PK.cur) main = doneHtml(o);
  else {
    const it = L.find((i) => i.pid === PK.cur);
    main = it ? itemHtml(it, all) : doneHtml(o);
  }
  return `<div class="pk-slip"><div class="pk-items">${list}</div><div class="pk-main" id="pkMain">${main}</div></div>`;
}

function itemHtml(it, all) {
  const ds = doneSet(PK.key), again = !!ds[it.pid];
  const head = `<div><div class="pk-name">${esc(it.name)}</div><div class="pk-want">叫 ${esc(qtyText(it.qty, it.unit))}${again ? `　已秤 ${esc(qtyText(billQty(it), it.unit))}（再秤一次會蓋掉）` : ''}</div></div>`;
  const acts = `<div class="pk-acts"><button class="pk-go" data-pk="ok" id="pkGo">確認，下一項</button><button data-pk="short">缺貨</button><button data-pk="type">手動輸入</button></div>
    ${all ? '<button data-pk="finish">這張撿完了</button>' : ''}`;
  if (!weighable(it.unit)) {
    PK.count = PK.count ?? billQty(it);
    return `${head}<div class="pk-weigh ok" id="pkW"><div class="pk-step"><button data-pkstep="-1" aria-label="減少">−</button><span class="pk-big">${esc(fmtQ(PK.count))}</span><button data-pkstep="1" aria-label="增加">+</button></div><div class="pk-diff">${esc(it.unit)}（不用秤，點數量）</div><span class="pk-hint">往右滑＝確認</span></div>${acts}`;
  }
  const sim = PK.scale.mode === 'sim' ? `<div class="pk-sim">模擬秤：<input type="range" id="pkSim" min="0" max="${Math.max(10, Math.ceil(it.qty * KG_PER[it.unit] * 2))}" step="0.01" value="${PK.scale.kg}" aria-label="模擬秤重量（公斤）"><button data-pk="simput">放上差不多的量</button><button data-pk="simoff">拿下來</button></div>` : '';
  return `${head}<div class="pk-weigh" id="pkW"><div class="pk-big" id="pkBig"></div><div class="pk-diff" id="pkDiff"></div><span class="pk-hint" id="pkHint"></span></div>${sim}${acts}`;
}

function doneHtml(o) {
  const ds = doneSet(PK.key), short = o.items.filter((i) => ds[i.pid] && billQty(i) === 0).length;
  return `<div class="pk-done"><div class="pk-name">${pickOf(PK.key).done ? '✓ 撿完了' : '全部秤好了'}</div>
    <p>${o.items.length} 項${short ? `，缺貨 ${short} 項` : ''}。實出量已經寫進出貨單，計價照實出量。</p>
    ${pickOf(PK.key).done ? '' : '<button class="pk-go" data-pk="finish">完成這張，回列表</button>'}
    <button data-pk="back">先回列表</button></div>`;
}

// 秤的數字一直跳：只更新數字那塊，不重畫整頁
function paintWeight() {
  if (PK.view !== 'slip') return;
  const o = curOrder(), it = o?.items.find((i) => i.pid === PK.cur);
  const big = el('pkBig');
  if (!it || !big || !weighable(it.unit)) return;
  const sc = PK.scale, v = toUnit(netKg(), it.unit), j = judge(it, v);
  const live = sc.mode === 'sim' || (sc.dev && Date.now() - sc.at < 3000);
  big.textContent = live ? qtyText(v, it.unit) : '—';
  el('pkDiff').textContent = live ? j.txt : sc.dev ? '秤沒有送資料（秤要開連續輸出）' : '先按右上「連接藍牙秤」';
  el('pkHint').textContent = live ? (sc.stable ? '已穩定　往右滑＝確認' : '等數字穩定…') : '';
  el('pkW').className = 'pk-weigh ' + (live ? j.cls : '');
  el('pkGo').disabled = !live || !sc.stable || !(v > 0);
}

/* ---------- 動作 ---------- */
async function openSlip(k, force = false) {
  const p = pickOf(k), by = busyBy(p);
  if (by && !force) { if (!confirm(`${by} 正在撿這張單。要接手嗎？（兩個人一起撿容易重複）`)) return; force = true; }
  if (!signed(k)) {
    try { const r = await api('POST', { action: 'pick', op: p.done ? 'reopen' : 'take', date: D.date, storeId: sidOf(k), seq: seqOf(k), force }); PK.picks[k] = r.pick; }
    catch (e) { toast(e.message); return; }
  }
  PK.key = k; PK.cur = null; PK.count = null; PK.view = 'slip'; render(); paintWeight();
  const it = curOrder()?.items.find((i) => i.pid === PK.cur);
  if (it) say(`${slipName(k)}，第一項，${it.name}，${qtyText(it.qty, it.unit)}`);
}

async function release() {
  const k = PK.key; if (!k || pickOf(k).done || signed(k)) return;
  try { const r = await api('POST', { action: 'pick', op: 'release', date: D.date, storeId: sidOf(k), seq: seqOf(k) }); PK.picks[k] = r.pick; } catch {}
}

let busy = false;
async function confirmItem(qty) {
  if (busy) return;
  const o = curOrder(), it = o?.items.find((i) => i.pid === PK.cur);
  if (!it) return;
  if (qty == null) {
    if (weighable(it.unit)) { if (el('pkGo')?.disabled) return; qty = toUnit(netKg(), it.unit); }
    else qty = PK.count ?? it.qty;
  }
  busy = true;
  try {
    const r = await api('POST', { action: 'pickItem', date: D.date, storeId: sidOf(PK.key), seq: seqOf(PK.key), pid: it.pid, ship: qty });
    const i = D.orders.findIndex((x) => okey(x) === PK.key);
    if (i >= 0) D.orders[i] = r.order;
    const p = PK.picks[PK.key] || (PK.picks[PK.key] = { items: {} });
    p.items = { ...(p.items || {}), [it.pid]: true }; p.by = D.me.name; p.email = D.me.email;
    const nx = nextPid(r.order, it.pid);
    const nit = r.order.items.find((x) => x.pid === nx);
    say(`${it.name}，${qty ? qtyText(qty, it.unit) : '缺貨'}${nit ? `，下一項，${nit.name}` : '，這張全部秤好了'}`);
    PK.cur = nx; PK.count = null;
    if (PK.scale.mode === 'sim') PK.scale.kg = 0;
    render(); paintWeight();
    if (typeof renderSlips === 'function') renderSlips();
  } catch (e) { toast(e.message); }
  finally { busy = false; }
}

async function finish() {
  const k = PK.key;
  try { const r = await api('POST', { action: 'pick', op: 'done', date: D.date, storeId: sidOf(k), seq: seqOf(k) }); PK.picks[k] = r.pick; say(`${slipName(k)}，撿完`); }
  catch (e) { toast(e.message); return; }
  PK.view = 'list'; PK.key = ''; render();
}

// 往右滑＝確認（手濕、戴手套用指節一滑就好）
function bindSwipe() {
  const w = el('pkW'); if (!w) return;
  let x0 = null;
  w.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
  w.addEventListener('pointerup', (e) => { if (x0 != null && e.clientX - x0 > 120) confirmItem(); x0 = null; });
  w.addEventListener('pointercancel', () => { x0 = null; });
}

/* ---------- 語音、螢幕常亮 ---------- */
function say(t) {
  if (!cfg.tts || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(String(t).replace(/ /g, '')); u.lang = 'zh-TW'; u.rate = 1.05; speechSynthesis.speak(u); } catch {}
}
async function wake() { try { if (!el('pickApp').hidden && 'wakeLock' in navigator) PK.lock = await navigator.wakeLock.request('screen'); } catch {} }

/* ---------- 秤 ---------- */
// 穩定：最近 0.8 秒內數字差不到 0.02 公斤；秤有送 ST/US（穩定／不穩）就照秤的
function feed(kg, flag) {
  const sc = PK.scale, now = Date.now();
  sc.kg = kg; sc.at = now;
  sc.hist = [...sc.hist.filter((h) => now - h.t < 800), { t: now, kg }];
  const span = Math.max(...sc.hist.map((h) => h.kg)) - Math.min(...sc.hist.map((h) => h.kg));
  sc.stable = flag === 'ST' ? true : flag === 'US' ? false : sc.hist.length >= 2 && span < 0.02;
  paintWeight();
}
// 一行字裡找重量，例如「ST,GS,+  12.34kg」「   3.50 kg」；秤設成台斤就換成公斤
function parseLine(s) {
  const m = s.match(/([-+]?\s*\d+(?:\.\d+)?)\s*(kg|g|lb|斤)?/i);
  if (!m) return;
  let v = parseFloat(m[1].replace(/\s/g, ''));
  const u = (m[2] || '').toLowerCase();
  if (u === 'g') v /= 1000; else if (u === 'lb') v *= 0.4536; else if (u === '斤' || (!u && cfg.unit === '斤')) v *= 0.6;
  feed(Math.max(0, v), /\bST\b/.test(s) ? 'ST' : /\bUS\b/.test(s) ? 'US' : '');
}
// 常見的 BLE 透傳模組：HM-10／JDY（FFE0/FFE1）、FFF0、Nordic UART
const SERVICES = [0xffe0, 0xfff0, '6e400001-b5a3-f393-e0a9-e50e24dcca9e', 0x18f0];
async function connectBle() {
  if (!navigator.bluetooth) { alert('這個瀏覽器不支援藍牙。iPad 請用 App Store 的「Bluefy」瀏覽器開後台；Android 用 Chrome。'); return; }
  try {
    const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    const gatt = await dev.gatt.connect();
    let ch = null;
    for (const s of SERVICES) {
      const svc = await gatt.getPrimaryService(s).catch(() => null);
      if (!svc) continue;
      ch = (await svc.getCharacteristics()).find((c) => c.properties.notify || c.properties.indicate);
      if (ch) break;
    }
    if (!ch) { toast('連上了，但找不到秤的資料通道（模組型號給工程師看）'); gatt.disconnect(); return; }
    let buf = '';
    const dec = new TextDecoder();
    ch.addEventListener('characteristicvaluechanged', (e) => {
      buf += dec.decode(e.target.value);
      const lines = buf.split(/[\r\n]+/);
      buf = lines.pop().slice(-64);
      lines.filter(Boolean).forEach(parseLine);
    });
    await ch.startNotifications();
    dev.addEventListener('gattserverdisconnected', () => { PK.scale.dev = null; render(); paintWeight(); toast('秤的藍牙斷了，按「連接藍牙秤」重連'); });
    Object.assign(PK.scale, { mode: 'ble', dev, kg: 0, stable: false, hist: [] });
    toast('秤已連上'); render(); paintWeight();
  } catch (e) { if (e.name !== 'NotFoundError') toast('連不上秤：' + e.message); }
}

/* ---------- 誰在撿哪張：畫面開著才每 15 秒問一次（關掉、切到別的 App 就停） ---------- */
async function refresh() {
  try { const j = await api('GET', null, `?picks=${D.date}`); PK.picks = j.picks; if (PK.view === 'list') render(); } catch {}
}
function startPoll() { stopPoll(); refresh(); PK.poll = setInterval(() => { if (!document.hidden) refresh(); }, 15000); }
function stopPoll() { clearInterval(PK.poll); PK.poll = 0; }

function open() {
  if (!may('editOrders')) { toast('要有「改訂單」權限才能撿貨'); return; }
  PK.view = 'list'; PK.key = '';
  el('pickApp').hidden = false; document.body.style.overflow = 'hidden';
  render(); startPoll(); wake();
}
async function close() {
  await release();
  el('pickApp').hidden = true; document.body.style.overflow = '';
  stopPoll(); try { PK.lock?.release(); } catch {} PK.lock = null;
  if (typeof renderAll === 'function') renderAll();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); if (PK.poll) refresh(); } });

/* ---------- 事件 ---------- */
document.addEventListener('click', (e) => { if (e.target.closest('#pickOpen')) open(); });
el('pickApp').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const a = b.dataset.pk;
  if (b.dataset.pkopen) return openSlip(b.dataset.pkopen);
  if (b.dataset.pkit) { PK.cur = b.dataset.pkit; PK.count = null; render(); paintWeight(); return; }
  if (b.dataset.pkstep) { const it = curOrder()?.items.find((i) => i.pid === PK.cur); PK.count = Math.max(0, (PK.count ?? billQty(it)) + +b.dataset.pkstep); render(); return; }
  if (a === 'close') return close();
  if (a === 'back') { if (PK.view === 'slip') await release(); PK.view = 'list'; PK.key = ''; render(); refresh(); return; }
  if (a === 'set') { if (PK.view === 'slip') await release(); PK.view = 'set'; PK.key = ''; render(); return; }
  if (a === 'ble') return connectBle();
  if (a === 'ok') return confirmItem();
  if (a === 'finish') return finish();
  if (a === 'short') { const it = curOrder()?.items.find((i) => i.pid === PK.cur); if (it && confirm(`「${it.name}」標成缺貨（不出貨、不計價）？`)) confirmItem(0); return; }
  if (a === 'type') {
    const it = curOrder()?.items.find((i) => i.pid === PK.cur); if (!it) return;
    const raw = prompt(`${it.name} 實出多少？（${it.unit}${it.unit === '斤' ? '，可以打 2斤4兩' : ''}）`, editText(billQty(it), it.unit));
    if (raw == null) return;
    const q = typeof parseQty === 'function' ? parseQty(raw, it.unit) : parseFloat(raw);
    if (!(q >= 0)) { toast('數量看不懂，例如 3、2.5、2斤4兩'); return; }
    return confirmItem(q);
  }
  if (a === 'simput') { const it = curOrder()?.items.find((i) => i.pid === PK.cur); if (!it) return; const kg = it.qty * KG_PER[it.unit] * (0.95 + Math.random() * 0.1) + (+cfg.tare || 0); simTo(kg); return; }
  if (a === 'simoff') { simTo(0); return; }
});
// 模擬秤：數字跳幾下才穩定，跟真的秤一樣
let simT = 0;
function simTo(kg) {
  clearInterval(simT); let n = 0;
  simT = setInterval(() => { n++; feed(Math.max(0, +(kg + (n < 4 ? (Math.random() - 0.5) * 0.3 : 0)).toFixed(2))); if (n >= 10) clearInterval(simT); const r = el('pkSim'); if (r) r.value = kg; }, 200);
}
el('pickApp').addEventListener('input', (e) => {
  if (e.target.id === 'pkQ') { PK.q = e.target.value; const pos = e.target.selectionStart; render(); const q = el('pkQ'); q.focus(); q.setSelectionRange(pos, pos); return; }
  if (e.target.id === 'pkSim') { clearInterval(simT); feed(+e.target.value); feed(+e.target.value); }
});
el('pickApp').addEventListener('change', (e) => {
  const k = e.target.dataset.pkcfg; if (!k) return;
  if (k === 'mode') { PK.scale.mode = e.target.value; if (e.target.value === 'sim') PK.scale.dev?.gatt?.disconnect(); return; }
  cfg[k] = k === 'tts' ? !!e.target.value : k === 'unit' ? e.target.value : Math.max(0, +e.target.value || 0);
  saveCfg();
});
})();
