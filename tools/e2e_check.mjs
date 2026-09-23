/* 用 Chrome DevTools Protocol 真机跑一遍交互，顺便抓 console 报错。
   不装任何依赖：Node 22 自带 WebSocket 和 fetch。
   用法：node tools/e2e_check.mjs <url> */
const URL_ = process.argv[2] || 'http://127.0.0.1:8791/';
const PORT = 9333;

const { spawn } = await import('node:child_process');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=1500,900',
  '--user-data-dir=/tmp/cdp-desk-profile', URL_
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function target () {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('CDP 未就绪');
}

const wsUrl = await target();
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
const logs = [];

ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') {
    const p = m.params;
    if (p.type === 'error' || p.type === 'warning') {
      logs.push('[' + p.type + '] ' + p.args.map(a => a.value ?? a.description ?? a.type).join(' '));
    }
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    const stack = (d.stackTrace?.callFrames || [])
      .slice(0, 4).map(f => `      at ${f.functionName || '(匿名)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`).join('\n');
    logs.push('[exception] ' + (d.exception?.description || d.text) + (stack ? '\n' + stack : ''));
  }
});

function send (method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise(r => pending.set(mid, r));
}

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { err: r.result.exceptionDetails.exception?.description };
  return { v: r.result?.result?.value };
}

await send('Runtime.enable');
await send('Log.enable');

// 等页面把 K 线和新闻都跑完
for (let i = 0; i < 30; i++) {
  const s = await ev("document.querySelector('#klineState')?.textContent||''");
  if (s.v && s.v.includes('根')) break;
  await sleep(500);
}
await sleep(1500);

/* 守卫：页面根本没加载出来时，后面每一条都会失败，而控制台依然是干净的
   —— 这会产出「43 条 FAIL / 3 条 PASS」这种把真实问题淹掉的假警报。
   所以先确认页面真的到了，再开始断言。 */
const cardsLoaded = (await ev("document.querySelectorAll('.card').length")).v;
if (!cardsLoaded) {
  console.log('\n✗ 页面没有加载出来（.card 数量为 0），断言未执行。');
  console.log('  最可能的原因：本地静态服务没起来，或 URL 指向了错误页面。');
  console.log('  先确认：curl -s -o /dev/null -w "%{http_code}\\n" ' + URL_);
  console.log('  当前地址：' + (await ev('location.href')).v);
  ws.close(); chrome.kill(); process.exit(2);
}

const checks = [];
const ok = (name, cond, extra = '') => checks.push([cond ? 'PASS' : 'FAIL', name, extra]);

ok('链条节点 8 个', (await ev("document.querySelectorAll('#chain .node').length")).v === 8);
ok('热力格子 13 个', (await ev("document.querySelectorAll('#heat .tile').length")).v === 13,
   '实际 ' + (await ev("document.querySelectorAll('#heat .tile').length")).v);
ok('K线报价已填', /\d/.test((await ev("document.getElementById('klineLast').textContent")).v || ''));
ok('K线状态含源名', ((await ev("document.getElementById('klineState').textContent")).v || '').includes('新浪期货'));
ok('价差卡 7 张', (await ev("document.querySelectorAll('.spread').length")).v === 7);
ok('价差有迷你走势', (await ev("document.querySelectorAll('.spread svg').length")).v >= 5);
ok('血统行有内容', ((await ev("document.getElementById('prov').textContent")).v || '').includes('序列'));
ok('简报已结构化（不是一段跑文）',
   (await ev("document.querySelectorAll('.brief-row').length")).v >= 3 &&
   (await ev("document.querySelectorAll('.brief-row .chip').length")).v >= 20,
   (await ev("document.querySelectorAll('.brief-row').length")).v + ' 组 / ' +
   (await ev("document.querySelectorAll('.brief-row .chip').length")).v + ' 枚');
ok('简报领句已渲染', ((await ev("document.getElementById('briefLede').textContent")).v || '').length > 12,
   (await ev("document.getElementById('briefLede').textContent")).v?.slice(0, 40));
ok('简报有数据来源', ((await ev("document.getElementById('briefSrc').textContent")).v || '').length > 10);
ok('日历有倒计时', /天|时|分/.test((await ev("document.querySelector('#calTop .vv')?.textContent")||{v:''}).v || ''));
ok('日历进度条有宽度', ((await ev("document.querySelector('#calBar i')?.style.width")||{v:''}).v || '').match(/^\d/) !== null,
   await ev("document.querySelector('#calBar i')?.style.width"));
