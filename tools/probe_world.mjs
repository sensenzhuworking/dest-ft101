/* 直接调用 Desk.world()，把每个源的错误摊开看。
   用法：node tools/probe_world.mjs <页面URL> */
const PORT = 9350;
const URL_ = process.argv[2] || 'http://127.0.0.1:8792/';

const { spawn } = await import('node:child_process');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-pw', URL_
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
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'THROW: ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0];
  return r.result?.result?.value;
};
await send('Runtime.enable');
await sleep(14000);

console.log('\n======== 逐个源单独试（绕开缓存，直接看错误）========');
console.log('腾讯   :', await ev("Desk.txQuotes(['sh000001']).then(q=>q&&q.sh000001?('上证 '+q.sh000001.value):'返回空').catch(e=>'ERR '+e.message)"));
console.log('CNBC  :', await ev("Desk.cnbcQuotes(['US10Y']).then(q=>q&&q.US10Y?('US10Y '+q.US10Y.value):'返回空').catch(e=>'ERR '+e.message)"));
console.log('仓单  :', await ev("Desk.emStock(['TA']).then(q=>q&&q.TA?('TA '+q.TA.zh+' 张'):'返回空').catch(e=>'ERR '+e.message)"));
console.log('web() :', await ev("Desk.world().then(r=>'组数 '+r.groups.length+' · 错误 ['+r.errs.join(' | ')+']').catch(e=>'ERR '+e.message)"));

console.log('\n======== 页面上 global 面板的实际状态 ========');
console.log('  分组数    :', await ev("document.querySelectorAll('#world .mgroup').length"));
console.log('  面板文本  :', (await ev("(document.getElementById('world')||{}).textContent||''")).replace(/\s+/g, ' ').slice(0, 90));
console.log('  worldNote :', await ev("(document.getElementById('worldNote')||{}).textContent"));

ws.close(); chrome.kill(); process.exit(0);
