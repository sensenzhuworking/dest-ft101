/* 把用户的线上站点真的跑一遍，抓新闻请求的头 + 响应状态 + 渲染条数。
   用法：node tools/diagnose_live.mjs <线上URL> */
const PORT = 9345;
const URL_ = process.argv[2];
if (!URL_) { console.error('需要传入线上 URL'); process.exit(1); }

const { spawn } = await import('node:child_process');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1500,900',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-live', URL_
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
const reqs = new Map(); const done = [];

ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    if (r.url.includes('np-listapi') || r.url.includes('datacenter-web') ||
        r.url.includes('gtimg.cn') || r.url.includes('cnbc.com') || r.url.includes('sina.com.cn')) {
      reqs.set(m.params.requestId, {
        host: new URL(r.url).host,
        referer: r.headers['Referer'] || r.headers['referer'] || '(无)',
        origin: r.headers['Origin'] || '(无)'
      });
    }
  }
  if (m.method === 'Network.responseReceived') {
    const r = reqs.get(m.params.requestId);
    if (r) done.push({ ...r, status: m.params.response.status });
  }
  if (m.method === 'Network.loadingFailed') {
    const r = reqs.get(m.params.requestId);
    if (r) done.push({ ...r, status: 'FAILED: ' + (m.params.errorText || '?') });
  }
});
const send = (method, params = {}) => {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise(r => pend.set(i, r));
};
const ev = async x => (await send('Runtime.evaluate',
  { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Network.enable');
await send('Runtime.enable');
await sleep(22000);

console.log('\n======== 跨域请求的真实结果（跑在', URL_, '） ========');
if (!done.length) console.log('  一个都没抓到');
for (const d of done) {
  console.log(`  ${String(d.status).padEnd(14)} ${d.host.padEnd(32)} Referer=${d.referer}`);
}

console.log('\n======== 页面渲染结果 ========');
console.log('  情报流渲染条数 :', await ev("document.querySelectorAll('#newsList .ni').length"));
console.log('  News 模块      :', await ev("typeof News"));
console.log('  News 已载条数  :', await ev("(typeof News!=='undefined' && News.state) ? News.state.items.length : 'n/a'"));
console.log('  情报流区块文本 :', (await ev("(document.getElementById('newsList')||{}).textContent||''") || '').trim().slice(0, 90));
console.log('  页脚构建号     :', await ev("(document.getElementById('prov')||{}).textContent||''") )
;
console.log('  顶部横幅       :', await ev("(document.querySelector('.banner')||{}).textContent || '(无)'"));
console.log('  K线状态        :', (await ev("(document.getElementById('klineState')||{}).textContent||''") || '').slice(0, 70));
console.log('  全球市场组数   :', await ev("document.querySelectorAll('#world .mgroup').length"));

ws.close(); chrome.kill(); process.exit(0);
