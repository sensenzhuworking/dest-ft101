/* ==========================================================================
   Cloudflare Worker —— 可选的「按需解读」代理
   --------------------------------------------------------------------------
   为什么需要它：
     前端跑在公开的 GitHub Pages 上，浏览器里的任何密钥都等于公开。
     所以第二种用法（点按钮 → 实时问一句）必须有一个持有密钥的服务端。

   部署（免费额度够用）：
     1. 装 wrangler：npm i -g wrangler && wrangler login
     2. wrangler secret put DEEPSEEK_API_KEY       # 填入你的 key
     3. wrangler secret put SHARED_TOKEN           # 自定义一串随机字符串
     4. 改下面 ALLOW_ORIGIN 为你自己的 Pages 域名
     5. wrangler deploy

   前端调用（把 URL 和 token 填进 assets/config.js 的 AI_PROXY）：
     fetch(AI_PROXY.url + '/digest', {
       method:'POST',
       headers:{'Content-Type':'application/json', 'X-Desk-Token': AI_PROXY.token},
       body: JSON.stringify({ context })
     })
   ========================================================================== */

const ALLOW_ORIGIN = 'https://YOUR-NAME.github.io';   // ← 改成你的 Pages 域名
const MODEL = 'deepseek-v4-flash';                    // deepseek-chat 已于 2026-07-24 停用
const MAX_OUT = 320;
const MAX_INPUT_CHARS = 4000;                         // 硬上限，防止有人拿它当免费通用 API

const SYSTEM = `你是聚酯产业链研究员，只依据用户给的数据说话：不给目标价、不预测点位、不引入没有的数据。
输出 JSON：{"digest":"2-3 句中文复盘，说明核心矛盾与成本-需求传导是否顺畅",
"drivers":[{"code":"品种代码","text":"一句话归因"}],"warnings":["数据或口径提醒"]}
drivers 最多 3 条，只写异动大或价差明显变化的品种。
数字写进句子里；不要用「不是X而是Y」句式；不要机械连接词；不要写免责声明。`;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Desk-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const h = cors(request.headers.get('Origin') || '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (request.method !== 'POST') return json({ error: '只接受 POST' }, 405, h);

    // 共享口令：不是强认证，但足以阻止别人随手拿你的额度
    const token = request.headers.get('X-Desk-Token') || '';
    if (!env.SHARED_TOKEN || token !== env.SHARED_TOKEN) {
      return json({ error: '口令不对' }, 401, h);
    }
    if (!env.DEEPSEEK_API_KEY) return json({ error: 'worker 没配密钥' }, 500, h);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'body 不是 JSON' }, 400, h); }
    const context = String(body.context || '').slice(0, MAX_INPUT_CHARS);
    if (context.length < 20) return json({ error: 'context 太短' }, 400, h);

    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM },   // 固定前缀 → 命中磁盘缓存，便宜
          { role: 'user', content: context },
        ],
        max_tokens: MAX_OUT,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        stream: false,
      }),
    });

    if (!upstream.ok) {
      const t = await upstream.text();
      return json({ error: 'DeepSeek ' + upstream.status, detail: t.slice(0, 300) }, 502, h);
    }
    const data = await upstream.json();
    let parsed = {};
    try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch {}

    return json({
      digest: parsed.digest || '',
      drivers: parsed.drivers || [],
      warnings: parsed.warnings || [],
      model: data.model || MODEL,
      tokens: data.usage || {},
    }, 200, h);
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
