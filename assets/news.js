/* ==========================================================================
   news.js — 情报流
   源：东方财富 7×24 快讯（实测 Access-Control-Allow-Origin: *，浏览器可直连）
   分频道靠关键词字典在前端过滤，不做逐源抓取 —— 频道活不活，看命中计数就知道。
   ========================================================================== */
'use strict';

const News = (() => {

  const API = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList' +
              '?client=web&biz=web_724&fastColumn=102&sortEnd={end}&pageSize={size}&req_trace={t}';

  const state = {
    items: [],          // {code,title,summary,showTime,sort,channels:Set}
    seen: new Set(),
    channel: 'all',
    sortEnd: '',
    loading: false,
    done: false,
    paused: false,
    timer: null,
    lastNew: 0
  };

  let listEl, metaEl, autoEl, moreBtn;

  /* 两个游标，用途不能混：
       —— 轮询/刷新：永远传空游标，只要最新一批。不读写 state.sortEnd。
       —— 「更早」：用 state.sortEnd 往更早翻，并把返回的新游标写回去。

     state.sortEnd 只在两处被写：① 首屏加载时种下初始值；② 点「更早」时推进。
     绝不被轮询改到 —— 否则「更早」会拿到已经加载过的区间，被去重吃掉、看着像没反应。
  */
  async function api (size, cursor) {
    const url = API.replace('{end}', encodeURIComponent(cursor))
                   .replace('{size}', size)
                   .replace('{t}', Date.now());
    const res = await fetch(url, { credentials: 'omit', mode: 'cors',
                                referrerPolicy: 'no-referrer' });   // 关键：不带 Referer，否则东财 WAF 返回 567
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const d = j && j.data;
    if (!d || !Array.isArray(d.fastNewsList)) throw new Error('格式异常');
    return d;
  }

  /** 最新一批。seed=true 时顺便种下翻页游标（只种一次） */
  async function fetchLatest (size = 60, seed = false) {
    const d = await api(size, '');
    if (seed && !state.sortEnd) state.sortEnd = d.sortEnd || '';
    return d.fastNewsList;
  }

  /** 更早一页，唯一的游标推进处 */
  async function fetchOlder (size = 40) {
    const d = await api(size, state.sortEnd);
    state.sortEnd = d.sortEnd || state.sortEnd;
    return d.fastNewsList;
  }

  function normalize (raw) {
    const out = [];
    for (const x of raw) {
      if (!x || !x.code || state.seen.has(x.code)) continue;
      state.seen.add(x.code);
      const title = (x.title || '').trim();
      const summary = (x.summary || '').trim();
      if (!title && !summary) continue;
      out.push({
        code: x.code,
        title: title || summary.slice(0, 60),
        summary,
        showTime: x.showTime || '',
        sort: +x.realSort || 0,
        isNew: false,
        channels: matchChannels(title + ' ' + summary)
      });
    }
    return out;
  }

  /** 关键词归类；顺带记下命中的词，用于高亮 */
  function matchChannels (text) {
    const s = new Set(['all']);
    for (const ch of NEWS_CHANNELS) {
      if (ch.id === 'all') continue;
      if (ch.kw.some(k => text.includes(k))) s.add(ch.id);
    }
    return s;
  }

  /** 只保留最近 MAX_ITEMS 条。
   *  被裁掉的 code 要从 seen 里删掉，否则「更早」翻回来会被去重逻辑吃掉、再也显示不出来。 */
  const MAX_ITEMS = 400;
  function trim () {
    if (state.items.length <= MAX_ITEMS) return;
    const dropped = state.items.splice(MAX_ITEMS);
    for (const x of dropped) state.seen.delete(x.code);
  }

  /** 找出文本里所有频道关键词的位置，避免用 replace 造成标签嵌套 */
  function ranges (text) {
    const kws = [];
    for (const ch of NEWS_CHANNELS) {
      if (ch.id === 'all' || state.channel === 'all' || ch.id === state.channel) kws.push(...ch.kw);
    }
    const all = NEWWORDS.concat([...new Set(kws)]);
    const hits = [];
    for (const k of all) {
      if (!k) continue;
      let i = text.indexOf(k);
      while (i !== -1) { hits.push([i, i + k.length]); i = text.indexOf(k, i + k.length); }
    }
    hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const h of hits) {
      const last = merged[merged.length - 1];
      if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
      else merged.push([h[0], h[1]]);
    }
    return merged;
  }

  function esc (s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function highlight (text) {
    const r = ranges(text);
    if (!r.length) return esc(text);
    let out = '', c = 0;
    for (const [a, b] of r) { out += esc(text.slice(c, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>'; c = b; }
    return out + esc(text.slice(c));
  }

  /* ---------------- 渲染 ---------------- */

  function current () {
    if (state.channel === 'all') return state.items;
    return state.items.filter(x => x.channels.has(state.channel));
  }

  function render () {
    if (!listEl) return;
    const list = current();
    if (!list.length) {
      listEl.innerHTML = '<p class="state" style="border:0;margin:0;padding:8px 2px">' +
        (state.done ? '该频道暂无命中' : '正在读取情报流…') + '</p>';
      paintMeta(0);
      return;
    }
    const html = list.map(x => {
      const url = 'https://finance.eastmoney.com/a/' + x.code + '.html';
      const first = [...x.channels].find(c => c !== 'all');
      const chTag = first ? '<span class="ch">' + esc(chLabel(first)) + '</span>' : '';
      const newTag = x.isNew ? '<span class="new">新</span>' : '';
      return '<a class="ni' + (x.isNew ? ' fresh' : '') + '" href="' + url + '"' +
             ' target="_blank" rel="noopener noreferrer">' +
             '<span class="t">' + esc(fmtWhen(x.showTime)) + newTag + chTag + '</span>' +
             '<p class="h">' + highlight(x.title) + '</p></a>';
    }).join('');
    listEl.innerHTML = html;
    paintMeta(list.length);
  }

  function chLabel (id) {
    const c = NEWS_CHANNELS.find(x => x.id === id);
    return c ? c.label : '';
  }

  function paintMeta (n) {
    if (metaEl) {
      const newest = state.items[0];
      const t = newest && newest.showTime
        ? new Date(String(newest.showTime).replace(' ', 'T')).getTime() : null;
      metaEl.innerHTML = '命中 ' + n + ' 条 · 已载 ' + state.items.length +
        (t ? ' · 最新 ' + esc(fmtAgo(t)) : '') +
        (state.done ? ' · 到底了' : '');
    }
    if (moreBtn) moreBtn.disabled = state.done;
  }

  /* ---------------- 自动滚动 ---------------- */

  function loop () {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || state.paused || document.hidden || !listEl) { state.timer = null; return; }
    const max = listEl.scrollHeight - listEl.clientHeight;
    if (max > 12) {
      if (listEl.scrollTop >= max - 1) {
        // 到底了，停 2.6 秒再从头开始，给眼睛一个落点
        state.paused = true;
        setAuto('回到顶部…');
        setTimeout(() => { listEl.scrollTop = 0; state.paused = false; setAuto('自动滚动'); kick(); }, 2600);
        return;
      }
      listEl.scrollTop += 0.42;
    }
    state.timer = requestAnimationFrame(loop);
  }

  function kick () {
    if (state.timer === null && !state.paused) state.timer = requestAnimationFrame(loop);
  }
  function hold () {
    state.paused = true;
    if (state.timer !== null) { cancelAnimationFrame(state.timer); state.timer = null; }
    setAuto('已暂停');
  }
  function release () {
    state.paused = false;
    setAuto('自动滚动');
    kick();
  }
  function setAuto (t) { if (autoEl) autoEl.textContent = t; }

  /* ---------------- 事件绑定 ---------------- */

  function bind () {
    listEl.addEventListener('mouseenter', hold);
    listEl.addEventListener('mouseleave', release);
    listEl.addEventListener('focus', hold);
    listEl.addEventListener('blur', release);
    // 手动滚轮/触摸时暂停一会儿，避免和自动滚动打架
    listEl.addEventListener('wheel', () => {
      hold();
      clearTimeout(bind._t);
      bind._t = setTimeout(release, 4000);
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (state.timer !== null) { cancelAnimationFrame(state.timer); state.timer = null; } }
      else kick();
    });
  }

  /* ---------------- 对外 ---------------- */

  async function init (onError) {
    listEl = document.getElementById('newsList');
    metaEl = document.getElementById('newsMeta');
    autoEl = document.getElementById('newsAuto');
    moreBtn = document.getElementById('btnMore');

    const tabs = document.getElementById('chanTabs');
    tabs.innerHTML = NEWS_CHANNELS.map(c =>
      '<button class="pill" type="button" data-ch="' + c.id + '" aria-pressed="' +
      (c.id === 'all') + '">' + c.label + '</button>').join('');
    tabs.addEventListener('click', e => {
      const b = e.target.closest('button[data-ch]');
      if (!b) return;
      state.channel = b.dataset.ch;
      tabs.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
      listEl.scrollTop = 0;
      render();
    });

    moreBtn.addEventListener('click', async () => {
      if (state.loading || state.done) return;
      state.loading = true;
      moreBtn.textContent = '读取中…';
      try {
        const raw = await fetchOlder(40);
        const add = normalize(raw);
        state.items = state.items.concat(add);
        if (!add.length) state.done = true;
        render();
      } catch (e) {
        state.done = true;
        setAuto('源不可达');
      } finally {
        state.loading = false;
        moreBtn.textContent = '更早';
      }
    });

    bind();
    return refresh(onError);
  }

  async function refresh (onError) {
    if (state.loading) return 0;
    state.loading = true;
    try {
      // 记下刷新前的最新时间戳，用来数出这次新增了几条
      const before = state.items[0] ? state.items[0].sort : 0;
      const raw = await fetchLatest(60, true);   // true = 首次顺便种下游标
      const add = normalize(raw);
      state.items.forEach(x => { x.isNew = false; });        // 上一轮的「新」标记要清掉
      if (before) add.forEach(x => { if (x.sort > before) x.isNew = true; });
      state.items = state.items.concat(add).sort((a, b) => b.sort - a.sort);
      trim();
      state.lastNew = before ? add.filter(x => x.sort > before).length : add.length;
      // 「新」标记只保留最新一批，避免越攒越多
      let kept = 0;
      for (const x of state.items) { if (x.isNew) { kept++; if (kept > 12) x.isNew = false; } }
      state.lastFetch = Date.now();
      render();
      kick();
      return state.lastNew;
    } catch (e) {
      if (onError) onError(e);
      if (!state.items.length) {
        listEl.innerHTML = '<p class="state" style="border:0;margin:0;padding:8px 2px">' +
          '情报源当前不可达。K 线与价差不受影响，点右上角「刷新」重试。</p>';
        setAuto('源不可达');
      }
      return -1;
    } finally {
      state.loading = false;
    }
  }

  return { init, refresh, state };
})();
