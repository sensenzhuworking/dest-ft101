/* ==========================================================================
   app.js — 编排：K 线、产业链、价差、全球市场、热力图、血统、新鲜度、
            日历、AI 复盘、终端模式、自动刷新
   ========================================================================== */
'use strict';

(() => {

  const $ = id => document.getElementById(id);
  const pad2 = n => String(n).padStart(2, '0');

  const S = {
    desk: null,
    sym: 'PTA',
    period: 'D',
    bars: [],
    loading: false,
    world: null,
    ai: null,
    lastNewsCount: 0,
    timers: []
  };

  /* ======================================================================
     1. K 线
     ====================================================================== */

  function renderSymTabs () {
    $('symTabs').innerHTML = KLINE_ORDER.map(code => {
      const label = (S.desk.chart_map[code] || {}).label || code;
      return '<button class="pill" type="button" data-sym="' + code + '" aria-pressed="' +
             (code === S.sym) + '">' + esc(label) + '</button>';
    }).join('');
  }

  function renderPerTabs () {
    $('perTabs').innerHTML = PERIODS.map(p =>
      '<button class="pill" type="button" data-per="' + p.id + '" aria-pressed="' +
      (p.id === S.period) + '">' + p.label + '</button>').join('');
  }

  async function loadKline (buster = false) {
    if (S.loading) return;
    S.loading = true;
    $('klineState').innerHTML = '正在拉取 <b>' + S.sym + '</b> ' +
      (PERIODS.find(p => p.id === S.period) || {}).label + ' …';
    try {
      const { bars, from } = await Desk.kline(S.sym, S.period, { buster });
      if (!bars.length) throw new Error('空数据');
      S.bars = bars;
      const pdef = PERIODS.find(p => p.id === S.period) || {};
      Charts.render($('kline'), bars, pdef.tail || 180);
      paintQuote(bars);
      const last = bars[bars.length - 1];
      $('klineState').innerHTML =
        '数据 <b>' + bars.length + '</b> 根 · 最新 <b>' + esc(fmtBarTime(last.time)) + '</b> · 源 <b>新浪期货</b>' +
        (from === 'cache' ? ' · 命中本地缓存' : '') +
        ' · 日线/周线为主力连续合约，换月时价格会有跳空';
      $('klineRange').textContent = fmtBarTime(bars[0].time) + ' → ' + fmtBarTime(last.time);
      S.lastKlineAt = Date.now();
      renderFresh();
    } catch (e) {
      $('klineState').innerHTML = '取数失败：<b>' + esc(String(e.message || e)) + '</b>' +
        '（新浪源被限流时稍等再按刷新）';
    } finally {
      S.loading = false;
    }
  }

  function paintQuote (bars) {
    const last = bars[bars.length - 1], prev = bars[bars.length - 2];
    const chg = prev ? last.close - prev.close : null;
    const pct = prev && prev.close ? chg / prev.close * 100 : null;
    $('klineLast').textContent = fmtNum(last.close, 1);
    $('klineLast').className = 'px num ' + cls(chg);
    $('klineChg').textContent = chg === null ? '' : fmtSigned(chg, 1) + '  ' + fmtPct(pct);
    $('klineChg').className = 'chg num ' + cls(chg);
    const cm = S.desk.chart_map[S.sym] || {};
    const inst = (S.desk.instruments || []).find(x => x.code === S.sym) || {};
    $('klineBroker').textContent = (inst.exchange || '—') + ' · ' + (cm.sina || '');
  }

  function fmtBarTime (t) {
    if (typeof t === 'string') return t;
    const d = new Date(t * 1000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
           ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ======================================================================
     2. 产业链传导链
     ====================================================================== */

  function latestOf (code, kind) {
    const l = S.desk.latest[code];
    return l ? l[kind] : null;
  }

  function renderChain () {
    const parts = [];
    const n = S.desk.chain_order.length;
    S.desk.chain_order.forEach((node, i) => {
      const l = latestOf(node.code, node.kind);
      const pct = l ? l.chg_pct : null;
      const clickable = !!S.desk.chart_map[node.code];
      const isLast = i === n - 1;
      parts.push(
        '<button class="node ' + cls(pct).charAt(0) + (isLast ? ' end' : '') + '" type="button" ' +
        'data-code="' + node.code + '" data-fut="' + (clickable ? 1 : 0) + '" ' +
        'aria-pressed="' + (node.code === S.sym) + '" title="' + esc((l && l.basis_note) || '无注释') + '">' +
        '<span class="n">' + esc(node.name) + '</span>' +
        '<span class="p">' + (l ? fmtNum(l.value, node.code === 'SC' ? 1 : 0) : '—') + '</span>' +
        '<span class="d ' + cls(pct) + '">' + (pct === null ? '—' : fmtPct(pct)) + '</span>' +
        '</button>');
      if (!isLast) parts.push('<span class="arrow">›</span>');
    });
    $('chain').innerHTML = parts.join('');
  }

  /* ======================================================================
     3. 加工费 / 价差
     ====================================================================== */

  const SPREAD_PICK = ['PTA_PX', 'PF_COST', 'PR_COST', 'POY_PTA',
                       'PX_NAPHTHA', 'PF_FUT_PTA_FUT', 'PR_FUT_PTA_FUT'];

  function renderSpreads () {
    const keys = SPREAD_PICK.filter(k => S.desk.spreads[k]);
    $('spreads').innerHTML = keys.map(k => {
      const sp = S.desk.spreads[k], l = sp.latest || {};
      const d = cls(l.chg);
      return '<div class="spread" data-k="' + k + '" title="' + esc(sp.formula) + '">' +
        '<div class="lb">' + esc(sp.label) + '</div>' +
        '<div class="vl ' + d + '">' + fmtNum(l.value, 1) + '</div>' +
        '<div class="dl ' + d + '">' + (l.chg_pct == null ? '—'
            : fmtSigned(l.chg, 1) + ' / ' + fmtPct(l.chg_pct, 1)) + '</div>' +
        Charts.spark(sp.series.map(x => x[1]), { w: 140, h: 26, color: Charts.colorFor(l.chg) }) +
        '</div>';
    }).join('');

    $('spreads').onmouseover = e => {
      const c = e.target.closest('.spread');
      if (!c) return;
      const sp = S.desk.spreads[c.dataset.k];
      $('spreadFormula').innerHTML = '口径：<b>' + esc(sp.formula || '—') + '</b>';
    };
    $('spreadAsOf').textContent = '截至 ' + (S.desk.as_of || '—') + ' · 来自本地数据库';
    $('spreadFormula').innerHTML = '口径：<b>' +
      esc((S.desk.spreads[keys[0]] || {}).formula || '—') + '</b>';
  }

  /* ======================================================================
     4. 全球市场
     ====================================================================== */

  /** 数值显示：unit 是货币符号走前缀（$ ¥），suffix 是 % / pp 走后缀 */
  function valText (it) {
    return (it.unit || '') + fmtNum(it.value, it.digits) + (it.suffix || '');
  }

  async function renderWorld () {
    const res = await Desk.world();
    S.world = res;
    const box = $('world');

    if (!res.groups.length) {
      box.innerHTML = '<p class="state" style="border:0;margin:0">' +
        '全球行情源暂时都不可达。本地产的 K 线、加工费、热力图不受影响，' +
        '点右上角「刷新」重试。</p>';
      $('worldNote').textContent = '源不可达';
      renderMarquee([]);
      renderFresh();
      return;
    }

    box.innerHTML = res.groups.map(g => {
      const tiles = g.items.map(it => {
        const spark = it.spark && it.spark.length > 3
          ? Charts.spark(it.spark, { w: 130, h: 24, color: Charts.colorFor(it.pct) })
          : '';
        return '<div class="mtile ' + cls(it.pct) + '">' +
          '<div class="nm" title="' + esc((it.note ? it.note + ' · ' : '') + (it.src || '') +
            (it.ts ? ' · ' + new Date(it.ts).toLocaleString('zh-CN', { hour12: false }) : '')) + '">' +
            esc(it.label) + '</div>' +
          '<div class="row"><span class="vv">' + esc(valText(it)) + '</span>' +
          (it.pct == null && it.chg != null
            ? '<span class="pc ' + cls(it.chg) + '">' + fmtSigned(it.chg, it.digits) + '</span>'
            : '<span class="pc ' + cls(it.pct) + '">' + fmtPct(it.pct, 2) + '</span>') + '</div>' +
          spark +
          (it.live ? '' : '<div class="ft">日终 ' + esc(it.asOf || '') + '</div>') +
          '</div>';
      }).join('');
      return '<div class="mgroup">' +
        '<div class="mgroup-h"><span>' + esc(g.label) + '</span>' +
        '<span class="dim2">' + esc(g.note || '') + '</span><span class="rule"></span></div>' +
        '<div class="mtiles">' + tiles + '</div></div>';
    }).join('');

    const liveN = res.groups.flatMap(g => g.items).filter(i => i.live).length;
    const allN = res.groups.flatMap(g => g.items).length;
    $('worldNote').innerHTML = '实时 ' + liveN + ' / 共 ' + allN + ' 项 · 更新于 ' +
      esc(new Date(res.at).toLocaleTimeString('zh-CN', { hour12: false })) +
      (res.errs.length ? ' · <span class="up">' + esc(res.errs.join('；')) + '</span>' : '');

    renderMarquee(Desk.marqueeFrom(res));
    renderFresh();
  }

  function renderMarquee (items) {
    const box = $('marquee');
    if (!items.length) {
      box.innerHTML = '<span class="mq"><span class="k">行情源暂不可达</span></span>';
      return;
    }
    box.innerHTML = items.map(r => {
      const badge = r.live
        ? '<span class="b" title="实时快照 · ' + esc(r.src || '') + '">L</span>'
        : '<span class="b d" title="' + esc((r.asOf || '') + ' 日终 · ' + (r.src || '')) + '">D</span>';
      return '<span class="mq">' + badge +
        '<span class="k">' + esc(r.label) + '</span>' +
        '<span class="v">' + esc(valText(r)) + '</span>' +
        (r.pct == null ? '' :
          '<span class="' + cls(r.pct) + '" style="font-family:var(--mono);font-size:11px">' +
          fmtPct(r.pct) + '</span>') +
        '</span>';
    }).join('');
  }

  /* ======================================================================
     5. 底部：热力图 + 血统 + 新鲜度 + 一句话总结 + AI
     ====================================================================== */

  function renderHeat () {
    const rows = [];
    for (const inst of S.desk.instruments) {
      const code = inst.code;
      const fut = latestOf(code, 'futures');
      const spot = latestOf(code, 'spot');
      const kind = fut ? 'futures' : 'spot';       // 有盘面报盘面，一个品种只出一个格子
      const pick = fut || spot;
      if (!pick) continue;
      const prov = S.desk.provenance[code + '|' + kind] || {};
      rows.push({
        code, name: inst.name_cn, pct: pick.chg_pct, value: pick.value, unit: inst.unit,
        stale: /STALE/.test(prov.quality_flag || ''), kind,
        flag: prov.quality_flag || '', n: prov.n_sources || 1
      });
    }
    rows.sort((a, b) => (b.pct == null ? -999 : b.pct) - (a.pct == null ? -999 : a.pct));
    $('heat').innerHTML = '<span class="lb">涨跌热力</span>' + rows.map(r => {
      const tip = r.name + ' · ' + (r.kind === 'futures' ? '期货主力' : '现货') +
        ' ' + fmtNum(r.value, 1) + ' ' + (r.unit || '') + ' · ' + r.n + ' 个来源' +
        (r.flag ? ' · ' + r.flag : '') + (r.stale ? ' · 数据可能滞后' : '');
      return '<button class="tile ' + cls(r.pct) + (r.stale ? ' stale' : '') + '" type="button" ' +
        'data-code="' + r.code + '" title="' + esc(tip) + '">' +
        esc(r.code) + ' ' + (r.pct == null ? '—' : fmtPct(r.pct, 1)) + '</button>';
    }).join('');
  }

  function renderProv () {
    const h = S.desk.health || {}, g = h.grades || {};
    const nConflict = Object.keys(S.desk.conflicts || {}).length;
    $('prov').innerHTML =
      '<span><i class="dot ok"></i>多源一致 ' + (g.ok || 0) + '</span>' +
      '<span><i class="dot partial"></i>多源分歧 ' + (g.partial || 0) + '</span>' +
      '<span><i class="dot single"></i>单源 ' + (g.single || 0) + '</span>' +
      '<span><i class="dot conflict"></i>源间不一致 ' + nConflict + ' 组</span>' +
      '<span>覆盖 ' + (h.series_total || 0) + ' 条序列</span>' +
      '<span>数据库 ' + esc(S.desk.db || '—') + ' · 生成 ' +
      esc((S.desk.generated_at || '').slice(0, 16).replace('T', ' ')) + '</span>' +
      '<span title="每次改代码都会 +1。上传后页脚还是旧号 = 浏览器缓存没清，或传错了路径">' +
      '构建 <b class="dim">' + esc(BUILD) + '</b></span>';
  }

  /** 数据新鲜度：每一层单独说了算，不混成一个「实时」 */
  function renderFresh () {
    const now = Date.now();
    const parts = [];
    const src = Desk.health();

    if (S.lastKlineAt) {
      parts.push('<span>期货 K 线 <b class="dim">' + S.period + '</b> 取自新浪，' +
        esc(fmtAgo(S.lastKlineAt)) + '拉取</span>');
    }
    if (S.world) {
      const live = S.world.groups.flatMap(g => g.items).filter(i => i.live).length;
      parts.push('<span>指数 / 债汇 ' + esc(fmtAgo(S.world.at)) + '拉取（' + live + ' 项实时）</span>');
    } else {
      parts.push('<span>指数 / 债汇未取到</span>');
    }
    parts.push('<span>现货·加工费·仓单为日频，截至 <b class="dim">' +
      esc(S.desk.as_of || '—') + '</b></span>');
    if (News.state.items.length) {
      const t = News.state.items[0].showTime;
      const d = t ? new Date(String(t).replace(' ', 'T')).getTime() : null;
      parts.push('<span>情报流最新 ' + esc(d ? fmtAgo(d) : '—') + '，45 秒轮询</span>');
    }
    if (src.world && src.world.errs && src.world.errs.length) {
      parts.push('<span class="up">降级中：' + esc(src.world.errs.join('；')) + '</span>');
    }
    $('fresh').innerHTML = parts.join('');
  }

  function renderSummary () {
    const s = S.desk.summary;
    if (!s) { $('summary').textContent = '本地数据库里还没有一句话总结。'; return; }
    const txt = s.summary_text || '';
    const m = txt.match(/^(\d{4}-\d{2}-\d{2} 聚酯链收盘；[^；]+；)/);
    $('summary').innerHTML = m
      ? '<b>' + esc(m[1]) + '</b>' + esc(txt.slice(m[1].length))
      : esc(txt);
  }

  /** AI 复盘：读静态 data/ai_digest.json。前端不放任何密钥。 */
  function renderAi () {
    const box = $('ai');
    const d = S.ai;
    if (!d || !d.digest) { box.hidden = true; return; }
    const tk = d.tokens || {};
    const inTok = (tk.prompt_hit != null || tk.prompt_miss != null)
      ? (tk.prompt_hit || 0) + (tk.prompt_miss || 0)
      : tk.prompt;
    box.hidden = false;
    let html = '<div class="ai-h"><span class="tag">AI 复盘</span>' +
      '<span>' + esc((d.generated_at || '').slice(0, 16).replace('T', ' ')) + '</span>' +
      '<span>' + esc(d.model || '') + '</span>' +
      (inTok ? '<span>输入 ' + inTok + ' + 输出 ' + (tk.completion || 0) + ' tokens</span>' : '') +
      (tk.cost_usd != null ? '<span>≈$' + Number(tk.cost_usd).toFixed(5) + '</span>' : '') +
      (d.peak === true ? '<span>高峰计费</span>' : '') +
      (d.cached ? '<span>本批数据已解读过，未重复调用</span>' : '') +
      '</div>';
    html += '<p>' + mdLite(d.digest) + '</p>';
    if (Array.isArray(d.drivers) && d.drivers.length) {
      html += d.drivers.map(x =>
        '<p><b>' + esc(x.code) + '</b> ' + mdLite(x.text) + '</p>').join('');
    }
    if (Array.isArray(d.warnings) && d.warnings.length) {
      html += '<p class="dim2">数据提示：' + esc(d.warnings.join('；')) + '</p>';
    }
    box.innerHTML = html;
  }

  /** 只支持 **加粗**，够用且不会引入 HTML 注入 */
  function mdLite (s) {
    return esc(String(s || '')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  }

  /* ======================================================================
     6. 日历
     ====================================================================== */

  function safeCall (fn) { try { return fn(); } catch (e) { return null; } }

  function renderCalendar () {
    const rows = CALENDAR.map(c => ({ c, t: safeCall(c.next) }))
                         .filter(x => x.t).sort((a, b) => a.t - b.t);

    // 过期守卫：硬编码日期表一旦没有未来项，就必须显式告警，而不是静默出错
    const expiring = CALENDAR.filter(c => !safeCall(c.next));
    $('calWarn').innerHTML = expiring.length
      ? '<div class="warn">日历数据需要更新：<b>' + expiring.map(c => c.label).join('、') +
        '</b> 已没有未来日期（硬编码表核对于 ' + CAL_VERIFIED_AT +
        '）。请补 config.js 里的 FOMC_DATES / EIA_HOLIDAY_SHIFT。</div>'
      : '';

    if (!rows.length) {
      $('calTop').innerHTML = '<p class="state" style="border:0;margin:0">无法推算下一次事件。</p>';
      $('calBar').innerHTML = '';
      $('calRest').innerHTML = '';
      return;
    }

    const top = rows[0];
    const left = top.t - Date.now();
    // 进度条用「上一场 → 下一场」的真实区间，比固定 30 天诚实
    const prev = safeCall(top.c.prev);
    const total = prev ? top.t - prev : (top.c.periodDays || 30) * 864e5;
    const pct = Math.max(0, Math.min(100, (1 - left / total) * 100));

    const d = new Date(top.t);
    $('calTop').innerHTML =
      '<div class="cal-row"><span class="lb">' + esc(top.c.label) + '</span>' +
      '<span class="vv">' + fmtLeft(left) + '</span></div>' +
      '<div class="cal-row"><span class="lb dim2">' +
      d.toLocaleDateString('zh-CN') + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) +
      ' 本机时间' + (prev ? ' · 本周期已过 ' + pct.toFixed(0) + '%' : '') + '</span></div>';
    $('calBar').innerHTML = '<i style="width:' + pct.toFixed(1) + '%"></i>';

    $('calRest').innerHTML = rows.slice(1, 6).map(x => {
      const dd = new Date(x.t);
      return '<div class="cal-row"><span class="lb">' + esc(x.c.label) + '</span>' +
        '<span class="dim2" style="font-size:11px">' +
        (x.c.kind === 'rule' ? '约 ' : '') + (dd.getMonth() + 1) + '/' + dd.getDate() + '</span>' +
        '<span class="vv">' + fmtLeft(x.t - Date.now()) + '</span></div>';
    }).join('');

    $('calNote').innerHTML = '标注「约」为规则推算，非官方公告；FOMC 与 EIA 用官方日历，' +
      '本表核对于 ' + CAL_VERIFIED_AT + '。核对：' +
      '<a href="' + CALENDAR[0].src + '" target="_blank" rel="noopener noreferrer" ' +
      'style="color:var(--ic);text-decoration:none">美联储</a> · ' +
      '<a href="' + CALENDAR[1].src + '" target="_blank" rel="noopener noreferrer" ' +
      'style="color:var(--ic);text-decoration:none">EIA</a>';
  }

  /* ======================================================================
     7. 时钟与交易时段
     ====================================================================== */

  function session (now) {
    const wd = now.getDay(), m = now.getHours() * 60 + now.getMinutes();
    if (wd === 0 || wd === 6) return { t: '休市', c: 'dim2' };
    if ((m >= 540 && m < 615) || (m >= 630 && m < 690) || (m >= 810 && m < 900)) return { t: '日盘', c: 'up' };
    if (m >= 1260 && m < 1380) return { t: '夜盘', c: 'up' };
    if (m < 150 && wd >= 2 && wd <= 6) return { t: '夜盘', c: 'up' };
    return { t: '休市', c: 'dim2' };
  }

  function tickClock () {
    const now = new Date();
    const s = session(now);
    $('clock').innerHTML = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' +
      pad2(now.getSeconds()) + ' <span class="' + s.c + '">' + s.t + '</span>';
  }

  /* ======================================================================
     8. 自动刷新 —— 只在页面可见时跑，别在后台空烧 CPU
     ====================================================================== */

  function every (ms, fn, name) {
    const id = setInterval(() => { if (!document.hidden) fn(); }, ms);
    S.timers.push({ id, name });
    return id;
  }

  function startTimers () {
    every(45e3, async () => {
      const n = await News.refresh();
      if (n > 0) { renderFresh(); announce('情报流新增 ' + n + ' 条'); }
    }, 'news');
    every(60e3, () => { renderWorld(); }, 'world');
    every(5 * 60e3, () => { loadKline(); }, 'kline');
    every(60e3, () => { renderCalendar(); renderFresh(); }, 'cal');
  }

  function announce (t) { const el = $('live'); if (el) el.textContent = t; }

  /* ======================================================================
     9. 终端模式
     ====================================================================== */

  const Terminal = (() => {
    let box, input, out, open = false;

    const HELP = [
      ['help', '显示这份帮助'],
      ['TA PX SC EG PF PR', '切换到对应品种的 K 线'],
      ['D 60 W', '切换周期：日线 / 60分钟 / 周线'],
      ['chart <品种> <周期>', '一步到位，例如 chart PX W'],
      ['news <频道>', 'all chain macro apparel bonds fed equity'],
      ['macro', '列出全球市场面板全部数值'],
      ['heat', '按涨跌幅重排热力图'],
      ['prov', '打印数据血统与源间冲突'],
      ['desk', '本地数据库状态与一句话总结'],
      ['ai', '打印 AI 复盘原文'],
      ['refresh', '清缓存并重新拉取全部'],
      ['clear', '清屏'],
      ['close / Esc', '关闭终端']
    ];

    function say (html, c) {
      const line = document.createElement('div');
      if (c) line.className = c;
      line.innerHTML = html;
      out.appendChild(line);
      out.scrollTop = out.scrollHeight;
    }

    function findSymbol (w) {
      const u = String(w || '').toUpperCase();
      if (S.desk.chart_map[u]) return u;
      return Object.keys(S.desk.chart_map)
        .find(k => (S.desk.chart_map[k].sina || '').replace('0', '') === u) || null;
    }

    async function run (raw) {
      const cmd = raw.trim();
      if (!cmd) return;
      say('<span class="hl">›</span> ' + esc(cmd));
      const [w0, w1, w2] = cmd.split(/\s+/);
      const c0 = (w0 || '').toLowerCase();

      if (c0 === 'help' || c0 === '?') {
        HELP.forEach(([k, v]) => say('  <span class="hl">' + esc(k.padEnd(20, ' ')) + '</span>' + esc(v)));
        return;
      }
      if (c0 === 'clear') { out.innerHTML = ''; return; }
      if (c0 === 'close' || c0 === 'exit') { hide(); return; }

      if (c0 === 'chart') {
        const sym = findSymbol(w1);
        const per = PERIODS.find(p => p.id === String(w2 || '').toUpperCase());
        if (!sym) return say('  找不到品种 ' + esc(w1 || ''), 'er');
        if (w2 && !per) return say('  周期只能是 D / 60 / W', 'er');
        if (sym !== S.sym) { S.sym = sym; selectSym(); }
        if (per && per.id !== S.period) { S.period = per.id; selectPer(); }
        say('  已切到 <span class="hl">' + sym + '</span> ' + S.period, 'ok');
        return;
      }

      if (c0 === 'news') {
        const ch = NEWS_CHANNELS.find(c => c.id === String(w1 || 'all').toLowerCase());
        if (!ch) return say('  频道不合法：' + NEWS_CHANNELS.map(c => c.id).join(' / '), 'er');
        const btn = document.querySelector('#chanTabs button[data-ch="' + ch.id + '"]');
        if (btn) btn.click();
        say('  情报流切到 <span class="hl">' + esc(ch.label) + '</span>', 'ok');
        return;
      }

      if (c0 === 'macro' || c0 === 'world') {
        if (!S.world) return say('  全球市场还没取到数据', 'er');
        for (const g of S.world.groups) {
          say('  <span class="hl">' + esc(g.label) + '</span>');
          for (const it of g.items) {
            say('    ' + esc(it.label.padEnd(14, ' ')) +
                '<span class="hl">' + esc(String(fmtNum(it.value, it.digits))).padStart(11, ' ') + '</span>' +
                '  <span class="' + cls(it.pct) + '">' + esc(fmtPct(it.pct, 2)).padStart(8, ' ') + '</span>' +
                '  <span style="opacity:.6">' + esc(it.src || '') +
                (it.live ? ' 实时' : ' 日终 ' + (it.asOf || '')) + '</span>');
          }
        }
        return;
      }

      if (c0 === 'heat') {
        const tiles = [...$('heat').querySelectorAll('.tile')];
        tiles.sort((a, b) => (parseFloat(b.textContent.split(' ')[1]) || -999) -
                             (parseFloat(a.textContent.split(' ')[1]) || -999));
        tiles.forEach(t => $('heat').appendChild(t));
        say('  已按涨跌幅重排', 'ok');
        return;
      }

      if (c0 === 'prov') {
        say('  血统：' + esc(JSON.stringify(S.desk.health)));
        for (const [k, v] of Object.entries(S.desk.conflicts || {})) {
          say('  <span class="er">冲突</span> ' + esc(k) + ' · ' + v.length + ' 组 · 最近 ' +
              esc(v[0].date) + ' ' + esc(v[0].a) + ' ' + v[0].va + ' vs ' + esc(v[0].b) + ' ' + v[0].vb);
        }
        Object.entries(S.desk.sources).forEach(([id, s]) =>
          say('  <span class="hl">' + esc(id) + '</span> [' + s.tier + '] ' + esc(s.name)));
        const h = Desk.health();
        if (h.world && h.world.errs.length) say('  <span class="er">在线源降级</span> ' + esc(h.world.errs.join('；')));
        return;
      }

      if (c0 === 'desk') {
        say('  数据库 <span class="hl">' + esc(S.desk.db) + '</span> · 数据截止 <span class="hl">' +
            esc(S.desk.as_of) + '</span> · 生成 ' + esc((S.desk.generated_at || '').slice(0, 19).replace('T', ' ')));
        say('  ' + esc((S.desk.summary || {}).summary_text || '（无一句话总结）'));
        return;
      }

      if (c0 === 'ai') {
        if (!S.ai) return say('  还没有 AI 复盘产物。运行 tools/ai_digest.py 生成 data/ai_digest.json', 'er');
        say('  <span class="hl">' + esc(S.ai.model || '') + '</span> ' + esc((S.ai.generated_at || '').slice(0, 19)));
        say('  ' + esc(S.ai.digest));
        (S.ai.drivers || []).forEach(x => say('  <span class="hl">' + esc(x.code) + '</span> ' + esc(x.text)));
        return;
      }

      if (c0 === 'refresh') { await boot(true); say('  已清缓存并重新拉取', 'ok'); return; }

      const sym = findSymbol(w0);
      if (sym) { S.sym = sym; selectSym(); say('  已切到 <span class="hl">' + sym + '</span>', 'ok'); return; }
      const per = PERIODS.find(p => p.id === w0.toUpperCase());
      if (per) { S.period = per.id; selectPer(); say('  周期切到 ' + esc(per.label), 'ok'); return; }

      say('  无法识别「' + esc(cmd) + '」。输入 <span class="hl">help</span> 看指令表。', 'er');
    }

    function show () {
      box.hidden = false; open = true; input.value = ''; input.focus();
      if (!out.childElementCount) {
        say('<span class="hl">聚酯链驾驶舱 · 终端模式</span>');
        say('  输入 <span class="hl">help</span> 看全部指令，例如 <span class="hl">chart PX W</span> 或 <span class="hl">macro</span>');
      }
    }
    function hide () { box.hidden = true; open = false; }

    function init () {
      if (init._done) return { show, hide };
      init._done = true;
      box = $('terminal'); input = $('termInput'); out = $('termOut');
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { run(input.value); input.value = ''; }
        if (e.key === 'Escape') hide();
        e.stopPropagation();
      });
      box.addEventListener('click', e => { if (e.target === box) hide(); });
      document.addEventListener('keydown', e => {
        const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
        if (e.key === '/' && !typing && !open) { e.preventDefault(); show(); }
        else if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); open ? hide() : show(); }
        else if (e.key === 'Escape' && open) hide();
      });
      return { show, hide };
    }
    return { init, show, hide };
  })();

  /* ======================================================================
     10. 选择与启动
     ====================================================================== */

  function selectSym () {
    document.querySelectorAll('#symTabs button').forEach(b =>
      b.setAttribute('aria-pressed', b.dataset.sym === S.sym));
    document.querySelectorAll('#chain .node').forEach(b =>
      b.setAttribute('aria-pressed', b.dataset.code === S.sym));
    loadKline();
  }

  function selectPer () {
    document.querySelectorAll('#perTabs button').forEach(b =>
      b.setAttribute('aria-pressed', b.dataset.per === S.period));
    loadKline();
  }

  function bindOnce () {
    if (bindOnce._done) return;
    bindOnce._done = true;

    $('symTabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-sym]'); if (!b) return;
      S.sym = b.dataset.sym; selectSym();
    });
    $('perTabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-per]'); if (!b) return;
      S.period = b.dataset.per; selectPer();
    });
    $('chain').addEventListener('click', e => {
      const b = e.target.closest('.node'); if (!b) return;
      if (b.dataset.fut !== '1') {
        $('klineState').innerHTML = '<b>' + esc(b.dataset.code) +
          '</b> 没有国内期货合约，只有现货报价 —— 图表位置留给有盘面的品种。';
        return;
      }
      S.sym = b.dataset.code; selectSym();
    });
    $('heat').addEventListener('click', e => {
      const b = e.target.closest('.tile'); if (!b) return;
      const code = b.dataset.code;
      if (S.desk.chart_map[code]) { S.sym = code; selectSym(); }
      else $('klineState').innerHTML = '<b>' + esc(code) + '</b> 只有现货报价，没有盘面。';
    });
    $('btnRefresh').addEventListener('click', async () => {
      $('btnRefresh').textContent = '刷新中';
      $('btnRefresh').disabled = true;
      await boot(true);
      $('btnRefresh').textContent = '刷新';
      $('btnRefresh').disabled = false;
    });

    // 后台标签页不跑定时器，前台回来立刻补一次
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && S.world && Date.now() - S.world.at > 50e3) {
        renderWorld(); renderCalendar();
      }
    });
  }

  async function boot (force = false) {
    if (force) Desk.nukeCache();
    bindOnce();
    if (!boot._newsInit) { boot._newsInit = true; News.init(); }

    S.desk = await Desk.loadDesk();
    if (!S.desk) {
      $('summary').innerHTML = '<b>读不到 data/desk.json。</b>先运行 ' +
        '<span class="num">python3 tools/export_desk_json.py</span> 生成它。';
      $('klineState').innerHTML = '本地数据库未就绪，K 线暂不加载。';
      await renderWorld();
      return;
    }

    $('brandSub').textContent = '数据截止 ' + (S.desk.as_of || '—');
    renderSymTabs(); renderPerTabs();
    renderChain(); renderSpreads(); renderHeat(); renderProv(); renderSummary();
    renderCalendar();

    S.ai = await Desk.loadAiDigest();
    renderAi();

    await Promise.all([renderWorld(), loadKline()]);

    if (!boot._timers) { boot._timers = true; startTimers(); }
  }

  function esc (s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /** 开场读地址栏锚点，把常用视图存成书签：#PX、#PX/W、#term */
  function applyHash () {
    const h = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
    if (!h) return;
    const [a, b] = h.split('/');
    if (a.toLowerCase() === 'term') { Terminal.show(); return; }
    const sym = Object.keys(S.desk.chart_map).find(k => k.toLowerCase() === a.toLowerCase());
    const per = PERIODS.find(p => p.id.toLowerCase() === (b || '').toLowerCase());
    if (sym) { S.sym = sym; selectSym(); }
    if (per) { S.period = per.id; selectPer(); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    Terminal.init();
    tickClock();
    setInterval(tickClock, 1000);
    boot().then(applyHash);
  });
})();
