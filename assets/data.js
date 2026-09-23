/* ==========================================================================
   data.js — 数据层
   四级降级，任何一级挂掉页面都还能用：
     1) 本地静态 data/desk.json   —— 你自己的数据库，永远在
     2) 新浪期货 JSONP           —— CN 期货日线/分钟线
     3) 腾讯 qt.gtimg.cn         —— A股/港股指数（CORS *）
     4) CNBC quote               —— 美债/美元指数/美股/VIX/金铜（CORS *）
   取不到就退回 localStorage 上一次成功的结果，并如实标注数据年龄。
   ========================================================================== */
'use strict';

const Desk = (() => {

  const T = {
    desk:    'data/desk.json?v=4',
    ai:      'data/ai_digest.json?v=4',
    sinaK:   'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20{cb}=/InnerFuturesNewService.getDailyKLine?symbol={sym}',
    sinaM:   'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20{cb}=/InnerFuturesNewService.getFewMinLine?symbol={sym}&type={type}',
    txQ:     'https://qt.gtimg.cn/q={ids}',
    txK:     'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={id},day,,,{days},qfq',
    // 通用日线（开高低收量）。指数不需要除权，A股/港股/美股指数同一条路；
    // 实测 us.DJI / us.INX / us.IXIC / sh000905 / hkHSI 都能直接取。
    txKB:    'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param={id},day,,,{days}',
    cnbc:    'https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols={ids}' +
             '&requestMethod=quick&noform=1&partnerId=2&fund=1&exthrs=1&output=json'
  };

  const CACHE_KEY = 'desk.cache.v5';
  const TTL = { desk: 0, kline: 5 * 60e3, txk: 30 * 60e3, txq: 45e3, cnbc: 45e3, sina: 10 * 60e3 };

  const state = { desk: null, cache: {}, sources: {}, worldAt: 0 };

  /* ---------------- 缓存 ---------------- */

  function readCache () {
    try { state.cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; }
    catch (e) { state.cache = {}; }
  }
  function writeCache () {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(state.cache)); }
    catch (e) { /* 隐私模式或超额，忽略 */ }
  }
  function put (key, val) { state.cache[key] = { t: Date.now(), v: val }; writeCache(); }
  function get (key, maxAge) {
    const hit = state.cache[key];
    if (!hit) return null;
    if (maxAge && Date.now() - hit.t > maxAge) return null;
    return hit.v;
  }

  /* ---------------- 底层请求 ---------------- */

  async function fetchJson (url, ms = 9000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const res = await fetch(url, { signal: ac.signal, credentials: 'omit', mode: 'cors',
                                referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  async function fetchText (url, ms = 9000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const res = await fetch(url, { signal: ac.signal, credentials: 'omit', mode: 'cors',
                                referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      // 腾讯行情是 GBK。中文名我们不用（自己带标签），解码失败也不影响数字。
      try { return new TextDecoder('gbk').decode(buf); }
      catch (e) { return new TextDecoder('utf-8').decode(buf); }
    } finally { clearTimeout(timer); }
  }

  /** JSONP 加载器：新浪返回 `var _xxx=([...]);`，读 window[varName] 即可。
   *  回调名写死在 URL 路径里，所以名字必须是「确定的」——
   *  确定 = URL 稳定 = 能被浏览器 HTTP 缓存；同时按 (品种,周期) 各自一个名字，
   *  并发请求不同周期时不会互相覆盖 window 上的变量。 */
  function jsonp (url, varName, { timeout = 14000, buster = false } = {}) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      let settled = false;
      const timer = setTimeout(() => done(new Error('timeout')), timeout);
      function done (err) {
        if (settled) return;
        settled = true; clearTimeout(timer); s.remove();
        if (err) reject(err);
      }
      const finalUrl = url.replace('{cb}', varName) +
        (buster ? (url.includes('?') ? '&' : '?') + '_=' + Date.now() : '');
      s.src = finalUrl;
      s.async = true;
      s.referrerPolicy = 'no-referrer';   // 有的接口按 Referer 拦外部站（东财就是这样）
      s.onerror = () => done(new Error('network'));
      s.onload = () => {
        const v = window[varName];
        if (v === undefined || v === null) return done(new Error('empty'));
        done(null); resolve(v);
      };
      document.head.appendChild(s);
    });
  }

  /* ---------------- 1. 本地数据库 ---------------- */

  async function loadDesk () {
    if (state.desk) return state.desk;
    const cached = get('desk', 0);
    if (cached) state.desk = cached;
    try {
      const fresh = await fetchJson(T.desk, 12000);
      state.desk = fresh;
      put('desk', fresh);
      state.sources.desk = { ok: true, at: Date.now() };
    } catch (e) {
      state.sources.desk = { ok: !!cached, at: Date.now(), err: String(e.message || e) };
    }
    return state.desk;
  }

  /** AI 复盘（可选产物，没有就静默跳过） */
  async function loadAiDigest () {
    try { return await fetchJson(T.ai, 8000); }
    catch (e) { return null; }
  }

  /* ---------------- 2. 新浪期货 K 线 ---------------- */

  const SINA = { SC: 'SC0', PX: 'PX0', PTA: 'TA0', MEG: 'EG0', PF: 'PF0', PR: 'PR0' };

  async function kline (code, periodId, { buster = false } = {}) {
    const sym = (state.desk && state.desk.chart_map[code] && state.desk.chart_map[code].sina) || SINA[code];
    const key = 'k:' + code + ':' + periodId;
    const fresh = get(key, TTL.kline);
    if (fresh && !buster) return { bars: fresh, from: 'cache' };

    const isWeekly = periodId === 'W';
    let raw;
    if (periodId === 'D' || isWeekly) {
      // 日线与周线用不同的回调名，否则同时请求两者会互相覆盖 window 变量
      raw = await jsonp(T.sinaK.replace('{sym}', sym), (isWeekly ? '_w' : '_d') + sym, { buster });
      raw = raw.map(x => ({ time: x.d, open: +x.o, high: +x.h, low: +x.l, close: +x.c, volume: +x.v || 0 }));
      if (isWeekly) raw = toWeekly(raw);
    } else {
      // 分钟线必须用 UNIX 秒：传 'YYYY-MM-DD HH:MM:SS' 不会在 setData 报错，
      // 而是下一帧抛 "Value is null"。按本地时区解析，配合本地化格式化器才不会偏 8 小时。
      raw = await jsonp(T.sinaM.replace('{sym}', sym).replace('{type}', periodId),
                        '_m' + sym + periodId, { buster });
      raw = raw.map(x => ({
        time: Math.floor(new Date(String(x.d).replace(' ', 'T')).getTime() / 1000),
        open: +x.o, high: +x.h, low: +x.l, close: +x.c, volume: +x.v || 0
      }));
    }
    raw = sanitize(raw);
    put(key, raw);
    return { bars: raw, from: 'network' };
  }

  function toWeekly (daily) {
    const out = [];
    let cur = null, curKey = null;
    for (const b of daily) {
      const d = new Date(b.time + 'T00:00:00Z');
      const dow = (d.getUTCDay() + 6) % 7;
      const monday = new Date(d.getTime() - dow * 864e5).toISOString().slice(0, 10);
      if (monday !== curKey) {
        if (cur) out.push(cur);
        curKey = monday;
        cur = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      } else {
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += b.volume;
        cur.time = b.time;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function sanitize (bars) {
    return bars
      .filter(b => {
        if (!b) return false;
        const timeOk = typeof b.time === 'string' ? !!b.time : isFinite(b.time);
        return timeOk && isFinite(b.open) && isFinite(b.high) &&
               isFinite(b.low) && isFinite(b.close) && b.close > 0;
      })
      .sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
  }

  /* ---------------- 3. 腾讯：指数实时报价 ---------------- */
  /*
     只有「全版」格式（不加 s_ 前缀）字段位才一致，实测：
       f[3]=最新  f[4]=昨收  f[5]=今开
       f[30]=时间 f[31]=涨跌额 f[32]=涨跌幅% f[33]=最高 f[34]=最低
     交叉校验：上证 3952.13 − 昨收 3949.91 = 涨跌额 2.22 ✓
     用 s_ 简版会让 f[4]/f[5] 变成别的含义，所以全站只用全版。
  */
  async function txQuotes (ids) {
    if (!ids.length) return {};
    const key = 'txq:' + ids.join(',');
    const cached = get(key, TTL.txq);
    if (cached) return cached;

    const txt = await fetchText(T.txQ.replace('{ids}', ids.join(',')));
    const out = {};
    for (const line of txt.split(';')) {
      const m = line.trim().match(/^v_([A-Za-z0-9._]+)="(.*)"$/);
      if (!m) continue;
      const f = m[2].split('~');
      if (f.length < 35) continue;
      const price = parseFloat(f[3]);
      const prev = parseFloat(f[4]);
      let chg = parseFloat(f[31]);
      let pct = parseFloat(f[32]);
      // 个别品种不给涨跌字段，用最新−昨收兜底，保证正负号不会错
      if (!isFinite(chg) && isFinite(price) && isFinite(prev)) chg = price - prev;
      if (!isFinite(pct) && isFinite(chg) && isFinite(prev) && prev) pct = chg / prev * 100;
      if (!isFinite(price) || price <= 0) continue;
      out[m[1]] = {
        id: m[1], value: price, prev: prev, chg: chg, pct: pct,
        ts: parseQuoteTime(f[30]), live: true, src: '腾讯'
      };
    }
    if (!Object.keys(out).length) throw new Error('腾讯行情未解析出数据');
    put(key, out);
    return out;
  }

  function parseQuoteTime (s) {
    if (!s) return null;
    const t = String(s).trim();
    let m = t.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    m = t.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);   // 20260922161401
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return null;
  }

  /* ---------------- 4. 腾讯：指数日线（趋势 + 聚焦大图） ----------------
     字段序两种接口一致：日期, 开, 收, 高, 低, 量
     先走通用接口（美股指数只有这条），失败再退回原来那条（A股/港股实测稳）。
     VIX 不在名单里：腾讯的 VIX 历史是一串常数，画出来是假线，不如不画。 */

  async function txBars (id, days = SPARK_DAYS) {
    const key = 'txb:' + id + ':' + days;
    const cached = get(key, TTL.txk);
    if (cached) return cached;

    let arr = null;
    try {
      const j = await fetchJson(T.txKB.replace('{id}', id).replace('{days}', days), 9000);
      const node = j && j.data && j.data[id];
      arr = node && (node.day || node.qfqday);
    } catch (e) { arr = null; }

    if (!Array.isArray(arr) || !arr.length) {
      const j = await fetchJson(T.txK.replace('{id}', id).replace('{days}', days), 9000);
      const node = j && j.data && j.data[id];
      arr = node && (node.qfqday || node.day);
    }
    if (!Array.isArray(arr) || !arr.length) throw new Error('腾讯日线为空');

    const out = arr.map(r => ({
      time: String(r[0]).slice(0, 10),
      open: parseFloat(r[1]), close: parseFloat(r[2]),
      high: parseFloat(r[3]), low: parseFloat(r[4]),
      volume: parseFloat(r[5]) || 0
    })).filter(b => isFinite(b.open) && isFinite(b.close) &&
                    isFinite(b.high) && isFinite(b.low) && b.close > 0);
    if (!out.length) throw new Error('腾讯日线字段异常');
    out.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
    put(key, out);
    return out;
  }

  /** 只要收盘价序列（画迷你趋势用），走同一份缓存，不重复打接口 */
  async function txKline (id, days = SPARK_DAYS) {
    return (await txBars(id, days)).map(b => ({ time: b.time, close: b.close }));
  }

  /* ---------------- 4b. 聚焦面板的数据分发 ----------------
     全球市场每一张瓦片点开都要有东西可看。有日线画 K 线，只有收盘价画折线，
     什么历史都没有就老老实实只给一个数值卡 —— 不编数据。
     本地库的现货/汇率序列在 desk.json 的 series / fx 里。 */

  async function itemSeries (it) {
    if (it.kline) {
      const bars = await txBars(it.kline, FOCUS_DAYS);
      return { kind: 'bars', bars, src: '腾讯日线', unit: it.unit || '' };
    }
    const d = state.desk;
    if (it.srcId === 'desk' && d && it.desk) {
      const [code, pt] = it.desk;
      const s = d.series && d.series[code] && d.series[code][pt];
      if (Array.isArray(s) && s.length >= 2) {
        return { kind: 'line', points: s, src: '本地库（日频）', unit: it.unit || '' };
      }
    }
    if (it.srcId === 'deskFx' && d && d.fx && d.fx[it.id]) {
      const f = d.fx[it.id];
      if (Array.isArray(f.series) && f.series.length >= 2) {
        return { kind: 'line', points: f.series, src: '汇率库（日频）', unit: '' };
      }
    }
    if (it.srcId === 'em_stock') {
      const s = await emStockHistory(it.id, it.tons || 5);
      if (s.length >= 2) return { kind: 'line', points: s, src: '东财数据中心（日频）', unit: '万吨' };
    }
    return { kind: 'none', src: it.src };
  }

  /* ---------------- 5. CNBC：美债/美元/美股/商品 ---------------- */

  async function cnbcQuotes (ids) {
    if (!ids.length) return {};
    const key = 'cnbc:' + ids.join('|');
    const cached = get(key, TTL.cnbc);
    if (cached) return cached;

    const url = T.cnbc.replace('{ids}', ids.map(encodeURIComponent).join('%7C'));
    const j = await fetchJson(url, 10000);
    const list = j && j.QuickQuoteResult && j.QuickQuoteResult.QuickQuote;
    if (!Array.isArray(list)) throw new Error('CNBC 返回格式异常');
    const out = {};
    for (const q of list) {
      const v = parseFloat(q.last);
      if (!isFinite(v)) continue;
      out[q.symbol] = {
        id: q.symbol, value: v,
        chg: parseFloat(q.change),
        pct: parseFloat(q.change_pct),
        name: q.shortName || q.name || q.symbol,
        ts: q.last_time ? new Date(q.last_time).getTime() : null,
        live: true, src: 'CNBC'
      };
    }
    if (!Object.keys(out).length) throw new Error('CNBC 未解析出数据');
    put(key, out);
    return out;
  }

  /* ---------------- 6. 东财数据中心：交易所仓单 ----------------
     这是唯一能在浏览器里【复现你管道】的一块：
       实测 2026-09-16 TA 13435 张 × 5 ÷ 10000 = 6.7175 万吨
       你 Excel Inventory 同日 = 6.7175 万吨 —— 完全吻合
     所以仓单不用等你的数据。

     拿不到现货的原因（实测过，不是推测）：
       www.100ppi.com/sf/ 和 /mprice/ 都【没有 CORS 头】，
       而且返回的是混淆过的反爬 JS 挑战页，不是数据；
       郑商所/大商所的日行情同样没有 CORS，而且是 http（https 页面会被混合内容拦掉）。
     结论：现货必须在你有网络的电脑上抓，或者走一个服务端代理。
  */
  const EM_DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

  async function emStock (codes) {
    const out = {};
    await mapLimit(codes, 2, async (code) => {
      const key = 'emst:' + code;
      const cached = get(key, 6 * 3600e3);            // 仓单日频，缓存 6 小时
      if (cached) { out[code] = cached; return; }
      const filter = encodeURIComponent('(SECURITY_CODE="' + code + '")');
      const url = EM_DC + '?reportName=RPT_FUTU_STOCKDATA'
        + '&columns=SECURITY_CODE,TRADE_DATE,ON_WARRANT_NUM,ADDCHANGE'
        + '&filter=' + filter
        + '&pageNumber=1&pageSize=2&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB';
      const j = await fetchJson(url, 9000);
      const rows = (j && j.result && j.result.data) || [];
      if (!rows.length) return;
      const r = rows[0];
      const rec = {
        zh: +r.ON_WARRANT_NUM,
        chgZh: +r.ADDCHANGE || 0,
        date: String(r.TRADE_DATE || '').slice(0, 10),
        live: false, src: '东财数据中心'
      };
      out[code] = rec;
      put(key, rec);
    });
    return out;
  }

  /** 仓单历史：同一个接口，把 pageSize 放大就是逐日序列。
   *  仓单增减是 PTA/PX 最直接的一手矛盾，点开瓦片就能看这条线。 */
  async function emStockHistory (code, tons = 5, days = 90) {
    const key = 'emhist:' + code + ':' + tons;
    const cached = get(key, 6 * 3600e3);
    if (cached) return cached;
    const filter = encodeURIComponent('(SECURITY_CODE="' + code + '")');
    const url = EM_DC + '?reportName=RPT_FUTU_STOCKDATA'
      + '&columns=SECURITY_CODE,TRADE_DATE,ON_WARRANT_NUM'
      + '&filter=' + filter
      + '&pageNumber=1&pageSize=' + days +
      '&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB';
    const j = await fetchJson(url, 9000);
    const rows = (j && j.result && j.result.data) || [];
    if (!rows.length) throw new Error('仓单历史为空');
    const out = rows
      .map(r => [String(r.TRADE_DATE || '').slice(0, 10), (+r.ON_WARRANT_NUM) * tons / 10000])
      .filter(x => x[0] && isFinite(x[1]))
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    if (!out.length) throw new Error('仓单历史字段异常');
    put(key, out);
    return out;
  }

  /* ---------------- 7. 组装全球市场面板 ---------------- */

  function deskValue (spec) {
    const d = state.desk;
    if (!d) return null;
    const [code, pt] = spec;
    const l = d.latest[code] && d.latest[code][pt];
    if (!l) return null;
    return { value: l.value, chg: l.chg, pct: l.chg_pct, asOf: l.date, live: false, src: '本地库' };
  }

  function deskFxValue (tab) {
    const d = state.desk;
    const f = d && d.fx && d.fx[tab];
    if (!f || !f.latest) return null;
    return { value: f.latest.value, chg: f.latest.chg, pct: f.latest.chg_pct,
             asOf: f.latest.date, live: false, src: '汇率库' };
  }

  /**
   * 取回整个全球市场面板。每个瓦片独立失败，互不牵连。
   * @returns Object：{ groups: Array, at: number, errs: Array<string> }
   */
  async function world () {
    const errs = [];
    const all = WORLD_GROUPS.flatMap(g => g.items);

    const txIds    = all.filter(i => i.src === 'tx').map(i => i.id);
    const cnbcIds  = all.filter(i => i.src === 'cnbc').map(i => i.id);
    const whIds    = all.filter(i => i.src === 'em_stock').map(i => i.id);

    // 三类在线源并行；单源失败不影响别的源
    const [txRes, cnbcRes, whRes] = await Promise.all([
      txQuotes(txIds).catch(e => { errs.push('腾讯行情: ' + e.message); return null; }),
      cnbcQuotes(cnbcIds).catch(e => { errs.push('CNBC: ' + e.message); return null; }),
      emStock(whIds).catch(e => { errs.push('仓单: ' + e.message); return null; })
    ]);

    const picks = {};
    for (const it of all) {
      if (it.src === 'tx')   picks[it.id] = txRes && txRes[it.id];
      if (it.src === 'cnbc') picks[it.id] = cnbcRes && cnbcRes[it.id];
      if (it.src === 'desk') picks[it.id] = deskValue(it.desk);
      if (it.src === 'deskFx') picks[it.id] = deskFxValue(it.id);
      if (it.src === 'em_stock') {
        const r = whRes && whRes[it.id];
        if (r) picks[it.id] = {
          value: r.zh * it.tons / 10000,        // 张 → 万吨，与你的 CirculatingInventory 同口径
          chg: r.chgZh * it.tons / 10000,
          pct: null,                            // 仓单看增减，不看百分比
          zh: r.zh,                             // 张数原值
          chgZh: r.chgZh,                       // 当日增减（张）—— 这个才是仓单的看点
          live: false, asOf: r.date, src: r.src
        };
      }
    }
    // 派生项：2s10s = 10Y − 2Y
    for (const it of all) {
      if (it.src !== 'spread') continue;
      const a = picks[it.from[0]], b = picks[it.from[1]];
      if (a && b) {
        const v = a.value - b.value;
        /* 涨跌也从两个分量各自的涨跌相减得出。
           以前这里写死 chg: null，于是 2s10s 那一格永远挂着一个孤零零的破折号 ——
           看着像取数失败，其实只是没算。现在它有真实的日变化。 */
        const chg = (isFinite(a.chg) && isFinite(b.chg)) ? +(a.chg - b.chg).toFixed(4) : null;
        picks[it.id] = { value: +v.toFixed(4), chg, pct: null, live: a.live, src: '派生' };
      }
    }

    // 趋势：只给有日线历史可取的（A股/港股）
    const needSpark = all.filter(i => i.kline && picks[i.id]);
    await mapLimit(needSpark, 3, async it => {
      try {
        const bars = await txKline(it.kline);
        if (bars.length >= 3) picks[it.id].spark = bars.map(b => b.close);
      } catch (e) { /* 趋势拿不到就不画，不影响数值 */ }
    });

    /* 仓单也要画迷你趋势。
       起因：注销期四个品种同时归零，「0.0000 万吨」×4 看着像取数失败。
       补上 90 天走势 + 「上次非零」之后，一眼能看出是真的一条线降到了 0，
       而不是没接到数据 —— 同时把「上次非零」的日期和数值一起带出来。 */
    const needWh = all.filter(i => i.src === 'em_stock' && picks[i.id]);
    await mapLimit(needWh, 2, async it => {
      try {
        const s = await emStockHistory(it.id, it.tons, 90);
        if (s.length >= 3) {
          picks[it.id].spark = s.map(x => x[1]);
          const nz = s.filter(x => x[1] > 0).pop();
          if (nz) picks[it.id].lastNonZero = { date: nz[0], value: nz[1] };
          picks[it.id].zeroSince = nz ? s[s.indexOf(nz) + 1] ? s[s.indexOf(nz) + 1][0] : null : null;
        }
      } catch (e) { /* 历史拿不到就不画，数值照旧 */ }
    });

    const groups = [];
    for (const g of WORLD_GROUPS) {
      const items = [];
      for (const it of g.items) {
        const p = picks[it.id];
        if (!p || !isFinite(p.value)) continue;
        // srcId 保留「配置里声明的源」：p.src 会被换成更好读的来源名
        // （本地库 / 汇率库 / 东财数据中心），聚焦面板要靠 srcId 决定怎么取历史
        items.push(Object.assign({}, it, p, { label: it.label, group: g.id, srcId: it.src }));
      }
      if (items.length) groups.push({ id: g.id, label: g.label, note: g.note, items });
    }

    state.worldAt = Date.now();
    state.sources.world = {
      ok: groups.length > 0, at: state.worldAt,
      tx: !!txRes, cnbc: !!cnbcRes, errs
    };
    return { groups, at: state.worldAt, errs };
  }

  async function mapLimit (arr, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
      while (i < arr.length) {
        const idx = i++;
        try { await fn(arr[idx], idx); } catch (e) { /* 单项失败已单独处理 */ }
      }
    });
    await Promise.all(workers);
  }

  /** 顶栏跑马灯：从 world 结果里挑几项 */
  function marqueeFrom (worldRes) {
    const flat = {};
    for (const g of worldRes.groups) for (const it of g.items) flat[it.id] = it;
    const out = [];
    for (const key of MARQUEE_PICK) {
      const it = key === 'OIL_DESK' ? flat['BRENT'] : flat[key];
      if (it) out.push(it);
    }
    state.sources.macro = { ok: out.length > 0, at: worldRes.at };
    return out;
  }

  /* ---------------- 对外 ---------------- */

  readCache();

  return {
    T, state, TTL,
    loadDesk, loadAiDigest, kline, world, marqueeFrom, txKline, txBars, itemSeries,
    cnbcQuotes, txQuotes, emStock, emStockHistory,
    get, put, jsonp, fetchJson,
    desk: () => state.desk,
    worldAt: () => state.worldAt,
    health: () => state.sources,
    nukeCache: () => { state.cache = {}; writeCache(); }
  };
})();