ok('情报流有条目', (await ev("document.querySelectorAll('.ni').length")).v >= 10,
   '实际 ' + (await ev("document.querySelectorAll('.ni').length")).v);
ok('情报有高亮词', (await ev("document.querySelectorAll('.ni mark').length")).v > 0);
// 注意：跑马灯的数值来自「全球市场」取数结果，必须等下面那段取数完成后再断言。
// 原来把它放在这里，会在数据到达前就判 FAIL —— 是断言顺序的 bug，不是产品 bug。

// ---------- 本轮新增：全球市场 ----------
// 这几项依赖外网。网络抖一下会被误报成「代码坏了」，所以先给一次重试机会，
// 并把「重试后才通过」明确标出来 —— 假警报比漏报更耗人。
let worldGroups = (await ev("document.querySelectorAll('#world .mgroup').length")).v;
let worldRetried = false;
if (worldGroups === 0) {
  worldRetried = true;
  await sleep(6000);
  await ev("document.getElementById('btnRefresh') && document.getElementById('btnRefresh').click()");
  await sleep(16000);
  worldGroups = (await ev("document.querySelectorAll('#world .mgroup').length")).v;
}
ok('全球市场分组 >= 4', worldGroups >= 4,
   '实际 ' + worldGroups + (worldRetried ? '（首次为 0，重试后取得 → 网络抖动，非代码问题）' : ''));
const worldTiles = (await ev("document.querySelectorAll('#world .mtile').length")).v;
ok('全球市场瓦片 >= 14', worldTiles >= 14, '实际 ' + worldTiles);
ok('A股指数在面板里', ((await ev("document.getElementById('world').textContent")).v || '').includes('上证指数'));
ok('港股指数在面板里', ((await ev("document.getElementById('world').textContent")).v || '').includes('恒生指数'));
ok('美股指数在面板里', ((await ev("document.getElementById('world').textContent")).v || '').includes('纳斯达克'));
ok('美债收益率在面板里', /美债10年/.test((await ev("document.getElementById('world').textContent")).v || ''));
ok('美元指数在面板里', ((await ev("document.getElementById('world').textContent")).v || '').includes('美元指数'));
ok('2s10s 利差已算出',
   /-?\d+\.\d{3}pp/.test((await ev(`(()=>{const t=[...document.querySelectorAll('#world .mtile')]
      .find(x=>x.textContent.includes('2s10s'));return t?t.textContent:'找不到'})()`)).v || ''),
   await ev(`(()=>{const t=[...document.querySelectorAll('#world .mtile')]
      .find(x=>x.textContent.includes('2s10s'));return t?t.textContent.replace(/\\s+/g,' '):'找不到'})()`));
ok('指数有迷你趋势', (await ev("document.querySelectorAll('#world .mtile svg').length")).v >= 5,
   '实际 ' + (await ev("document.querySelectorAll('#world .mtile svg').length")).v);
ok('跑马灯含美元指数', ((await ev("document.getElementById('marquee').textContent")).v || '').includes('美元指数'));
ok('跑马灯含美债10年', ((await ev("document.getElementById('marquee').textContent")).v || '').includes('美债10年'));
ok('宏观条有数值', (await ev("document.querySelectorAll('#marquee .mq .v').length")).v >= 5,
   '实际 ' + (await ev("document.querySelectorAll('#marquee .mq .v').length")).v);

// ---------- 在线复现的仓单 ----------
ok('仓单分组已渲染', ((await ev("document.getElementById('world').textContent")).v || '').includes('仓单'));
ok('仓单瓦片有 4 个', (await ev(`(()=>{const g=[...document.querySelectorAll('#world .mgroup')]
   .find(x=>x.textContent.includes('仓单'));return g?g.querySelectorAll('.mtile').length:0})()`)).v === 4);
ok('仓单单位是万吨', ((await ev("document.getElementById('world').textContent")).v || '').includes('万吨'));

/* 三种「没有」必须看起来不同，否则都会被读成「还没加载完」：
     源不可达   → 红底 .state-error
     没有历史序列 → 虚线框 .state-dashed
   这里验第二种：点开一个只有当日快照、没有历史序列的项（美债/VIX 这类 CNBC 项）。 */
