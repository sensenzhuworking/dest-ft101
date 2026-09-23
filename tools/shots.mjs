/* 用 CDP 截图。之前用 --screenshot 直接命令行会挂起（配置文件锁），
   走调试协议反而稳定。用法：node tools/shots.mjs <baseUrl> <outDir> */
const PORT = 9341;
const base = process.argv[2] || 'http://127.0.0.1:8791/';
const outDir = process.argv[3] || '/tmp';

const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const path = await import('node:path');

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  // ⚠ --no-proxy-server 不能删：本机 HTTPS_PROXY=127.0.0.1:51990 会被 Chrome 当系统代理，
  // 连 127.0.0.1:8791 都走代理 → 截出来的是 chrome-error 页。
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--no-proxy-server',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-shots', 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

let wsUrl;
for (let i = 0; i < 50; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(300);
}
if (!wsUrl) { console.error('CDP 未就绪'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise(r => pending.set(i, r));
};

await send('Runtime.enable');

const shots = [
  { file: '01-桌面总览.png',        url: base,             w: 1680, h: 1500, mobile: false },
  { file: '02-全球市场-11组.png',   url: base + '#w=MA0',  w: 1680, h: 2600, mobile: false },
  { file: '03-情报流与情报分析.png', url: base,             w: 1680, h: 1500, mobile: false, scrollTo: '#newsList' },
  { file: '04-移动端390px.png',     url: base,             w: 390,  h: 1400, mobile: true },
  { file: '05-终端模式.png',        url: base + '#term',   w: 1680, h: 880,  mobile: false }
];

for (const s of shots) {
  await send('Emulation.setDeviceMetricsOverride',
    { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: s.mobile });
  await send('Page.navigate', { url: s.url });
  await sleep(17000);
  if (s.scrollTo) {
    await send('Runtime.evaluate', {
      expression: `(()=>{const e=document.querySelector('${s.scrollTo}');if(e)e.scrollIntoView({block:'start'});window.scrollBy(0,-120);})()`
    });
    await sleep(1200);
  }
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = path.join(outDir, s.file);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  console.log(s.file, '->', Math.round(fs.statSync(file).size / 1024) + ' KB');
}

ws.close();
chrome.kill();
process.exit(0);
