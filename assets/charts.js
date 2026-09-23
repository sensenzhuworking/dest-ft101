/* ==========================================================================
   charts.js — TradingView Lightweight Charts v4 封装
   与 backtest-kit 用的是同一个图表库，但这里是纯静态引入，不需要 Node。

   这一版改了三件事（都是被真实问题逼出来的）：
     1. 多实例：原来全站只维护一个 chart/host，全球市场一开聚焦大图就会把主 K 线
        拆掉重建。现在按容器各自持有一份实例（WeakMap 语义，宿主被移除即回收）。
     2. 自动缩放复位：价格轴被拖过之后 autoScale 会永久关闭，切品种时新区间的
        蜡烛就跑到框外（PX 跑到框上方、原油掉到框下方就是这个原因）。
        现在每次取数都强制恢复 autoScale；同时手机端禁掉价格轴拖拽，
        双击图表 = 复位。这样「坐标系不匹配」这类问题从机制上不会再出现。
     3. 折线模式：本地库的现货/汇率只有收盘价序列，用带面积的折线画，
        不假装有成交价。
   ========================================================================== */
'use strict';

const Charts = (() => {

  /* 与 assets/app.css 的 token 保持同一套：这里只改色值，不动任何绘图逻辑。
     亮金只做「信号」：主力 K 线 MA 保持冷功能性蓝/灰（每日不抢眼），
     聚焦图（右栏 Inspector）MA 用亮金 —— 聚焦本身就是信号时刻。 */
  const UP = '#ff453a';       // 涨 = 红（中国习惯）· systemRed dark
  const DOWN = '#30d158';     // 跌 = 绿 · systemGreen dark
  const GOLD = '#f6cd72';     // 亮金（保时捷香槟金）—— 聚焦图 MA5（对应 app.css --ic）
  const IC = '#5a8fd6';       // 冷功能性蓝 —— 主力 K 线 MA5（去旧的蓝强调，退成功能色）
  const GREY = '#98989d';     // systemGray —— MA20，与蓝拉开距离
  const SEAGLASS = '#64d2ff'; // 浅蓝 —— MA10
  const FG2 = '#b9bfcb';   // 坐标轴文字 —— 与新白金平台同步提亮
  const GRID = 'rgba(255,255,255,.042)';   // 网格极淡：有刻度感但不抢走势
  const BORDER = 'rgba(255,255,255,.09)';
  /* 十字光标：垂直=金色细点线，水平=金色虚线端到端。
     金色是「当前指针」的信号，不与涨跌色混淆；深金底色标签压得住白字。 */
  const X_VERT = 'rgba(246,205,114,.55)';
  const X_HORZ = 'rgba(246,205,114,.32)';
  const X_LABEL = '#4b3a12';

  const MARGINS = { top: .08, bottom: .26 };
  /** 触屏设备：手指在右侧刻度上竖滑会被当成「拖价格轴」，
   *  这正是线上 PX/原油 K 线跑出框的触发点。触屏直接关掉这个手势。 */
  const COARSE = typeof matchMedia === 'function' &&
    matchMedia('(hover: none), (pointer: coarse)').matches;

  const insts = new Map();    // host 元素 → 图表实例
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- 时间格式化 ---------------- */

  function tickFormatter (t, type) {
    if (typeof t === 'string') {
      const [y, m, d] = t.split('-');
      return type >= 3 ? y + '/' + m : m + '/' + d;
    }
    const d = new Date(t * 1000);
    if (type >= 2) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function timeFormatter (t) {
    if (typeof t === 'string') return t;
    const d = new Date(t * 1000);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------------- 实例管理 ---------------- */

  function dispose (host) {
    const it = insts.get(host);
    if (!it) return;
    try { it.chart.remove(); } catch (e) { /* 已经拆过 */ }
    insts.delete(host);
  }

  /** 宿主被移除（比如全球市场重渲染）时顺手回收，避免泄漏 */
  function prune () {
    for (const host of [...insts.keys()]) if (!host.isConnected) dispose(host);
  }

  function make (host, kind, o) {
    const chart = LightweightCharts.createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight || o.height || 300,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: FG2,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: o.fontSize || 11
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: BORDER, scaleMargins: MARGINS },
      timeScale: {
        borderColor: BORDER,
        rightOffset: 3,
        barSpacing: o.barSpacing || 7,
        fixLeftEdge: true,
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: tickFormatter
      },
      localization: { locale: 'zh-CN', timeFormatter },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: X_VERT, width: 1, style: 1, labelBackgroundColor: X_LABEL },
        horzLine: { color: X_HORZ, width: 1, style: 3, labelBackgroundColor: X_LABEL }
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: {
        mouseWheel: false,
        pinch: true,
        // 触屏关掉价格轴拖拽：误触会让 autoScale 永久失效，见文件头说明
        axisPressedMouseMove: COARSE ? { time: true, price: false } : true
      }
    });

    const it = { kind, chart, series: [], host, key: null };
    insts.set(host, it);
    return it;
  }

  function withChart (host, kind, o = {}) {
    prune();
    let it = insts.get(host);
    if (!it || it.kind !== kind) {
      if (it) dispose(host);
      it = make(host, kind, o);
      if (!it) return null;
      bindReset(it);
    } else {
      // 尺寸可能因为布局变化（切手机版、聚焦面板展开）而变
      if (host.clientWidth && host.clientWidth !== it.chart.options().width) {
        it.chart.applyOptions({ width: host.clientWidth });
      }
    }
    return it;
  }

  /** 双击 / 双击触摸 = 复位（价格轴恢复自动缩放 + 时间轴回到最新） */
  function bindReset (it) {
    const reset = () => resetScale(it, true);
    it.chart.subscribeDblClick ? it.chart.subscribeDblClick(reset) : 0;
    it.host.addEventListener('dblclick', reset);
  }

  /** 关键修复：无论价格轴之前被谁拖过，重新取数就把 autoScale 拿回来 */
  function resetScale (it, fit) {
    try {
      it.chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: MARGINS });
      if (fit) it.chart.timeScale().fitContent();
    } catch (e) { /* 图表已拆 */ }
  }

  /* ---------------- 十字光标读数 ---------------- */

  function readoutHTML (p, it) {
    const c = p.seriesData.get(it.candle);
    if (!c) return '';
    const v = it.vol ? p.seriesData.get(it.vol) : null;
    const col = c.close >= c.open ? 'up' : 'down';
    const prev = it.lastClose;
    const chg = (prev != null && isFinite(c.close) && isFinite(prev)) ? c.close - prev : null;
    return '<span>' + (typeof p.time === 'string' ? p.time
              : new Date(p.time * 1000).toLocaleString('zh-CN', { hour12: false })) + '</span>' +
      '<span>开 <b>' + fmtNum(c.open, it.digits) + '</b></span>' +
      '<span>高 <b class="up">' + fmtNum(c.high, it.digits) + '</b></span>' +
      '<span>低 <b class="down">' + fmtNum(c.low, it.digits) + '</b></span>' +
      '<span>收 <b class="' + col + '">' + fmtNum(c.close, it.digits) + '</b></span>' +
      (chg == null ? '' : '<span>较前收 <b class="' + (chg >= 0 ? 'up' : 'down') + '">' +
        fmtSigned(chg, it.digits) + '</b></span>') +
      (v ? '<span>量 <b>' + fmtNum(v.value, 0) + '</b></span>' : '');
  }

  function readoutHTML_line (p, it) {
    const d = p.seriesData.get(it.line);
    if (!d) return '';
    return '<span>' + (typeof p.time === 'string' ? p.time : timeFormatter(p.time)) + '</span>' +
      '<span><b>' + fmtNum(d.value, it.digits) + '</b>' + (it.unit || '') + '</span>';
  }

  function attachReadout (it, readout, builder) {
    it.chart.subscribeCrosshairMove(p => {
      const box = readout; // 元素，不是 id：宿主换了也不会错指
      if (!box) return;
      box.innerHTML = (p && p.time) ? builder(p, it) : '';
    });
  }

  /* ---------------- MA ---------------- */

  function ma (bars, n) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].close;
      if (i >= n) sum -= bars[i - n].close;
      if (i >= n - 1) out.push({ time: bars[i].time, value: +(sum / n).toFixed(4) });
    }
    return out;
  }

  /** 区间统计：给聚焦面板用（区间高低、区间涨跌） */
  function stats (bars) {
    if (!bars || !bars.length) return null;
    let hi = -Infinity, lo = Infinity;
    for (const b of bars) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
    const first = bars[0], last = bars[bars.length - 1];
    return {
      n: bars.length,
      from: bars[0].time, to: last.time,
      high: hi, low: lo,
      chg: last.close - first.close,
      pct: first.close ? (last.close - first.close) / first.close * 100 : null
    };
  }

  /* ---------------- 画 K 线 ---------------- */

  /**
   * @param {HTMLElement} el
   * @param {Array} bars  [{time,open,high,low,close,volume}]
   * @param {object} o
   *   o.tail     只显示最后 N 根
   *   o.mas      均线周期数组，默认 [5,20]
   *   o.key      数据身份（品种|周期）。key 变了才 fitContent，同 key 刷新保留用户缩放
   *   o.readout  读数容器（元素）
   *   o.digits   小数位
   *   o.height / o.fontSize / o.barSpacing
   */
  function draw (el, bars, o = {}) {
    if (!el) return false;
    const it = withChart(el, 'candle', o);
    if (!it) return false;

    const data = o.tail ? bars.slice(-o.tail) : bars;
    if (!data.length) return false;

    // 成交量占下方 22%，独立价格轴
    if (!it.vol) {
      it.vol = it.chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        lastValueVisible: false,
        priceLineVisible: false
      });
      it.chart.priceScale('vol').applyOptions({ scaleMargins: { top: .80, bottom: 0 }, visible: false });
    }
    if (!it.candle) {
      it.candle = it.chart.addCandlestickSeries({
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
        wickUpColor: UP, wickDownColor: DOWN,
        priceLineVisible: false, lastValueVisible: true
      });
    }
    it.digits = o.digits == null ? (o.digitsAuto ? autoDigits(data) : 2) : o.digits;

    const periods = o.mas || [5, 20];
    const colors = o.masColors || [IC, GREY, SEAGLASS];
    periods.forEach((n, i) => {
      if (!it.series[i]) {
        it.series[i] = it.chart.addLineSeries({
          color: colors[i] || GREY, lineWidth: 1.6,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
        });
      }
      it.series[i].setData(ma(data, n));
    });

    it.candle.applyOptions({
      priceFormat: { type: 'price', precision: it.digits, minMove: Math.pow(10, -it.digits) }
    });
    it.candle.setData(data);
    it.vol.setData(data.map(b => ({
      time: b.time,
      value: b.volume || 0,
      color: b.close >= b.open ? 'rgba(240,85,78,.32)' : 'rgba(45,190,138,.30)'
    })));
    it.lastClose = data.length > 1 ? data[data.length - 2].close : null;

    const key = o.key || 'default';
    resetScale(it, key !== it.key);
    it.key = key;

    if (o.readout && !it.boundReadout) { it.boundReadout = true; attachReadout(it, o.readout, readoutHTML); }
    return true;
  }

  /** 只有收盘价序列时用折线 + 面积，不假装有开高低 */
  function drawLine (el, points, o = {}) {
    if (!el || !points || points.length < 2) return false;
    const it = withChart(el, 'line', o);
    if (!it) return false;
    if (!it.line) {
      it.line = it.chart.addAreaSeries({
        lineColor: o.color || IC,
        lineWidth: 2,
        topColor: hexA(o.color || IC, .22),
        bottomColor: hexA(o.color || IC, .01),
        priceLineVisible: false,
        lastValueVisible: true
      });
    }
    it.digits = o.digits == null ? 2 : o.digits;
    it.unit = o.unit || '';
    it.line.applyOptions({
      lineColor: o.color || IC,
      topColor: hexA(o.color || IC, .22),
      bottomColor: hexA(o.color || IC, .01),
      priceFormat: { type: 'price', precision: it.digits, minMove: Math.pow(10, -it.digits) }
    });
    it.line.setData(points.map(([time, value]) => ({ time, value })));
    const key = o.key || 'line';
    resetScale(it, key !== it.key);
    it.key = key;
    if (o.readout && !it.boundReadout) { it.boundReadout = true; attachReadout(it, o.readout, readoutHTML_line); }
    return true;
  }

  /** #0a84ff → rgba(10,132,255,.22) */
  function hexA (hex, a) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex));
    if (!m) return hex;
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
  }

  /** 价格量级差很大（原油 724 / PX 9300），小数位跟着量级自动走 */
  function autoDigits (bars) {
    const v = Math.abs(bars[bars.length - 1].close);
    if (v >= 1000) return 1;
    if (v >= 100) return 2;
    return 3;
  }

  /* ---------------- 价差迷你走势（自己画 SVG，不引第二个图表库） ---------------- */

  /**
   * @param {number[]} values 数值序列
   * @param {object} o {w,h,color}
   *   color 传了就按它上色 —— 瓦片里今天的涨跌和 60 天趋势常常不同向，
   *   同一张瓦片内保持一个颜色才不会让人读错。不传则按首尾方向。
   */
  function spark (values, o = {}) {
    const w = o.w || 120, h = o.h || 26, padY = 3;
    const v = values.filter(x => x !== null && isFinite(x));
    if (v.length < 2) return '';
    const min = Math.min(...v), max = Math.max(...v);
    const span = (max - min) || 1;
    const px = i => (i / (v.length - 1)) * (w - 2) + 1;
    const py = x => h - padY - ((x - min) / span) * (h - padY * 2);

    let d = '';
    v.forEach((x, i) => { d += (i ? 'L' : 'M') + px(i).toFixed(1) + ' ' + py(x).toFixed(1); });

    const rising = v[v.length - 1] >= v[0];
    const color = o.color || (rising ? UP : DOWN);
    const base = py(min).toFixed(1);

    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" ' +
           'preserveAspectRatio="none" role="img" aria-label="迷你走势">' +
           '<path d="' + d + 'L' + px(v.length - 1).toFixed(1) + ' ' + base +
           'L' + px(0).toFixed(1) + ' ' + base + 'Z" fill="' + color + '" opacity="0.10"/>' +
           '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.3"/>' +
           '<circle cx="' + px(v.length - 1).toFixed(1) + '" cy="' + py(v[v.length - 1]).toFixed(1) +
           '" r="1.8" fill="' + color + '"/></svg>';
  }

  /** 涨跌 → 十六进制色，供外部对齐瓦片配色 */
  const colorFor = pct =>
    (pct === null || pct === undefined || !isFinite(pct) || Math.abs(pct) < 1e-9) ? GREY
      : (pct > 0 ? UP : DOWN);

  /* ---------------- 尺寸变化 ---------------- */

  function resize () {
    prune();
    for (const it of insts.values()) {
      const w = it.host.clientWidth, h = it.host.clientHeight;
      if (w > 0 && h > 0) { try { it.chart.applyOptions({ width: w, height: h }); } catch (e) {} }
    }
  }
  window.addEventListener('resize', () => { clearTimeout(resize._t); resize._t = setTimeout(resize, 120); });

  return { draw, drawLine, resize, spark, colorFor, ma, stats, dispose, esc, COARSE, GOLD };
})();
