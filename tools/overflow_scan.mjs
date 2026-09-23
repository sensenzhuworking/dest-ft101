/* ==========================================================================
   overflow_scan.mjs —— 全宽度「跑出框」扫描 + 截图
   为什么需要它：元素被内容顶出边框这类问题，只在某个特定宽度出现。
   人眼盯一个宽度是查不出来的，必须把主流宽度全扫一遍。

   用法（不需要装任何东西，只要有 Chrome 和 Node >= 22）：
     cd polyester-desk
     python3 -m http.server 8791 --bind 127.0.0.1 &
     node tools/overflow_scan.mjs http://127.0.0.1:8791/ [输出目录]

   判定规则：元素的 scrollWidth - clientWidth > 1 即算溢出。
   故意横向滚动 / 会自动滚动的容器在 SKIP 里排除，它们溢出是设计如此。
   ========================================================================== */
const BASE = process.argv[2] || 'http://127.0.0.1:8791/';
const OUT = process.argv[3] || '/tmp/overflow-scan';
const PORT = 9391;

const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const path = await import('node:path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-overflow', 'about:blank'
], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) wsUrl = p.webSocketDebuggerUrl;
  } catch (e) { /* 还没起来 */ }
  if (!wsUrl) await sleep(250);
}
if (!wsUrl) { console.error('CDP 未就绪，Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception?.description || d.text));
  }
});
const send = (method, params = {}) => {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise(r => pending.set(i, r));
};
const ev = async expr => {
  const r = await send('Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

const SCAN = `(()=>{
  const SKIP = new Set(['marquee','newsList','chain','termOut','heat','prov','fresh']);
  const out = [];
  document.querySelectorAll('.card, .spread, .mtile, .cal-row, .node, .tile, .legend, .wfocus-h, .mgroup-h, .card-h').forEach(el => {
    if (SKIP.has(el.id) || SKIP.has(el.className)) return;
    const over = el.scrollWidth - el.clientWidth;
    if (over > 1) out.push({
      cls: (el.className || '').toString().slice(0, 28),
      text: (el.innerText || '').replace(/\\n/g, '|').slice(0, 44),
      over
    });
  });
  return out;
})()`;

const WIDTHS = [1680, 1440, 1280, 1180, 1100, 1000, 900, 820, 781, 700, 620, 540, 480, 430, 390, 360, 320];
const URLS = [
  { tag: '普通', url: BASE },
  { tag: '聚焦', url: BASE + (BASE.includes('?') ? '&' : '?') + 'scan=1#w=sh000905' }
];
let bad = 0;

for (const u of URLS) {
  console.log('\n=== ' + u.tag + ' ' + u.url + ' ===');
  for (const w of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: w, height: 1200, deviceScaleFactor: 1, mobile: w < 800 });
    await send('Page.navigate', { url: u.url });
    // 等真实数据渲染完，不是等一个固定秒数
    for (let i = 0; i < 40; i++) {
      const ready = await ev("!!document.querySelector('#world .mtile')");
      if (ready) break;
      await sleep(500);
    }
    await sleep(900);
    const hits = await ev(SCAN);
    if (hits.length) {
      bad += hits.length;
      console.log('  ' + w + 'px  ' + hits.length + ' 处溢出');
      hits.forEach(h => console.log('      +' + h.over + 'px  ' + h.cls + '  ' + h.text));
    } else {
      console.log('  ' + w + 'px  干净');
    }
    if (w === 390 || w === 1440) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(path.join(OUT, u.tag + '-' + w + '.png'), Buffer.from(r.result.data, 'base64'));
    }
  }
}

console.log('\n异常：' + (logs.length ? '\n  ' + logs.slice(0, 6).join('\n  ') : '无'));
console.log(bad ? '\n合计 ' + bad + ' 处溢出，需要修。截图在 ' + OUT
               : '\n所有宽度都干净。截图在 ' + OUT);
ws.close(); chrome.kill(); process.exit(bad ? 2 : 0);
