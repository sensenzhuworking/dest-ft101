/* 用 CDP 的 Network 域抓实际发出的请求头，确认浏览器有没有带 Referer。
   用法：node tools/inspect_referer.mjs <页面URL> */
const PORT = 9344;
const URL_ = process.argv[2] || 'http://127.0.0.1:8792/';

const { spawn } = await import('node:child_process');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-ref', URL_
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 50; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(300);
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
const hits = [];

ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    if (r.url.includes('np-listapi.eastmoney.com')) {
      hits.push({
        url: r.url.slice(0, 70),
        referer: r.headers['Referer'] || r.headers['referer'] || '(无)',
        origin: r.headers['Origin'] || '(无)',
        cookie: r.headers['Cookie'] ? '(有)' : '(无)'
      });
    }
  }
});
const send = (method, params = {}) => {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise(r => pend.set(i, r));
};

await send('Network.enable');
await send('Runtime.enable');
await sleep(18000);

console.log('\n======== 东财新闻请求实际发出的头 ========');
if (!hits.length) {
  console.log('  没抓到请求 —— 说明根本没发出去，或页面没跑到取新闻那一步');
} else {
  for (const h of hits) {
    console.log('  URL     :', h.url);
    console.log('  Referer :', h.referer, h.referer === '(无)' ? '  ← 没有 Referer' : '  ← 带了！会被 WAF 拦');
    console.log('  Origin  :', h.origin);
    console.log('  Cookie  :', h.cookie);
  }
}

// 顺便看页面上情报流渲染出几条
const ev = async x => (await send('Runtime.evaluate',
  { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
console.log('\n  页面上情报流渲染:', await ev("document.querySelectorAll('#newsList .ni').length"), '条');
console.log('  News.state 已载  :', await ev("(typeof News!=='undefined' && News.state) ? News.state.items.length : '模块未加载'"));

ws.close(); chrome.kill(); process.exit(0);
