/* 验证 AI 复盘区块在页面上的渲染。
   用法：node tools/test_ai_render.mjs <页面URL> */
const PORT = 9349;
const URL_ = process.argv[2] || 'http://127.0.0.1:8792/';

const { spawn } = await import('node:child_process');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-air', URL_
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
let id = 0; const pend = new Map(); const logs = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
  }
});
const send = (method, params = {}) => {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise(r => pend.set(i, r));
};
const ev = async x => (await send('Runtime.evaluate',
  { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Runtime.enable');
for (let i = 0; i < 30; i++) {
  if ((await ev("document.querySelectorAll('#newsList .ni').length")) > 0) break;
  await sleep(1000);
}
await sleep(2000);

const shown = await ev("document.getElementById('ai') && !document.getElementById('ai').hidden");
console.log('\n======== AI 复盘区块渲染结果（', URL_, '）========');
console.log('  区块显示     :', shown ? '✓ 显示' : '✗ 隐藏（说明没读到 data/ai_digest.json）');
console.log('  头部信息     :', await ev("((document.querySelector('#ai .ai-h')||{}).textContent||'(无)').replace(/\\s+/g,' ')"));
console.log('  段落数       :', await ev("document.querySelectorAll('#ai p').length"));
console.log('  加粗标记     :', await ev("document.querySelectorAll('#ai b').length"), '处');
console.log('  正文开头     :', (await ev("((document.querySelector('#ai p')||{}).textContent||'').slice(0,72)") || '(空)') + '…');
console.log('  数据提示行   :', (await ev("((document.querySelectorAll('#ai p.dim2')[0]||{}).textContent||'(无)').slice(0,56)") ));
console.log('  控制台异常   :', logs.length ? logs.slice(0, 3).join(' | ') : '无');

ws.close(); chrome.kill(); process.exit(shown ? 0 : 1);