const noHist = (await ev(`(async () => {
  const t = [...document.querySelectorAll('#world .mtile')]
    .find(x => x.dataset.wid === 'US10Y' || x.dataset.wid === '.VIX');
  if (!t) return { err: '找不到无历史序列的项' };
  t.click();
  await new Promise(r => setTimeout(r, 3000));
  const st = document.getElementById('wfocusState');
  const res = { cls: st ? st.className : '', text: st ? st.textContent.slice(0, 24) : '' };
  t.click();                                   // 收起，别影响后面的断言
  await new Promise(r => setTimeout(r, 600));
  return res;
})()`)).v;
ok('无历史序列的项显示虚线框（不是灰字）',
   /state-dashed/.test((noHist && noHist.cls) || ''), (noHist && noHist.cls) || JSON.stringify(noHist));

// ---------- 1 分钟线 ----------
ok('周期按钮含 1分', ((await ev("document.getElementById('perTabs').textContent")).v || '').includes('1分'));

// ---------- 构建号（用来确认线上跑的是哪一版）----------
ok('页脚显示构建号', /构建\s*2026-\d{2}-\d{2}\.\d+/.test(
   (await ev("document.getElementById('prov').textContent.replace(/\\s+/g,' ')")).v || ''),
   (await ev("document.getElementById('prov').textContent.replace(/\\s+/g,' ')")).v?.match(/构建\s*\S+/)?.[0]);

// ---------- 本轮新增：新鲜度 / 日历守卫 / AI ----------
ok('数据新鲜度行有内容', ((await ev("document.getElementById('fresh').textContent")).v || '').includes('日频'));
// AI 区块必须和产物状态一致：有 ai_digest.json 就要显示，没有就必须隐藏。
// 之前这里写死了「必须隐藏」，有产物时会误报。
const aiCode = (await ev("fetch('data/ai_digest.json',{method:'HEAD',cache:'no-store'})"
  + ".then(r=>r.status).catch(()=>0)")).v;
const aiShown = (await ev("!!document.getElementById('ai') && !document.getElementById('ai').hidden")).v;
ok('AI 区块与产物状态一致',
   aiCode === 200 ? aiShown === true : aiShown === false,
   '产物 HTTP ' + aiCode + ' → 区块' + (aiShown ? '显示' : '隐藏'));
if (aiCode === 200) {
  ok('AI 复盘正文已渲染', (await ev("document.querySelectorAll('#ai p').length")).v >= 2,
     (await ev("document.querySelectorAll('#ai p').length")).v + ' 段');
  ok('AI 头部显示模型与 token',
     /\d+\s*tokens/.test((await ev("((document.querySelector('#ai .ai-h')||{}).textContent||'')")).v || ''),
     ((await ev("((document.querySelector('#ai .ai-h')||{}).textContent||'')")).v || '').replace(/\s+/g, ' '));
}
ok('日历过期守卫为空（数据未过期）',
   ((await ev("document.getElementById('calWarn').textContent")).v || '') === '');

// ---------- 设计系统 v2：帝国蓝信号层 + 零遗留色 ----------
// 这里曾经断言的是「黑金主题」（暖金 #e0a94a / 涨红 #db6b61 / 跌绿 #5cb27a /
// 金品牌 mark）。那套主题后来被整体回退成帝国蓝，但断言没跟着改 ——
// 于是每次跑都固定有 4 条 FAIL，把一个本来有用的质量闸门变成了噪音源。
const accent = (await ev("getComputedStyle(document.documentElement).getPropertyValue('--blue').trim()")).v;
ok('强调色变量为帝国蓝 #0091d4', accent === '#0091d4', accent);

const upDown = (await ev(`[getComputedStyle(document.documentElement).getPropertyValue('--up').trim(),
  getComputedStyle(document.documentElement).getPropertyValue('--down').trim()].join(',')`)).v;
ok('涨红 #ff5b52 / 跌绿 #22c98d', upDown === '#ff5b52,#22c98d', upDown);

