/* 情报流刷新行为的回归测试
   原 bug：轮询复用了「往更早翻页」的游标，导致每次刷新都往回抓旧闻，
          列表顶部永远不变（用户反馈「刷新了但没有新消息」）。
   本测试断言：刷新【不】推进游标，且刷新后顶部条目的时间【不】变旧。 */
const PORT = 9342;
const URL_ = process.argv[2] || 'http://127.0.0.1:8792/';

const { spawn } = await import('node:child_process');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-newsfix', URL_
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

// 等首次加载完成
for (let i = 0; i < 40; i++) {
  const n = await ev("document.querySelectorAll('.ni').length");
  if (n > 0) break;
  await sleep(500);
}
await sleep(1500);

const results = [];
const ok = (name, cond, extra = '') => results.push([cond ? 'PASS' : 'FAIL', name, extra]);

const top = () => ev("(()=>{const a=document.querySelector('#newsList .ni .t');return a?a.textContent.replace(/\\s+/g,' ').trim():''})()");
const count = () => ev("document.querySelectorAll('.ni').length");
const sortEnd = () => ev("News.state.sortEnd");
const lastNew = () => ev("News.state.lastNew");

const t0 = await top();
const n0 = await count();
const se0 = await sortEnd();
ok('首屏有新闻', n0 > 0, '条数 ' + n0);

// --- 1. 点「更早」：游标必须推进，条数必须增加（原有功能不能被我不小心弄坏）---
await ev("document.getElementById('btnMore').click()");
await sleep(4000);
const se1 = await sortEnd();
const n1 = await count();
ok('「更早」会推进游标', se1 && se1 !== se0, 'sortEnd: ' + se0 + ' → ' + se1);
ok('「更早」会增加条数', n1 > n0, n0 + ' → ' + n1);

// --- 2. 刷新（轮询走的同一条路径）：游标必须【不动】---
const r1 = await ev("News.refresh().then(n=>n).catch(e=>'ERR '+e.message)");
const se2 = await sortEnd();
ok('刷新不推进游标（原 bug 的根因）', se2 === se1, 'sortEnd 仍为 ' + se2);

// --- 3. 刷新后顶部条目的时间不能变旧 ---
const ageOf = s => {
  const d = new Date(new Date().toDateString() + ' ' + s);
  if (isNaN(d)) return null;
  let t = d.getTime();
  if (t - Date.now() > 12 * 3600e3) t -= 86400e3;   // 跨零点
  return t;
};
const t2 = await top();
const a1 = ageOf(t0), a2 = ageOf(t2);
const parts = s => s.split(' ').filter(x => /:/.test(x)).pop() || '';
ok('刷新后顶部不变旧', a1 === null || a2 === null || a2 >= a1,
   '刷新前 ' + parts(t0) + ' → 刷新后 ' + parts(t2));
ok('刷新返回了新增条数', typeof r1 === 'number', '本次新增 ' + r1 + ' 条 · lastNew=' + (await lastNew()));

// --- 4. 新条目应带「新」标记（若有新增）---
const badges = await ev("document.querySelectorAll('.ni .t .new').length");
ok('新增条目带「新」标记', (r1 > 0 ? badges > 0 : true), '标记数 ' + badges + ' / 新增 ' + r1);

// --- 5. 等一个轮询周期（演示用，可跳过）---
if (process.argv[3] === '--wait') {
  console.log('\n  启动 45 秒轮询，观察是否真的会冒出带「新」标记的条目…');
  const before = await top();
  await sleep(100000);
  const after = await top();
  console.log('    轮询前顶部：' + before);
  console.log('    轮询后顶部：' + after);
  console.log('    是否变化：' + (before !== after ? '是 → 轮询确实在刷新' : '否 → 这段时间确实没有新新闻'));
}

console.log('\n============ 情报流刷新回归测试 ============');
for (const [s, n, e] of results) console.log(`${s}  ${n}${e ? '  → ' + e : ''}`);
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}`);
console.log('\n前 3 条：');
console.log(await ev("[...document.querySelectorAll('#newsList .ni')].slice(0,3).map(x=>x.textContent.replace(/\\s+/g,' ').trim().slice(0,60)).join('\\n')"));

ws.close(); chrome.kill(); process.exit(failed ? 1 : 0);
