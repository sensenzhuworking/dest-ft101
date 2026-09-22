/* 在线上站点跑一遍 doctor 自检，并把结果与截图存下来。
   用法：node tools/live_doctor.mjs <线上URL> <截图输出目录> */
const PORT = 9347;
const URL_ = process.argv[2];
const OUT = process.argv[3] || '/tmp';
if (!URL_) { console.error('需要线上 URL'); process.exit(1); }

const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const path = await import('node:path');

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1600,1200',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-doctor', URL_
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
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise(r => pend.set(i, r));
};
const ev = async x => (await send('Runtime.evaluate',
  { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Runtime.enable');
// 等首屏稳定
for (let i = 0; i < 40; i++) {
  if ((await ev("document.querySelectorAll('#newsList .ni').length")) > 0) break;
  await sleep(1000);
}
await sleep(1500);

// 通过终端跑 doctor（按钮在 index.html 里，可能没传上去；命令本身在 app.js 里）
await ev("document.getElementById('termInput')"
  + ".dispatchEvent(new KeyboardEvent('keydown',{key:'/'}))");
await ev(`(()=>{const i=document.getElementById('termInput');i.value='doctor';
   i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
await sleep(12000);

const txt = await ev("document.getElementById('termOut').textContent.replace(/\\n{2,}/g,'\\n').trim()");
console.log('\n======== 线上站点的自检输出（按 / 然后输 doctor）========\n');
console.log(txt || '(没拿到输出)');

// 收起终端再截图，得到干净的一屏
await ev("document.getElementById('terminal').hidden = true");
await sleep(1200);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
const f = path.join(OUT, '05-线上实际效果.png');
fs.writeFileSync(f, Buffer.from(shot.result.data, 'base64'));
console.log('\n截图已存:', f, Math.round(fs.statSync(f).size / 1024) + ' KB');

ws.close(); chrome.kill(); process.exit(0);
