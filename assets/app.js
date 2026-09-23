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
    pxPainted: false,     // 现价是否已经画过（决定要不要播跳动动效）
    world: null,
    worldShape: '',       // 上次渲染的面板形状签名（同签名 = 就地补值，不重建 DOM）
    focus: null,          // 全球市场聚焦中的瓦片 id
    focusCache: {},       // 聚焦序列缓存：id → {kind, bars|points, src}
    open: {},             // 全球市场分组展开态：groupId → bool（默认见 WORLD_EXPAND_HINT）
    macro: { lastRun: 0, dayKey: '', todayCount: 0, busy: false },  // 宏观速览节流态
    ai: null,
    lastNewsCount: 0,
    lastNewsAt: 0,        // 情报流上次成功刷新时刻（后台追平用）
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
      Charts.draw($('kline'), bars, {
        tail: pdef.tail || 180,
        mas: [5, 20],
        key: S.sym + '|' + S.period,
        readout: $('klineOhlc')
      });
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
    const px = $('klineLast');
    const fresh = fmtNum(last.close, 1);
    // 现价刻意**不跟着涨跌上色**：旁边那枚 chip 已经用颜色说清方向了，
    // 两个绿挨在一起既吵又显廉价。大字保持中性铂金，靠字号表达分量。
    const changed = px.textContent !== fresh;
    px.textContent = fresh;
    px.className = 'px num';
    // 只在数值真的变了的时候跳一下（首次渲染不跳）
    if (changed && S.pxPainted) {
      px.classList.remove('tick'); void px.offsetWidth; px.classList.add('tick');
    }
    S.pxPainted = true;
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
     4. 全球市场 —— 点击瓦片放大聚焦，其余瓦片缩小让位
     ====================================================================== */

  /** 数值显示：unit 是货币符号走前缀（$ ¥），suffix 是 % / pp 走后缀 */
  function valText (it) {
    // 仓单注销归零时给一个干净的「0」，而不是 0.0000 —— 四个零是噪音，
    // 而且它正好出现在「清零」小章旁边，读起来像精度没处理。
    if (it.srcId === 'em_stock' && it.value === 0) {
      return (it.unit || '') + '0' + (it.suffix || '');
    }
    return (it.unit || '') + fmtNum(it.value, it.digits) + (it.suffix || '');
  }
  /** 涨跌显示：百分比优先，没有百分比就用绝对涨跌（仓单、2s10s 就是这种） */
  function pctText (it) {
    if (it.pct == null && it.chg != null) return fmtSigned(it.chg, it.digits);
    return fmtPct(it.pct, 2);
  }
  /** 涨跌显示：仓单看「当日增减多少张」，百分比项看百分比，其余看绝对涨跌。
   *  完全没有涨跌数据的项（如派生利差）返回 null —— 由调用方决定怎么表达，
   *  不要吐一个孤零零的破折号出来。 */
  function chgText (it) {
    if (it.srcId === 'em_stock' && it.chgZh != null) return fmtSigned(it.chgZh, 0) + ' 张';
    if (it.pct == null && it.chg == null) return null;
    return (it.pct == null && it.chg != null) ? fmtSigned(it.chg, it.digits) : fmtPct(it.pct, 2);
  }
  /** 涨跌上色的方向：仓单按增减张数着色，其余按百分比；没有百分比就退回绝对涨跌。
   *  （派生利差只有 chg 没有 pct，以前会一律落到 flat 灰 —— 数字是负的却不上色，
   *   看起来像坏了。现在按 chg 的符号上色。） */
  function chgCls (it) {
    if (it.srcId === 'em_stock' && it.chgZh != null) return cls(it.chgZh);
    return cls(it.pct == null ? it.chg : it.pct);
  }
  /** 脚注：每张瓦片底部的那一行。
   *  实时项给「实时 HH:MM」而不是空字符串 ——
   *  一是让每一格底部都有内容（否则无走势、无日期的格子下半部是空的，看着没做完），
   *  二是报价时刻本身就是有用信息：一眼看出这一格有多新。 */
  function footText (it) {
    if (it.srcId === 'em_stock') {
      // 注销期归零时，必须把「上次非零」摆出来，否则 0 看着像没接到数据
      if (it.value === 0 && it.lastNonZero) {
        return '注销清零 · 上次非零 ' + it.lastNonZero.date + ' ' +
               fmtTrim(it.lastNonZero.value, 4) + '万吨';
      }
      return '日终 ' + (it.asOf || '');
    }
    if (it.live) {
      if (!it.ts) return '实时';
      const d = new Date(it.ts);
      return '实时 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    return '日终 ' + (it.asOf || '');
  }
  function tipText (it) {
    const base = (it.note ? it.note + ' · ' : '') + (it.src || '') +
      (it.ts ? ' · ' + new Date(it.ts).toLocaleString('zh-CN', { hour12: false }) : '');
    if (it.srcId === 'em_stock') {
      return base + ' · 最新 ' + (it.asOf || '—') +
        ' · 当日增减 ' + fmtSigned(it.chgZh, 0) + ' 张（' + fmtNum(it.zh, 0) + ' 张）' +
        (it.lastNonZero ? ' · 上次非零 ' + it.lastNonZero.date + ' ' +
          fmtTrim(it.lastNonZero.value, 4) + ' 万吨' : '') +
        ' · 点击放大';
    }
    return base + (it.kline || it.desk ? ' · 点击聚焦' : '');
  }
  /** 展开成扁平表，聚焦面板与刷新补值都用它 */
  function worldFlat () {
    const out = {};
    if (S.world) for (const g of S.world.groups) for (const it of g.items) out[it.id] = it;
    return out;
  }

  async function renderWorld () {
    const res = await Desk.world();
    S.world = res;
    const box = $('world');

    if (!res.groups.length) {
      box.innerHTML = '<div class="state-error" style="margin:0">' +
        '全球行情源暂时都不可达。本地产的 K 线、加工费、热力图不受影响，' +
        '点右上角「刷新」重试。</div>';
      $('worldNote').textContent = '源不可达';
      S.worldShape = '';
      if (S.focus) unfocusWorld();
      renderMarquee([]);
      renderFresh();
      return;
    }

    // 聚焦的那一项在新数据里没了（源挂了），就自动退出聚焦，否则面板会卡在空图上
    if (S.focus && !worldFlat()[S.focus]) unfocusWorld();

    /* 形状没变 → 就地补值（保住 hover / 焦点 / 滚动位置，且不重解析 SVG）；
       形状变了 → 才重建。60 秒的例行刷新几乎总是走第一条路。 */
    const shape = worldShape(res);
    if (shape === S.worldShape && patchWorld()) {
      if (S.focus) updateFocusValues();
    } else {
      paintWorld();
    }
    S.worldShape = shape;

    $('worldNote').innerHTML = '实时 ' + res.groups.flatMap(g => g.items).filter(i => i.live).length +
      ' / 共 ' + res.groups.flatMap(g => g.items).length + ' 项 · 更新于 ' +
      esc(new Date(res.at).toLocaleTimeString('zh-CN', { hour12: false })) +
      (res.errs.length ? ' · <span class="up">' + esc(res.errs.join('；')) + '</span>' : '');

    renderMarquee(Desk.marqueeFrom(res));
    renderFresh();
  }

  /** 取数期间的骨架瓦片：占住高度，避免 320px → 949px 的滚动位置跳动 */
  function worldSkeleton () {
    const box = $('world');
    if (!box || box.dataset.painted) return;
    box.innerHTML = '<div class="skeleton">' + '<i></i>'.repeat(8) + '</div>';
  }

  function tileHTML (it) {
    // 仓单用中性 Seaglass 画趋势：红涨绿跌在这条线上没有意义（仓单下降不等于价格下跌），
    // 沿用涨跌色会让人把「仓单降」读成「看空」。
    // ⚠ 必须从 Charts 取色。这里曾经硬编码 '#0a84ff'（旧主题的蓝，app.css 里根本没有这个值），
    //   结果是同一个仓单序列在瓦片里是电光蓝、在聚焦图里是 Seaglass —— 而自检只看 CSS
    //   颜色属性、看不到 SVG stroke，所以它一直没被任何检查发现。
    const sparkColor = it.srcId === 'em_stock' ? Charts.SEAGLASS : Charts.colorFor(it.pct);
    const spark = it.spark && it.spark.length > 3
      ? Charts.spark(it.spark, { w: 130, h: 24, color: sparkColor })
      : '';
    const on = S.focus === it.id;
    const ct = chgText(it);
    // 没有涨跌数据的项（派生利差）：给一个安静的「静态」小章，
    // 而不是一个孤零零的破折号 —— 破折号看着像没取到，小章看着是「本来就没有」。
    const chg = ct == null
      ? '<span class="pc none" data-f-p>静态</span>'
      : '<span class="pc ' + chgCls(it) + '" data-f-p>' + esc(ct) + '</span>';
    return '<button class="mtile ' + chgCls(it) + (ct == null ? ' noc' : '') + '" type="button" ' +
      'data-wid="' + esc(it.id) + '" aria-pressed="' + on + '" title="' + esc(tipText(it)) + '">' +
      '<span class="nm">' + esc(it.label) +
        (it.srcId === 'em_stock' && it.value === 0 ? '<i class="tagzero">清零</i>' : '') + '</span>' +
      '<span class="row"><span class="vv" data-f-v>' + esc(valText(it)) + '</span>' + chg + '</span>' +
      /* 走势带固定占位：没有历史序列的项也留出同样高度，
         让 31 张瓦片严格等高（原来实测出现 67/88/97/118 四种高度，看着就是没做完） */
      '<span class="sp">' + spark + '</span>' +
      '<span class="ft" data-f-t>' + esc(footText(it)) + '</span>' +
      '</button>';
  }

  /** 分组展开态：优先会话内的选择，默认见 WORLD_EXPAND_HINT */
  function groupOpen (gid) {
    if (S.open[gid] != null) return S.open[gid];
    return WORLD_COLLAPSED_DEFAULT ? WORLD_EXPAND_HINT.includes(gid) : true;
  }

  /** 折叠组的摘要：N 项 · 涨 x · 跌 y —— 不看具体数字也能先知道方向分布 */
  function groupSummary (g) {
    const u = g.items.filter(i => chgCls(i) === 'u').length;
    const d = g.items.filter(i => chgCls(i) === 'd').length;
    return g.items.length + ' 项 · 涨 ' + u + ' · 跌 ' + d;
  }

  /** 分组：标题始终是可点按钮（⌄ 开 / ⌃ 合），展开 = 完整网格，折叠 = 单行横向摘要 */
  function groupHTML (g) {
    const open = groupOpen(g.id);
    return '<div class="mgroup" data-open="' + (open ? 1 : 0) + '" id="grp-' + esc(g.id) + '">' +
      '<button class="mgroup-sum" type="button" data-toggle="' + esc(g.id) +
        '" aria-expanded="' + open + '" aria-controls="grp-' + esc(g.id) + '">' +
        '<span class="chev" aria-hidden="true"></span>' +
        '<span>' + esc(g.label) + '</span>' +
        (g.note ? '<span class="g-note">' + esc(g.note) + '</span>' : '') +
        (open ? '<span class="rule"></span>' : '<span class="g-count">' + groupSummary(g) + '</span>') +
      '</button>' +
      '<div class="mtiles">' + g.items.map(tileHTML).join('') + '</div></div>';
  }

  /** 右栏 <section id="inspector"> 的头部：名称 + 现价 + 涨跌 + 截至 */
  /** 右栏聚焦面板的头部：名称 + 现价 + 涨跌 + 截至。
   *  与主力合约卡同一套规则：数值保持中性，方向只由 pc 那一段用颜色表达；
   *  没有涨跌数据时给「静态」小章，不吐 null。 */
  function focusHeadHTML (it) {
    const ct = chgText(it);
    return '<b>' + esc(it.label) + '</b>' +
      '<span class="vv num" data-f-v2>' + esc(valText(it)) + '</span>' +
      (ct == null
        ? '<span class="pc num none" data-f-p2>静态</span>'
        : '<span class="pc num ' + chgCls(it) + '" data-f-p2>' + esc(ct) + '</span>') +
      '<span class="dim2 fnote" data-f-t2>' + esc(footText(it)) + '</span>';
  }

  /** 只从已有 world 数据重建 DOM（切聚焦/退聚焦/折叠切换时用，不重新打接口） */
  function paintWorld () {
    const box = $('world');
    if (!S.world || !S.world.groups.length) return;
    const host = $('wfocusHost');
    // 重写 innerHTML 前先把聚焦宿主挪出 #world，否则它会连同旧分组一起被销毁
    if (host && host.parentElement === box) box.insertAdjacentElement('afterend', host);
    box.innerHTML = S.world.groups.map(groupHTML).join('');
    box.dataset.painted = '1';
    positionFocusHost();
  }

  /** 面板的「形状」签名：分组 id + 每组的项 id。
   *  形状没变 = 可以就地补值；形状变了（某个源挂了、某项消失）才值得重建 DOM。 */
  function worldShape (res) {
    if (!res || !res.groups) return '';
    return res.groups.map(g => g.id + ':' + g.items.map(i => i.id).join(',')).join('|');
  }

  /** 就地补值 —— 每分钟的例行刷新走这条路，不再重建 DOM。
   *  为什么必须这么做：
   *    1. 全量 innerHTML 会丢掉 hover、键盘焦点、文本选择与滚动位置 ——
   *       键盘用户正在浏览时被 60 秒定时器把焦点抽走，是真实的无障碍缺陷。
   *    2. 31 张瓦片的 SVG 迷你走势会被重新解析一次，纯属白做。
   *    3. [data-f-v] / [data-f-p] / [data-f-t] 这几个锚点本来就是为了就地补值而
   *       存在的，但此前没有任何代码用过它们 —— 等于白留。
   *  返回 true 表示全部命中，可以安全跳过重建。 */
  function patchWorld () {
    const box = $('world');
    if (!box || !S.world) return false;
    const flat = worldFlat();
    let hit = 0;
    for (const tile of box.querySelectorAll('.mtile[data-wid]')) {
      const it = flat[tile.dataset.wid];
      if (!it) return false;                       // 有项消失 → 交给重建
      const v = tile.querySelector('[data-f-v]');
      const p = tile.querySelector('[data-f-p]');
      const t = tile.querySelector('[data-f-t]');
      if (v) v.textContent = valText(it);
      if (p) {
        const ct = chgText(it);
        // 「静态」小章 ↔ 正常涨跌 之间会互相切换，class 和文案都要一起改
        if (ct == null) { p.className = 'pc none'; p.textContent = '静态'; }
        else { p.className = 'pc ' + chgCls(it); p.textContent = ct; }
        tile.classList.toggle('noc', ct == null);
      }
      if (t) t.textContent = footText(it);
      // 左侧方向色条也要跟着走，否则价格变了颜色还停在上一轮
      const dir = chgCls(it);
      tile.classList.remove('u', 'd');
      if (dir !== 'flat') tile.classList.add(dir);
      // 收起的分组只显示一行摘要，计数会随涨跌翻转
      const grp = tile.closest('.mgroup');
      if (grp && grp.dataset.open === '0') {
        const cnt = grp.querySelector('.g-count');
        const g = S.world.groups.find(x => x.id === grp.id.replace(/^grp-/, ''));
        if (cnt && g) cnt.textContent = groupSummary(g);
      }
      hit++;
    }
    return hit > 0 && hit === Object.keys(flat).length;
  }

  /** 把聚焦宿主移动到聚焦项所在分组的后面。
   *  宿主只被「移动」，从不被 innerHTML 重建 —— 图表实例因此永远活着。
   *  （旧版把宿主 innerHTML 清空，实例注册表里却还留着已死的图表，
   *   于是第二次聚焦起 K 线集体消失 —— 就是你看到的「聚焦里没 K 线」。） */
  function positionFocusHost () {
    const host = $('wfocusHost');
    if (!host) return;
    if (!S.focus) { host.hidden = true; return; }
    const it = worldFlat()[S.focus];
    const grp = it ? document.getElementById('grp-' + it.group) : null;
    if (grp && grp.nextElementSibling !== host) grp.insertAdjacentElement('afterend', host);
    if (host.hidden) {
      host.hidden = false;
      // 从 display:none 里出来的一帧内尺寸才就绪；下一帧再让图表对齐宽度
      requestAnimationFrame(() => Charts.resize());
    }
  }

  /** 60 秒轮询只补聚焦头部的现价，不重建图表实例 */
  function updateFocusValues () {
    const it = worldFlat()[S.focus];
    if (!it) return;
    const set = (sel, txt, base, extra) => {
      const n = document.querySelector('#wfocusHost ' + sel);
      if (n) { n.textContent = txt; n.className = base + (extra ? ' ' + extra : ''); }
    };
    set('[data-f-v2]', valText(it), 'vv num');
    const ct = chgText(it);
    if (ct == null) set('[data-f-p2]', '静态', 'pc num', 'none');
    else set('[data-f-p2]', ct, 'pc num', chgCls(it));
    set('[data-f-t2]', footText(it), 'dim2 fnote');
  }

  /* ---- 聚焦的开关与取数（图表宿主 = 全球市场卡内的稳定面板） ---- */

  function focusWorld (id) {
    if (S.focus === id) { unfocusWorld(); return; }
    S.focus = id;
    const it = worldFlat()[id];
    // 所在分组若被折叠，先展开 —— 图表要出现在它的上下文里
    if (it && it.group) S.open[it.group] = true;
    paintWorld();
    $('wfocusHead').innerHTML = it ? focusHeadHTML(it) : '';
    $('wfocusOhlc').innerHTML = '';
    $('wfocusMeta').innerHTML = '—';
    $('wfocusState').textContent = '正在取历史序列…';
    writeHash('w=' + id);
    // 图表就地出现在瓦片下方；万一在视口外，最小幅度滚进来
    const host = $('wfocusHost');
    if (host && host.scrollIntoView) {
      requestAnimationFrame(() => host.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
    loadFocusSeries(id);
  }

  function unfocusWorld () {
    S.focus = null;
    paintWorld();
    writeHash('');
  }

  /** 抓聚焦项的序列并画出来。三种情况分开处理，没有的就直说没有。 */
  async function loadFocusSeries (id) {
    const it = worldFlat()[id];
    const host = $('wfocusChart');
    if (!it || !host) return;
    const meta = $('wfocusMeta'), state = $('wfocusState');

    let s = S.focusCache[id];
    if (!s) {
      state.textContent = '正在取历史序列…';
      try {
        s = await Desk.itemSeries(it);
        if (s.kind !== 'none') S.focusCache[id] = s;
      } catch (e) {
        s = { kind: 'none', src: it.src, err: String(e.message || e) };
      }
    }

    // 用户可能在取数期间又点了别的
    if (S.focus !== id) return;

    if (s.kind === 'bars') {
      // 下一帧再画：宿主刚从隐藏态出现时，这一帧内布局尺寸才就绪
      requestAnimationFrame(() => {
        if (S.focus !== id) return;
        Charts.draw(host, s.bars, {
          tail: FOCUS_DAYS, mas: [5, 10], masColors: [Charts.ACCENT, Charts.GREY],
          key: 'wf|' + id,
          readout: $('wfocusOhlc'), digits: it.digits, fontSize: 11, barSpacing: 5,
          lastValue: true            // 聚焦面板没有大号现价，轴上留一个最后价标
        });
      });
      const st = Charts.stats(s.bars.slice(-FOCUS_DAYS));
      meta.innerHTML = st
        ? '区间 <b>' + st.n + '</b> 个交易日（' + esc(st.from) + ' → ' + esc(st.to) + '）· ' +
          '高 <b class="up">' + fmtNum(st.high, it.digits) + '</b>' +
          ' 低 <b class="down">' + fmtNum(st.low, it.digits) + '</b>' +
          ' · 区间 <b class="' + cls(st.chg) + '">' + fmtSigned(st.chg, it.digits) + ' / ' +
          fmtPct(st.pct, 2) + '</b>' + ' · 源 <b>' + esc(s.src) + '</b>'
        : '';
      state.innerHTML = '上图 <b>' + (it.label) + '</b> 日线 · 红涨绿跌 · ' +
        '均线 MA5（蓝）/ MA10（灰）· 双击图表复位缩放 · 点「收起」或再点一次瓦片收起';
    } else if (s.kind === 'line') {
      // 仓单用中性 Seaglass：红涨绿跌在仓单曲线上没有意义（仓单降 ≠ 看空），
      // 沿用涨跌色会让人把库存变化读成价格方向。与瓦片迷你走势同一支色。
      const lineColor = it.srcId === 'em_stock' ? Charts.SEAGLASS : Charts.colorFor(it.pct);
      requestAnimationFrame(() => {
        if (S.focus !== id) return;
        Charts.drawLine(host, s.points, {
          key: 'wf|' + id, readout: $('wfocusOhlc'), digits: it.digits,
          unit: s.unit || it.suffix || '', color: lineColor, fontSize: 11
        });
      });
      const pts = s.points;
      const first = pts[0][1], last = pts[pts.length - 1][1];
      const unit = s.unit || it.suffix || '';
      let hi = pts[0], lo = pts[0];
      for (const p of pts) { if (p[1] > hi[1]) hi = p; if (p[1] < lo[1]) lo = p; }
      const lastNZ = it.srcId === 'em_stock' ? [...pts].reverse().find(p => p[1] > 0) : null;
      meta.innerHTML = '区间 <b>' + pts.length + '</b> 期（' + esc(pts[0][0]) + ' → ' +
        esc(pts[pts.length - 1][0]) + '）· 高 <b>' + fmtNum(hi[1], it.digits) + '</b>（' + esc(hi[0]) + '）' +
        ' · 低 <b>' + fmtNum(lo[1], it.digits) + '</b>（' + esc(lo[0]) + '）· 区间 <b class="' +
        cls(last - first) + '">' + fmtSigned(last - first, it.digits) + ' / ' +
        fmtPct(first ? (last - first) / first * 100 : null, 2) + '</b>' +
        (unit ? ' ' + esc(unit) : '') + ' · 源 <b>' + esc(s.src) + '</b>';

      // 归零必须解释清楚，否则「0」会被当成取数失败
      const why = it.srcId === 'em_stock'
        ? (last === 0
            ? '仓单已<b>注销清零</b>' +
              (lastNZ ? '，上次非零 <b>' + esc(lastNZ[0]) + '</b> = ' + fmtTrim(lastNZ[1], it.digits) +
                        ' ' + esc(unit || '万吨') : '') +
              '。到期集中注销就会归零，接下来看的是重新注册的量与速度 —— 数据是真的，不是没取到。'
            : '交易所仓单日频序列。仓单看增减，不看百分比。')
        : '这一项数据源只给收盘价，所以画<b>折线</b>（不假装有开高低）。';
      state.innerHTML = why + ' · 双击图表复位缩放 · 再点一次瓦片收起';
    } else {
      host.innerHTML = '';
      meta.innerHTML = '';
      state.innerHTML = '这一项的数据源只给<b>当日快照</b>（' + esc(it.src || '') + '），' +
        '没有可画的历史序列 —— 数值、涨跌与截至时间见上方的收起按钮一行。' +
        (s.err ? ' <span class="up">取数报错：' + esc(s.err) + '</span>' : '');
    }
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

  /** 热力格上的短名：把与代码重复的部分和族群前缀去掉。
   *  原来只印代码（TA / MEG / POY），全名只藏在 title 里 —— 触屏上根本没有 title。
   *  这里把名字真正显示出来，同时不至于让 13 个格子撑成两屏。
   *  重名（SC原油 与 WTI原油 都会简化成「原油」）一律退回代码，宁可短也不能歧义。 */
  function shortNames (instruments) {
    const raw = new Map();
    for (const i of instruments) {
      const code = i.code, full = String(i.name_cn || code);
      // 先去掉内嵌的代码，再去掉「涤纶/聚酯」这类族群前缀
      const s = full.replace(new RegExp(code, 'gi'), '').replace(/^(涤纶|聚酯)/, '').trim();
      raw.set(code, s ? (s.length > 4 ? (full.length <= 5 ? full : code) : s)
                      : code);
    }
    const count = {};
    for (const v of raw.values()) count[v] = (count[v] || 0) + 1;
    const out = {};
    for (const [code, v] of raw) out[code] = count[v] > 1 ? code : v;
    return out;
  }

  function renderHeat () {
    const rows = [];
    const shortOf = shortNames(S.desk.instruments || []);
    for (const inst of S.desk.instruments) {
      const code = inst.code;
      const fut = latestOf(code, 'futures');
      const spot = latestOf(code, 'spot');
      const kind = fut ? 'futures' : 'spot';       // 有盘面报盘面，一个品种只出一个格子
      const pick = fut || spot;
      if (!pick) continue;
      const prov = S.desk.provenance[code + '|' + kind] || {};
      rows.push({
        code, name: inst.name_cn, short: shortOf[code] || code,
        pct: pick.chg_pct, value: pick.value, unit: inst.unit,
        stale: /STALE/.test(prov.quality_flag || ''), kind,
        flag: prov.quality_flag || '', n: prov.n_sources || 1
      });
    }
    rows.sort((a, b) => (b.pct == null ? -999 : b.pct) - (a.pct == null ? -999 : a.pct));

    // 量级条：|涨跌幅| 相对本屏最大值，给格子一个可读的强弱刻度
    const maxAbs = Math.max(0.1, ...rows.map(r => Math.abs(r.pct || 0)));

    $('heat').innerHTML = '<span class="lb">涨跌热力</span>' + rows.map(r => {
      const tip = r.name + ' · ' + (r.kind === 'futures' ? '期货主力' : '现货') +
        ' ' + fmtNum(r.value, 1) + ' ' + (r.unit || '') + ' · ' + r.n + ' 个来源' +
        (r.flag ? ' · ' + r.flag : '') + (r.stale ? ' · 数据可能滞后' : '');
      const mag = Math.min(1, Math.abs(r.pct || 0) / maxAbs);
      return '<button class="tile ' + cls(r.pct) + (r.stale ? ' stale' : '') + '" type="button" ' +
        'data-code="' + r.code + '" style="--mag:' + mag.toFixed(2) + '" ' +
        'title="' + esc(tip) + '">' +
        '<span class="tn">' + esc(r.short) + '</span>' +
        '<span class="tv">' + (r.pct == null ? '—' : fmtPct(r.pct, 1)) + '</span></button>';
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

  /* ── 一句话总结 → 结构化简报 ────────────────────────────────────────────
     起因：summary_text 是一段 320 字的跑文，把 30 多个数字串在一行里，
     挂着「总结」的名字却完全没法扫读 —— 这是全页信息设计最差的一块。

     数据本来就在 desk.json 的结构化字段里（latest / spreads / instruments），
     所以简报直接由结构化数据生成；正文只用来取「领句」和「数据来源」两段，
     中间那三段流水账由芯片取代。领句和来源缺失时退回原文，不硬解析。 */
  function renderBrief () {
    const grid = $('briefGrid');
    if (!grid) return;
    const d = S.desk;
    const txt = (d.summary && d.summary.summary_text) || '';
    const clauses = txt.split('；');

    const nameOf = code => {
      const i = (d.instruments || []).find(x => x.code === code);
      return (i && i.name_cn) || code;
    };
    const rank = kind => (d.instruments || [])
      .map(i => ({ i, l: d.latest[i.code] && d.latest[i.code][kind] }))
      .filter(x => x.l)
      .sort((a, b) => (b.l.chg_pct == null ? -999 : b.l.chg_pct) -
                      (a.l.chg_pct == null ? -999 : a.l.chg_pct));

    const digitsFor = v => (Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 100 ? 1 : 2);
    const chip = (name, value, chg, digits, pctText, tip) => {
      const dir = cls(chg);
      return '<span class="chip ' + dir + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
        '<span class="cn">' + esc(name) + '</span>' +
        '<span class="cv">' + esc(fmtNum(value, digits)) + '</span>' +
        '<span class="cp ' + dir + '">' + esc(pctText) + '</span></span>';
    };
    const unitTip = (name, v, unit, asOf, src) =>
      name + ' ' + fmtNum(v, 2) + ' ' + (unit || '') +
      (asOf ? ' · 截至 ' + asOf : '') + (src ? ' · ' + src : '');

    const rows = [];

    const fut = rank('futures');
    if (fut.length) {
      rows.push(['期货主力', fut.map(x =>
        chip(nameOf(x.i.code), x.l.value, x.l.chg_pct, digitsFor(x.l.value),
             fmtPct(x.l.chg_pct),
             unitTip(nameOf(x.i.code), x.l.value, x.i.unit, x.l.date, '期货主力'))).join('')]);
    }

    const spot = rank('spot');
    if (spot.length) {
      rows.push(['现货', spot.map(x =>
        chip(nameOf(x.i.code), x.l.value, x.l.chg_pct, digitsFor(x.l.value),
             fmtPct(x.l.chg_pct),
             unitTip(nameOf(x.i.code), x.l.value, x.i.unit, x.l.date, '现货'))).join('')]);
    }

    const sp = SPREAD_PICK.filter(k => d.spreads[k]).map(k => {
      const s = d.spreads[k], l = s.latest || {};
      return chip(s.label, l.value, l.chg, 1, fmtSigned(l.chg, 1),
                  s.label + ' ' + fmtNum(l.value, 1) + ' ' + (s.unit || '') +
                  (s.formula ? ' · ' + s.formula : '') +
                  (l.date ? ' · 截至 ' + l.date : ''));
    }).join('');
    if (sp) rows.push(['加工费 / 价差', sp]);

    grid.innerHTML = rows.map(([k, chips]) =>
      '<div class="brief-row"><span class="k">' + esc(k) + '</span>' +
      '<span class="chips">' + chips + '</span></div>').join('');

    // 日期 + 领句
    const dateEl = $('briefDate'), ledeEl = $('briefLede');
    if (dateEl) dateEl.textContent = (d.summary && d.summary.trade_date) || d.as_of || '—';
    if (ledeEl) {
      let lede = clauses[1] || '';
      if (lede) {
        ledeEl.innerHTML = esc(lede)
          .replace(/(\d+)\s*涨/, '<b class="up">$1涨</b>')
          .replace(/(\d+)\s*跌/, '<b class="down">$1跌</b>')
          .replace(/\(([+-]?[\d.]+%)\)/g, (m, p1) =>
            '(<b class="' + (p1.charAt(0) === '-' ? 'down' : 'up') + '">' + p1 + '</b>)');
      } else {
        // 模板变了就整段退回，不假装还能解析
        ledeEl.textContent = txt.slice(0, 160) || '本地数据库里还没有一句话总结。';
      }
    }

    // 来源：取「数据来源」那一段
    const srcEl = $('briefSrc');
    if (srcEl) {
      const s = clauses.find(c => c.indexOf('数据来源') === 0) || '';
      srcEl.textContent = s || ('数据库 ' + (d.db || '—') + ' · 生成 ' +
        String(d.generated_at || '').slice(0, 16).replace('T', ' '));
    }
  }

  /** AI 复盘：读静态 data/ai_digest.json。前端不放任何密钥。 */
  function renderAi () {
    const box = $('ai');
    const d = S.ai;
    const hasHl = !!(d && Array.isArray(d.headlines) && d.headlines.length);
    if (!d || (!d.digest && !hasHl)) { box.hidden = true; return; }
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
    if (d.digest) html += '<p>' + mdLite(d.digest) + '</p>';
    if (Array.isArray(d.drivers) && d.drivers.length) {
      html += d.drivers.map(x =>
        '<p><b>' + esc(x.code) + '</b> ' + mdLite(x.text) + '</p>').join('');
    }

    /* 今日情报：一行一条，标签 + 一句话。
       只由新闻【标题】压出来 —— 正文摘要会成倍放大 token 而边际信息很少，
       所以这一块刻意做得极短：它是用来扫的，不是用来读的。 */
    if (hasHl) {
      html += '<div class="hl"><div class="hl-h">今日情报' +
        '<span class="n">' + d.headlines.length + ' 条 · 仅据标题压缩</span></div><ul>' +
        d.headlines.slice(0, 8).map(h => {
          const tag = h && h.tag ? esc(String(h.tag).slice(0, 3)) : '';
          const txt = h && h.text ? esc(String(h.text)) : esc(String(h || ''));
          return '<li>' + (tag ? '<span class="lt">' + tag + '</span>' : '') +
                 '<span class="lx">' + txt + '</span></li>';
        }).join('') + '</ul></div>';
    }

    if (Array.isArray(d.warnings) && d.warnings.length) {
      html += '<p class="ai-warn">数据提示：' + esc(d.warnings.join('；')) + '</p>';
    }
    box.innerHTML = html;
  }

  /** 只支持 **加粗**，够用且不会引入 HTML 注入 */
  function mdLite (s) {
    return esc(String(s || '')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  }

  /* ======================================================================
     6. 日历
     时间口径：美国事件官方按美东（ET）公布，中国事件按北京（CST）。
     两个都给，并标明哪个是官方口径 —— 只写「本机时间」的话，
     同一行换台设备看会变成另一个数字，对着官方日历就没法核对了。
     ====================================================================== */

  function safeCall (fn) { try { return fn(); } catch (e) { return null; } }

  function fmtLocal (ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('zh-CN') + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function officialText (ts, tz) {
    const zone = tz || 'ET';
    return fmtInZone(ts, zone) + ' ' + (CAL_TZ[zone] || zone);
  }

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

    const note = top.c.note ? esc(top.c.note) : '';
    $('calTop').innerHTML =
      '<div class="cal-row"><span class="lb">' + esc(top.c.label) + '</span>' +
      '<span class="vv">' + fmtLeft(left) + '</span></div>' +
      '<div class="cal-row sub"><span class="dim2">官方 <b>' +
        esc(officialText(top.t, top.c.tz)) + '</b> · 你这里 <b>' +
        esc(fmtLocal(top.t)) + '</b></span></div>' +
      (note ? '<div class="cal-row sub"><span class="dim2">' + esc(CAL_TZ[top.c.tz || 'ET']) +
        '口径：' + note + '</span></div>' : '') +
      (prev ? '<div class="cal-row sub"><span class="dim2">本周期已过 ' +
        pct.toFixed(0) + '%</span></div>' : '');
    $('calBar').innerHTML = '<i style="width:' + pct.toFixed(1) + '%"></i>';

    $('calRest').innerHTML = rows.slice(1, 6).map(x => {
      const tz = x.c.tz || 'ET';
      return '<div class="cal-row triple"><span class="lb">' + esc(x.c.label) + '</span>' +
        '<span class="mid dim2">' + (x.c.kind === 'rule' ? '约 ' : '') +
        esc(officialText(x.t, tz)) + '</span>' +
        '<span class="vv">' + fmtLeft(x.t - Date.now()) + '</span></div>';
    }).join('');

    $('calNote').innerHTML = '时间一律标两套：<b>官方</b>是发布方口径（美国事件美东 ET、' +
      '中国事件北京 CST），<b>你这里</b>是换算到这台设备时区（' +
      esc(localZoneName()) + '）的结果。标注「约」为规则推算，非官方公告；' +
      'FOMC 与 EIA 用官方日历，本表核对于 ' + CAL_VERIFIED_AT + '。核对：' +
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

  /** 情报流统一刷新的唯一入口：刷新 + 提示新增 + 触发宏观速览（内部节流） */
  async function refreshNews () {
    const n = await News.refresh();
    S.lastNewsAt = Date.now();
    if (n > 0) { renderFresh(); announce('情报流新增 ' + n + ' 条'); }
    runMacro();
    return n;
  }

  /** 大于某时限就补拉 K 线（后台被浏览器节流时，回来追平用） */
  function loadKlineStale (now, maxAge) {
    if (!S.lastKlineAt) return;
    if (now - S.lastKlineAt > maxAge) loadKline();
  }

  function startTimers () {
    every(45e3, () => refreshNews(), 'news');
    every(60e3, () => { renderWorld(); }, 'world');
    every(5 * 60e3, () => { loadKline(); }, 'kline');
    every(60e3, () => { renderCalendar(); renderFresh(); }, 'cal');
  }

  function announce (t) { const el = $('live'); if (el) el.textContent = t; }

  /* ======================================================================
     8b. 宏观速览 —— 把已抓到的情报流里宏观/政策/产业类新条目，压缩成几条要点
     · 只消费 News.state.items（绝不重新打接口），走 AI_PROXY（Cloudflare
       Worker → DeepSeek）。前端不放任何密钥。
     · 省 token：冷却 12 分钟 + 单日 30 次 + 每次最多喂 8 条、输出 5 条。
     · 未配置 AI_PROXY.url = 整卡隐藏，不调任何 API、不花钱。
     ====================================================================== */

  /** 只从宏观相关频道筛候选，按 新→旧 排，限 maxNews 条。
   *  ⚠ 只带标题，不带正文摘要 —— 摘要会让输入 token 成倍增长而边际信息很少。
   *    标题本身已经是编辑压过一轮的东西，这是最省的一刀。 */
  function macroCandidates () {
    const want = new Set(MACRO_OVERVIEW.channels);
    return News.state.items
      .filter(x => { for (const c of x.channels) if (want.has(c)) return true; return false; })
      .map(x => ({
        t: String(x.title || '').slice(0, 46),
        ch: [...x.channels].find(c => want.has(c)) || ''
      }))
      .slice(0, MACRO_OVERVIEW.maxNews);
  }

  function macroConfigured () { return !!(AI_PROXY && AI_PROXY.url); }

  /** 启动时定一次宏观卡形态：已配置→触发压缩；未配置→整卡保持隐藏（零噪音零请求） */
  function initMacro () {
    const card = $('macroCard');
    if (!card) return;
    if (macroConfigured()) { runMacro(); return; }
    card.hidden = true;
  }

  function showMacro (msgHtml, noteText) {
    const card = $('macroCard');
    if (!card) return;
    card.hidden = false;
    $('macroBody').innerHTML = '<p class="state" style="border:0;margin:0">' + msgHtml + '</p>';
    $('macroNote').textContent = noteText || '—';
  }

  function renderMacro (points, nFeeds, empty, err) {
    const body = $('macroBody'), card = $('macroCard');
    if (!body || !card) return;
    card.hidden = false;
    $('macroNote').textContent = nFeeds ? '基于 ' + nFeeds + ' 条最新情报' : '—';
    if (err) {
      body.innerHTML = '<div class="state-error">宏观速览失败：' + esc(String(err.message || err)) + '</div>';
      return;
    }
    if (!points.length) {
      body.innerHTML = '<p class="state-empty">' +
        (empty ? '本轮无值得提炼的宏观增量，跳过。' : '尚无宏观要点可提炼。') + '</p>';
      return;
    }
    body.innerHTML = points.map(pt => {
      const i = pt.indexOf('：') === -1 ? pt.indexOf(':') : pt.indexOf('：');
      let tag = '', txt = pt;
      if (i > 0 && i <= 3) { tag = pt.slice(0, i).trim(); txt = pt.slice(i + 1).trim(); }
      return '<div class="mi"><div class="m-h">' +
        (tag ? '<span class="tag">' + esc(tag) + '</span>' : '') +
        '</div><p>' + mdLite(txt) + '</p></div>';
    }).join('');
  }

  /** 调 DeepSeek（经代理）：只依据喂给它的标题压缩，严禁编造 */
  async function macroCall (cands) {
    const body = {
      prompt: '你是聚酯链驾驶舱的宏观速览。只依据下面提供的财经快讯【标题】，' +
        '压缩成不超过 ' + MACRO_OVERVIEW.maxPoints + ' 条要点，服务聚酯/能化产业链从业者。' +
        '每条要点一句话，句首给一个不超过2字的分类标签（政策/货币/需求/供应/心态/海外），' +
        '用冒号分隔。标题里没提到的事一律不写，不要复述流水账。\n\n' +
        '标题（新→旧，只有标题没有正文）：\n' +
        cands.map((c, i) => (i + 1) + '. [' + c.ch + '] ' + c.t).join('\n'),
      maxTokens: 260,
      temperature: 0.3
    };
    const r = await fetch(AI_PROXY.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (AI_PROXY.token || '')
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('代理 HTTP ' + r.status);
    const j = await r.json();
    const raw = typeof j === 'string' ? j : String(j && (j.text || j.result || j.outputs) || '');
    return raw.split(/[;\n]+/)
      .map(x => x.replace(/^\s*\d+[.、)）]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, MACRO_OVERVIEW.maxPoints);
  }

  async function runMacro () {
    if (S.macro.busy || !macroConfigured()) return;
    const now = Date.now();
    if (S.macro.dayKey !== new Date(now).toDateString()) { S.macro.dayKey = new Date(now).toDateString(); S.macro.todayCount = 0; }
    if (now - S.macro.lastRun < MACRO_OVERVIEW.cooldownMs) return;   // 冷却中，省 token
    if (S.macro.todayCount >= MACRO_OVERVIEW.maxDaily) return;       // 当日天顶
    const cands = macroCandidates();
    if (!cands.length) return;
    S.macro.busy = true;
    showMacro('正在压缩 <b>' + cands.length + '</b> 条最新情报…', '宏观速览');
    try {
      const points = await macroCall(cands);
      S.macro.lastRun = Date.now();
      S.macro.todayCount++;
      renderMacro(points, cands.length, !points.length);
    } catch (e) {
      // 调失败也推进冷却，避免网络抖动把配额烧穿
      S.macro.lastRun = Date.now();
      renderMacro([], cands.length, false, e);
    } finally {
      S.macro.busy = false;
    }
  }

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
      ['doctor', '自检：逐个文件探测 + 每个数据源连通性'],
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
                '  <span class="' + chgCls(it) + '">' + esc(chgText(it)).padStart(9, ' ') + '</span>' +
                '  <span style="opacity:.6">' + esc(it.src || '') +
                (it.live ? ' 实时' : ' 日终 ' + (it.asOf || '')) +
                (it.srcId === 'em_stock' && it.value === 0 && it.lastNonZero
                  ? ' 上次非零 ' + esc(it.lastNonZero.date) + ' ' + fmtNum(it.lastNonZero.value, 4) + '万吨'
                  : '') + '</span>');
          }
        }
        return;
      }

      if (c0 === 'w' || c0 === 'focus' || c0 === 'zoom') {
        const q = cmd.split(/\s+/).slice(1).join(' ').trim();
        if (!q || q === 'off' || q === 'reset') {
          unfocusWorld(); return say('  已收起全球市场放大图', 'ok');
        }
        const flat = worldFlat();
        const item = flat[q] ||
          Object.values(flat).find(i => i.id.toLowerCase() === q.toLowerCase() ||
                                        String(i.label).includes(q));
        if (!item) {
          return say('  找不到「' + esc(q) + '」。可用的：' +
            Object.values(flat).map(i => esc(i.label)).join(' / '), 'er');
        }
        focusWorld(item.id);
        return say('  已放大 <span class="hl">' + esc(item.label) + '</span>', 'ok');
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

      if (c0 === 'doctor' || c0 === 'check' || c0 === '自检') {
        say('  正在自检，逐个文件探一遍…');
        const lines = await runDoctor();
        lines.forEach(l => say('  ' + l));
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
    return { init, show, hide, exec: cmd => { show(); run(cmd); } };
  })();

  /* ======================================================================
     9b. 自检 —— 让页面自己回答「哪里没生效」
     起因：只上传错一个文件，面板就是一片空白，而空白是最难排查的状态。
     现在任何一个 404 都会被点名，并且顺带测一遍每个数据源通不通。
     ====================================================================== */

  /** 逐个文件 HEAD 探测。返回 HTTP 状态码，0 表示连不上 */
  async function probeFile (path) {
    try {
      const r = await fetch(path, { method: 'HEAD', cache: 'no-store' });
      return r.status;
    } catch (e) { return 0; }
  }

  async function runDoctor () {
    const out = [];
    const tick = ok => ok ? '<span class="ok">✓</span>' : '<span class="er">✗</span>';

    out.push('<span class="hl">模块</span>');
    for (const m of SELF_CHECK_MODULES) {
      let ok = false;
      try { ok = !!m.has(); } catch (e) { ok = false; }
      out.push('  ' + tick(ok) + ' ' + esc(m.label).padEnd(8, ' ') +
               '<span style="opacity:.6">' + esc(m.file) + '</span>' +
               (ok ? '' : '  <span class="er">没加载 —— 这个文件多半 404 了</span>'));
    }
    out.push('  ' + tick(true) + ' 构建号  <span class="hl">' + esc(BUILD) + '</span>');

    out.push('');
    out.push('<span class="hl">文件探测</span>（相对当前页面）');
    const codes = await Promise.all(SELF_CHECK_FILES.map(f => probeFile(f)));
    SELF_CHECK_FILES.forEach((f, i) => {
      const c = codes[i];
      const ok = c === 200;
      out.push('  ' + tick(ok) + ' ' + esc(f).padEnd(56, ' ') +
               (ok ? '<span style="opacity:.6">200</span>'
                   : '<span class="er">' + (c || '连不上') + '</span>' +
                     (c === 404 ? '  <span class="er">文件不在这个路径</span>' : '')));
    });
    out.push('  <span style="opacity:.6">页面地址：' + esc(location.origin + location.pathname) + '</span>');

    out.push('');
    out.push('<span class="hl">联网探测</span>（每个数据源各打一发）');
    const probes = [
      ['东财新闻', () => Desk.fetchJson('https://np-listapi.eastmoney.com/comm/web/getFastNewsList'
        + '?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=3&req_trace=1', 9000)
        .then(j => '3 条样本，实际返回 ' + (((j.data || {}).fastNewsList || []).length) + ' 条')],
      ['腾讯指数', () => Desk.txQuotes(['sh000001']).then(q => q && q.sh000001
        ? '上证 ' + fmtNum(q.sh000001.value, 2) : Promise.reject(new Error('无返回')))],
      ['CNBC', () => Desk.cnbcQuotes(['US10Y']).then(q => q && q.US10Y
        ? '美债10Y ' + fmtNum(q.US10Y.value, 3) + '%' : Promise.reject(new Error('无返回')))],
      ['东财仓单', () => Desk.emStock(['TA']).then(q => q && q.TA
        ? 'PTA 仓单 ' + fmtNum(q.TA.zh * 5 / 10000, 4) + ' 万吨 (' + q.TA.date + ')'
        : Promise.reject(new Error('无返回')))]
    ];
    for (const [name, fn] of probes) {
      try {
        const msg = await fn();
        out.push('  ' + tick(true) + ' ' + esc(name).padEnd(10, ' ') + esc(String(msg)));
      } catch (e) {
        out.push('  ' + tick(false) + ' ' + esc(name).padEnd(10, ' ') +
                 '<span class="er">' + esc(e.message || String(e)) + '</span>');
      }
    }

    out.push('');
    out.push('<span class="hl">情报流状态</span>');
    try {
      const n = (typeof News !== 'undefined' && News.state) ? News.state.items.length : null;
      out.push('  已载 ' + (n === null ? '<span class="er">模块未加载</span>' : n + ' 条') +
               ' · 频道 <span class="hl">' + esc((News.state || {}).channel || '—') + '</span>' +
               ' · 页面上渲染 <span class="hl">' + document.querySelectorAll('#newsList .ni').length + '</span> 条');
    } catch (e) {
      out.push('  <span class="er">读取失败：' + esc(e.message) + '</span>');
    }

    out.push('');
    out.push('<span style="opacity:.6">对照：文件探测全 200、模块全 ✓、联网全 ✓ = 部署没问题。</span>');
    return out;
  }

  /** 启动时先确认模块都在。缺了就顶部挂一条横幅，别让面板静默空白 */
  function moduleBanner () {
    const missing = [];
    for (const m of SELF_CHECK_MODULES) {
      let ok = false;
      try { ok = !!m.has(); } catch (e) { ok = false; }
      if (!ok) missing.push(m);
    }
    if (!missing.length) return true;
    const box = document.createElement('div');
    box.className = 'banner';
    box.innerHTML = '<b>有 ' + missing.length + ' 个文件没加载成功</b>　' +
      missing.map(m => esc(m.file)).join('、') +
      '　—— 多半是上传时路径不对（应该放在仓库的 assets/ 目录下，不是仓库根目录）。' +
      '　按 <b>/</b> 或点底部「自检」看逐个文件的探测结果。';
    document.body.insertBefore(box, document.body.firstChild);
    return false;
  }

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
    // 全球市场：点折叠标题切换展开 / 点瓦片聚焦到右栏 Inspector
    $('world').addEventListener('click', e => {
      const tg = e.target.closest('[data-toggle]');
      if (tg) {
        S.open[tg.dataset.toggle] = !groupOpen(tg.dataset.toggle);
        paintWorld();
        return;
      }
      if (e.target.closest('[data-wclose]')) { unfocusWorld(); return; }
      const t = e.target.closest('[data-wid]');
      if (!t) return;
      focusWorld(t.dataset.wid);
    });
    // 聚焦面板的「收起」按钮（宿主在 #world 外面，单独绑定）
    const wfClose = $('wfocusClose');
    if (wfClose) wfClose.addEventListener('click', () => unfocusWorld());
    // Esc 退出聚焦（终端开着的时候不抢）
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && S.focus && $('terminal').hidden) unfocusWorld();
    });
    // 手动改地址栏 / 收藏之间切换也要生效
    window.addEventListener('hashchange', () => {
      const h = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
      if (/^w=/i.test(h)) {
        const id = h.slice(2);
        if (S.world && worldFlat()[id] && S.focus !== id) focusWorld(id);
      } else if (S.focus && !h) {
        unfocusWorld();
      }
    });
    $('heat').addEventListener('click', e => {
      const b = e.target.closest('.tile'); if (!b) return;
      const code = b.dataset.code;
      if (S.desk.chart_map[code]) { S.sym = code; selectSym(); }
      else $('klineState').innerHTML = '<b>' + esc(code) + '</b> 只有现货报价，没有盘面。';
    });
    const btnSelf = $('btnSelfCheck');
    if (btnSelf) btnSelf.addEventListener('click', () => Terminal.exec('doctor'));

    $('btnRefresh').addEventListener('click', async () => {
      $('btnRefresh').textContent = '刷新中';
      $('btnRefresh').disabled = true;
      await boot(true);
      $('btnRefresh').textContent = '刷新';
      $('btnRefresh').disabled = false;
    });

    // 后台标签页被浏览器节流到 ~1 发/分；前台回来立刻追平，而不是干等下一轮。
    // 情报流用独立的 lastNewsAt，别和世界行情 / K 线混着算时限。
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      const now = Date.now();
      if (S.lastNewsAt && now - S.lastNewsAt > 30e3) refreshNews();
      if (S.world && now - S.world.at > 50e3) renderWorld();
      loadKlineStale(now, 4 * 60e3);
      renderCalendar(); renderFresh();
    });
  }

  async function boot (force = false) {
    // 模块没齐就别往下跑 —— 先把问题摆到明面上，而不是留一堆空面板
    if (!moduleBanner()) {
      $('klineState').innerHTML = '<span class="up">有文件没加载成功，K 线无法初始化。' +
        '按 / 或点底部「自检」看是哪个文件 404 了。</span>';
      return;
    }
    if (force) Desk.nukeCache();
    bindOnce();
    if (!boot._newsInit) {
      boot._newsInit = true;
      News.init().then(() => { S.lastNewsAt = Date.now(); initMacro(); });
    }

    S.desk = await Desk.loadDesk();
    if (!S.desk) {
      const lede = $('briefLede');
      if (lede) lede.innerHTML = '<b>读不到 data/desk.json。</b>先运行 ' +
        '<span class="num">python3 tools/export_desk_json.py</span> 生成它。';
      $('klineState').innerHTML = '本地数据库未就绪，K 线暂不加载。';
      await renderWorld();
      return;
    }

    $('brandSub').textContent = '数据截止 ' + (S.desk.as_of || '—');
    renderSymTabs(); renderPerTabs();
    renderChain(); renderSpreads(); renderHeat(); renderProv(); renderBrief();
    renderCalendar();

    S.ai = await Desk.loadAiDigest();
    renderAi();

    // 先放骨架再取数：全球市场卡从 320px 长到 949px，
    // 没有占位的话首次加载会把滚动位置顶下去（CLS）
    worldSkeleton();
    await Promise.all([renderWorld(), loadKline()]);

    if (!boot._timers) { boot._timers = true; startTimers(); }
  }

  function esc (s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /** 开场读地址栏锚点，把常用视图存成书签：#PX、#PX/W、#w=sh000905、#term */
  function applyHash () {
    // desk.json 没加载成功时 boot() 会提前返回，但 .then(applyHash) 照样会跑。
    // 少了这道判断，恰恰在「设计上要能扛住」的那个失败场景里会抛 TypeError。
    if (!S.desk) return;
    const h = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
    if (!h) return;
    if (/^w=/i.test(h)) {
      const id = h.slice(2);
      if (S.world && worldFlat()[id]) focusWorld(id);
      return;
    }
    const [a, b] = h.split('/');
    if (a.toLowerCase() === 'term') { Terminal.show(); return; }
    const sym = Object.keys(S.desk.chart_map).find(k => k.toLowerCase() === a.toLowerCase());
    const per = PERIODS.find(p => p.id.toLowerCase() === (b || '').toLowerCase());
    if (sym) { S.sym = sym; selectSym(); }
    if (per) { S.period = per.id; selectPer(); }
  }

  /** 把当前视图写回地址栏，方便收藏 / 直接分享「我盯的就是这一张」 */
  function writeHash (s) {
    try {
      const url = location.pathname + location.search + (s ? '#' + s : '');
      history.replaceState(null, '', url);
    } catch (e) { /* 某些内嵌浏览器不允许改地址，忽略 */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    Terminal.init();
    tickClock();
    setInterval(tickClock, 1000);
    boot().then(applyHash);
  });
})();