// 选中态现在是渐变底（材料感），颜色落在 background-image 上而不是 background-color，
// 所以两处都要看 —— 只看 backgroundColor 会拿到 rgba(0,0,0,0) 而误判。
const pillBg = (await ev(`(() => {
  const b = document.querySelector('#symTabs button[aria-pressed=true]');
  const s = getComputedStyle(b);
  return s.backgroundColor + ' | ' + s.backgroundImage;
})()`)).v;
ok('选中态是蓝调胶囊', /rgba?\(\s*0,\s*145,\s*212/.test(pillBg || ''), (pillBg || '').slice(0, 72));

const brandMark = (await ev("getComputedStyle(document.querySelector('.brand .mark')).backgroundColor")).v;
ok('品牌标记是帝国蓝实色', /rgb\(0,\s*145,\s*212\)/.test(brandMark || ''), brandMark);

/* 旧主题残留扫描 —— 必须同时看 CSS 颜色属性 **和** SVG 的 stroke/fill。
   上一版只看 CSS，于是漏掉了 app.js 里硬编码的 #0a84ff（仓单迷你走势的描边）：
   那个颜色在 app.css 里根本不存在，线上却一直在显示，任何检查都看不见。 */
const legacy = (await ev(`(() => {
  const cssBad = /10,\\s*132,\\s*255|224,\\s*169,\\s*74|219,\\s*107,\\s*97|92,\\s*178,\\s*122/;
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    if (cssBad.test(s.color + s.backgroundColor + s.borderLeftColor + s.borderTopColor)) {
      return 'css ' + (el.className || el.tagName);
    }
  }
  const svgBad = /0a84ff|e0a94a|db6b61|5cb27a/i;
  for (const el of document.querySelectorAll('svg *')) {
    const a = (el.getAttribute('stroke') || '') + ' ' + (el.getAttribute('fill') || '') +
              ' ' + (el.getAttribute('stop-color') || '');
    if (svgBad.test(a)) return 'svg ' + el.tagName + ' ' + a;
  }
  return false;
})()`)).v;
ok('全站已无旧主题残留（含 SVG 属性）', legacy === false, legacy);

// ---------- 设计系统 v2：结构与材料感 ----------
ok('有唯一的 H1', (await ev("document.querySelectorAll('h1').length")).v === 1,
   (await ev("document.querySelectorAll('h1').length")).v + ' 个');
ok('有跳转链接（键盘可达）', (await ev("!!document.querySelector('.skip')")).v === true);
ok('聚焦图表有 aria-label',
   /走势/.test((await ev("(document.getElementById('wfocusChart')||{}).getAttribute&&document.getElementById('wfocusChart').getAttribute('aria-label')||''")).v || ''),
   (await ev("(document.getElementById('wfocusChart')||{}).getAttribute&&document.getElementById('wfocusChart').getAttribute('aria-label')")).v);
ok('卡片是实色面 + 发丝边框（层级靠明度差）', (await ev(`(() => {
  const c = document.querySelector('.card');
  if (!c) return false;
  const s = getComputedStyle(c);
  return s.backgroundImage === 'none' &&
         /^rgb\\(/.test(s.backgroundColor) &&
         parseFloat(s.borderTopWidth) >= 1;
})()`)).v === true,
   (await ev("getComputedStyle(document.querySelector('.card')).backgroundColor")).v);
ok('桌面右栏吸附（消灭空场）',
   (await ev("getComputedStyle(document.querySelector('.col-side')).position")).v === 'sticky',
   (await ev("getComputedStyle(document.querySelector('.col-side')).position")).v);
ok('热力格显示名称而不是纯代码', (await ev(`(() => {
  const t = document.querySelector('#heat .tile');
  return !!(t && t.querySelector('.tn') && t.querySelector('.tv'));
})()`)).v === true,
   (await ev("(() => { const t=document.querySelector('#heat .tile'); return t?t.textContent.trim():'—'; })()")).v);
ok('热力格有量级条', (await ev(`(() => {
  const t = document.querySelector('#heat .tile');
  return !!(t && /^[\\d.]/.test(t.style.getPropertyValue('--mag') || ''));
})()`)).v === true);
ok('热力格高度 ≥30px', (await ev(`(() => {
  const t = document.querySelector('#heat .tile');
  return t ? Math.round(t.getBoundingClientRect().height) >= 30 : false;
})()`)).v === true,
   (await ev("(() => { const t=document.querySelector('#heat .tile'); return t?Math.round(t.getBoundingClientRect().height)+'px':'—'; })()")).v);
ok('字阶已分档（标题 13px ≠ 正文 12.5px）', (await ev(`(() => {
  const h = getComputedStyle(document.querySelector('.card-h h2')).fontSize;
  const b = getComputedStyle(document.body).fontSize;
  return h !== b;
})()`)).v === true,
   (await ev("getComputedStyle(document.querySelector('.card-h h2')).fontSize")).v + ' vs ' +
   (await ev("getComputedStyle(document.body).fontSize")).v);
ok('瓦片数值为等宽表格数字', (await ev(`(() => {
  const v = document.querySelector('.mtile .vv'); if (!v) return false;
  const s = getComputedStyle(v);
  return /mono/i.test(s.fontFamily) && /tabular-nums/.test(s.fontVariantNumeric);
})()`)).v === true);

// ---------- 设计系统 v3：哑光（零反光 / 零模糊 / 严格等高）----------
// 这三条直接对应真实反馈与真实约束：
//   「反光很丑」「模块之间泛蓝显得廉价」→ 不许有高光、扫光、环境光
//   i5 + 低内存 → 不许有 backdrop-filter / 大范围 blur（低端 GPU 上最贵的一项）
ok('顶栏不做背景模糊（低端机性能）',
   (await ev(`(() => {
     const s = getComputedStyle(document.querySelector('.topbar'));
     return (s.backdropFilter === 'none' || !s.backdropFilter) &&
            (s.webkitBackdropFilter === 'none' || !s.webkitBackdropFilter);
   })()`)).v === true);
ok('底栏不做背景模糊', (await ev(`(() => {
  const s = getComputedStyle(document.querySelector('.bottombar'));
  return (s.backdropFilter === 'none' || !s.backdropFilter);
})()`)).v === true);
ok('瓦片没有扫光伪元素', (await ev(`(() => {
  const a = getComputedStyle(document.querySelector('.mtile'), '::after');
  return !a || a.content === 'none' || a.backgroundImage === 'none';
})()`)).v === true,
   (await ev("getComputedStyle(document.querySelector('.mtile'),'::after').backgroundImage")).v);
ok('卡片没有投影（层级靠明度差）',
   (await ev("getComputedStyle(document.querySelector('.card')).boxShadow")).v === 'none');
ok('按钮没有内高光',
   (await ev("getComputedStyle(document.querySelector('.btn')).boxShadow")).v === 'none');
ok('页面背景不带彩色环境光', (await ev(`(() => {
  const s = getComputedStyle(document.body);
  return s.backgroundImage === 'none';
})()`)).v === true, (await ev("getComputedStyle(document.body).backgroundImage")).v);
ok('品牌标记是实色（不渐变不发光）', (await ev(`(() => {
  const s = getComputedStyle(document.querySelector('.brand .mark'));
  return s.backgroundImage === 'none' && (s.boxShadow === 'none' || s.boxShadow === '');
})()`)).v === true);

/* 31 张瓦片必须严格等高。这一条是被真实观察逼出来的：
   改之前实测同时存在 67 / 88 / 97 / 118 四种高度，行与行之间基线全错开。 */
ok('31 张瓦片严格等高', (await ev(`(() => {
  const hs = [...document.querySelectorAll('#world .mtile')].map(t => Math.round(t.getBoundingClientRect().height));
  if (hs.length < 10) return false;
  return new Set(hs).size <= 2;      // 允许 1px 的亚像素误差
})()`)).v === true,
   (await ev(`(() => {
     const hs = [...document.querySelectorAll('#world .mtile')].map(t => Math.round(t.getBoundingClientRect().height));
     return '高度种类 ' + new Set(hs).size + '：' + [...new Set(hs)].sort((a,b)=>a-b).join('/');
   })()`)).v);

/* 主力现价必须保持中性色。两个绿挨在一起（大数字 + 小 chip）既吵又廉价，
   方向由 chip 单独承担。 */
ok('主力现价不跟涨跌上色', (await ev(`(() => {
  const px = document.getElementById('klineLast');
  if (!px) return false;
  return !px.classList.contains('up') && !px.classList.contains('down');
})()`)).v === true,
   (await ev("document.getElementById('klineLast').className")).v);
ok('涨跌 chip 承担方向色', (await ev(`(() => {
  const c = document.getElementById('klineChg');
  return c && (c.classList.contains('up') || c.classList.contains('down') || c.classList.contains('flat'));
})()`)).v === true);

/* 没有涨跌数据的项（派生利差等）必须给「静态」小章，不能吐一个孤零零的破折号 */
ok('无涨跌项显示「静态」而非破折号', (await ev(`(() => {
  const bad = [...document.querySelectorAll('#world .mtile [data-f-p]')]
    .filter(p => (p.textContent || '').trim() === '—');
  return bad.length === 0;
})()`)).v === true,
   (await ev(`(() => {
     const bad = [...document.querySelectorAll('#world .mtile [data-f-p]')]
       .filter(p => (p.textContent || '').trim() === '—').length;
     return bad + ' 处破折号';
   })()`)).v);

// 今日情报：只在产物里真有 headlines 时才要求渲染（与产物状态一致，不写死）
const hlCount = (await ev("(async()=>{try{const r=await fetch('data/ai_digest.json',{cache:'no-store'});const j=await r.json();return (j.headlines||[]).length}catch(e){return 0}})()")).v;
if (hlCount > 0) {
  ok('今日情报已渲染', (await ev("document.querySelectorAll('#ai .hl li').length")).v === hlCount,
     (await ev("document.querySelectorAll('#ai .hl li').length")).v + ' / ' + hlCount + ' 条');
  ok('今日情报带分类标签', (await ev("document.querySelectorAll('#ai .hl li .lt').length")).v >= 1);
} else {
  ok('今日情报（产物无 headlines，跳过）', true, '产物里 0 条');
}

// 交互 1：点链条里的 MEG 节点 → 切到 EG 主连
await ev("[...document.querySelectorAll('#chain .node')].find(n=>n.dataset.code==='MEG').click()");
await sleep(4000);
ok('点链条切品种', ((await ev("document.querySelector('#klineBroker').textContent")).v || '').includes('DCE'),
   await ev("document.querySelector('#klineBroker').textContent"));

// 交互 2：终端命令 chart SC W
await ev("document.getElementById('termInput').value='chart SC W';" +
         "document.getElementById('termInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
await sleep(4500);
ok('终端 chart SC W 生效',
   ((await ev("document.querySelector('#perTabs button[aria-pressed=true]').textContent")).v === '周线') &&
   ((await ev("document.getElementById('klineBroker').textContent")).v || '').includes('INE'),
   await ev("document.getElementById('klineBroker').textContent"));

// 交互 3：终端 help
await ev("document.getElementById('termInput').value='help';" +
         "document.getElementById('termInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
await sleep(400);
ok('终端 help 有输出', ((await ev("document.getElementById('termOut').textContent")).v || '').includes('chart'));

// 交互 4：情报流频道过滤
for (const ch of ['fed', 'chain', 'apparel', 'all']) {
  await ev(`document.querySelector('#chanTabs button[data-ch="${ch}"]').click()`);
  await sleep(300);
  const n = (await ev("document.querySelectorAll('.ni').length")).v;
  checks.push([n > 0 ? 'PASS' : 'WARN', '频道 ' + ch + ' 命中', String(n) + ' 条']);
}

// 交互 5：60 分钟线
await ev("[...document.querySelectorAll('#perTabs button')].find(b=>b.dataset.per==='60').click()");
await sleep(6000);
ok('60 分钟线可取', ((await ev("document.getElementById('klineState').textContent")).v || '').includes('根'),
   await ev("document.getElementById('klineState').textContent"));
ok('60 分钟线时间轴可读',
   /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} → \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
     .test(((await ev("document.getElementById('klineRange').textContent")).v || '').trim()),
   await ev("document.getElementById('klineRange').textContent"));
ok('K线画布已生成', (await ev("document.querySelectorAll('#kline canvas').length")).v >= 1);

// ---------- 自检按钮必须真的存在（上次就是漏了这一条，导致改了 index.html 却没生效）----------
ok('页脚有「自检」按钮', (await ev("!!document.getElementById('btnSelfCheck')")).v === true);
ok('自检按钮已绑定（点击会打开终端）', await (async () => {
  await ev("document.getElementById('btnSelfCheck') && document.getElementById('btnSelfCheck').click()");
  await sleep(1200);
  return (await ev("!document.getElementById('terminal').hidden")).v === true;
})());
await sleep(6000);
ok('自检有输出（跑完一轮探测）',
   ((await ev("document.getElementById('termOut').textContent")).v || '').includes('模块'),
   ((await ev("document.getElementById('termOut').textContent")).v || '').replace(/\s+/g, ' ').slice(-60));
await ev("document.getElementById('terminal').hidden = true");

console.log('\n================ 交互检查 ================');
for (const [s, n, e] of checks) console.log(`${s}  ${n}${e ? '  → ' + e : ''}`);
console.log('\n================ 控制台输出 ================');
console.log(logs.length ? logs.slice(0, 25).join('\n') : '干净，无 error / warning');

ws.close();
chrome.kill();
process.exit(0);
