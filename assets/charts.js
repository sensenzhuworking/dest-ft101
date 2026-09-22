/* ==========================================================================
   charts.js — K 线（TradingView Lightweight Charts v4）+ 价差迷你走势
   与 backtest-kit 用的是同一个图表库，但这里是纯静态引入，不需要 Node。
   ========================================================================== */
'use strict';

const Charts = (() => {

  const UP = '#f0554e';       // 涨 = 红（中国习惯）
  const DOWN = '#27c08a';     // 跌 = 绿
  const IC = '#0091d4';       // Imperial Pool Blue —— 主强调
  const IC_DEEP = '#003e74';  // Imperial Blue —— 深填充
  const GREY = '#9d9d9d';     // Cool Grey —— MA20，与蓝拉开距离
  const SEAGLASS = '#009cbc';
  const FG2 = '#8a93a5';
  const GRID = 'rgba(255,255,255,.045)';
  const BORDER = 'rgba(255,255,255,.07)';

  let chart = null, candle = null, ma5 = null, ma20 = null, vol = null, host = null;

  const pad = n => String(n).padStart(2, '0');

  function ensure (el) {
    if (chart && host === el) return true;
    if (chart) { try { chart.remove(); } catch (e) {} chart = null; }
    host = el;
    if (!el || !el.clientWidth) return false;

    chart = LightweightCharts.createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight || 300,
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: FG2,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: BORDER, scaleMargins: { top: .08, bottom: .26 } },
      timeScale: {
        borderColor: BORDER,
        rightOffset: 3,
        barSpacing: 7,
        fixLeftEdge: true,
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: (t, type) => {
          if (typeof t === 'string') {                       // 日线 / 周线
            const [y, m, d] = t.split('-');
            return type >= 3 ? y + '/' + m : m + '/' + d;
          }
          const d = new Date(t * 1000);                      // 分钟线
          if (type >= 2) return pad(d.getHours()) + ':' + pad(d.getMinutes());
          return (d.getMonth() + 1) + '/' + d.getDate();
        }
      },
      localization: {
        locale: 'zh-CN',
        timeFormatter: t => {
          if (typeof t === 'string') return t;
          const d = new Date(t * 1000);
          return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                 ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: 'rgba(0,145,212,.6)', width: 1, style: 2, labelBackgroundColor: '#0b3050' },
        horzLine: { color: 'rgba(0,145,212,.6)', width: 1, style: 2, labelBackgroundColor: '#0b3050' }
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true }
    });

    // 成交量放在下方 22% 的区域，独立价格轴
    vol = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
      priceLineVisible: false
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: .80, bottom: 0 }, visible: false });

    // 蜡烛在成交量之上重绘
    candle = chart.addCandlestickSeries({
      upColor: UP, downColor: DOWN,
      borderUpColor: UP, borderDownColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
      priceLineVisible: false, lastValueVisible: true        // 最新价横线交给价格轴
    });

    ma5 = chart.addLineSeries({ color: IC, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    ma20 = chart.addLineSeries({ color: GREY, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

    chart.subscribeCrosshairMove(onMove);
    return true;
  }

  /** 十字光标读数 */
  function onMove (p) {
    const box = document.getElementById('klineOhlc');
    if (!box) return;
    if (!p || !p.time || !candle) { box.innerHTML = ''; return; }
    const c = p.seriesData.get(candle);
    const v = p.seriesData.get(vol);
    if (!c) { box.innerHTML = ''; return; }
    const col = c.close >= c.open ? 'up' : 'down';
    box.innerHTML =
      '<span>' + (typeof p.time === 'string' ? p.time : new Date(p.time * 1000).toLocaleString('zh-CN', { hour12: false })) + '</span>' +
      '<span>开 <b>' + fmtNum(c.open, 1) + '</b></span>' +
      '<span>高 <b class="up">' + fmtNum(c.high, 1) + '</b></span>' +
      '<span>低 <b class="down">' + fmtNum(c.low, 1) + '</b></span>' +
      '<span>收 <b class="' + col + '">' + fmtNum(c.close, 1) + '</b></span>' +
      (v ? '<span>量 <b>' + fmtNum(v.value, 0) + '</b></span>' : '');
  }

  function ma (bars, n) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].close;
      if (i >= n) sum -= bars[i - n].close;
      if (i >= n - 1) out.push({ time: bars[i].time, value: +(sum / n).toFixed(2) });
    }
    return out;
  }

  /**
   * 渲染一组 K 线。
   * @param {HTMLElement} el 容器
   * @param {Array} bars     已排序的 {time,open,high,low,close,volume}
   * @param {number} tail    只显示最后 N 根
   */
  function render (el, bars, tail = 180) {
    if (!ensure(el)) return false;
    const data = bars.slice(-tail);
    if (!data.length) return false;

    candle.setData(data);
    vol.setData(data.map(b => ({
      time: b.time,
      value: b.volume || 0,
      color: b.close >= b.open ? 'rgba(240,85,78,.34)' : 'rgba(39,192,138,.34)'
    })));
    ma5.setData(ma(data, 5));
    ma20.setData(ma(data, 20));
    chart.timeScale().fitContent();
    return true;
  }

  function resize () {
    if (chart && host && host.clientWidth) {
      chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
    }
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

  window.addEventListener('resize', () => { clearTimeout(resize._t); resize._t = setTimeout(resize, 120); });

  return { render, resize, spark, colorFor, ma };
})();