/* ==========================================================================
   通用格式化 —— 全站唯一的数字出口，避免各处 toFixed 不一致
   ========================================================================== */

function fmtNum (v, digits = 2) {
  if (v === null || v === undefined || v === '' || !isFinite(v)) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 10000) return n.toLocaleString('zh-CN', { maximumFractionDigits: digits });
  return n.toFixed(digits);
}

/** 涨跌方向 → CSS 类。中国习惯：涨红跌绿 */
function cls (v) {
  if (v === null || v === undefined || !isFinite(v) || Math.abs(v) < 1e-9) return 'flat';
  return v > 0 ? 'up' : 'down';
}

function fmtPct (v, digits = 2) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const n = Number(v);
  return (n > 0 ? '+' : '') + n.toFixed(digits) + '%';
}

function fmtSigned (v, digits = 2) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const n = Number(v);
  return (n > 0 ? '+' : '') + fmtNum(n, digits);
}

/** 去掉无意义的尾随零：1.0000 → 1 · 0.5000 → 0.5 · 0.0150 → 0.015
 *  只用在脚注、提示这类散文语境里。表格与数值列仍走 fmtNum，
 *  那边需要固定小数位来保证等宽数字纵向对齐。 */
function fmtTrim (v, digits = 4) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return String(Number(Number(v).toFixed(digits)));
}

/** 简洁时间：今天显示时分，昨天加前缀，更早显示月-日 */
function fmtWhen (iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(d)) return String(iso);
  const now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now.getTime() - 864e5);
  if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}
