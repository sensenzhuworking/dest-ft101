#!/usr/bin/env python3
"""用 DeepSeek 给驾驶舱生成「今日复盘 + 异动归因」，产出 data/ai_digest.json。

设计目标是「最少 token」，不是「最会用 AI」：

  1. 先用关键词字典筛新闻，再喂给模型。逐条新闻调 LLM 是最贵的错法 —— 90% 的条目
     跟聚酯链无关。筛选这一步 0 token。
  2. 整个上下文算 sha256 存进产物。数据没变就直接复用上次结果，一次 API 都不打。
  3. 一天最多一次；`--anomaly-only` 让它只在真有品种异动时才调。
  4. system prompt 完全固定 → DeepSeek 的磁盘前缀缓存按 cache-hit 价计费（约为未命中的 1/50）。
  5. 输出上限 400 token，只要 JSON。
  6. `--dry-run` 不发请求，只把 prompt 和 token 估算打出来，你可以先看再决定花不花。

密钥只从环境变量或 .env 读，永远不写进任何会被提交的文件。

  export DEEPSEEK_API_KEY=sk-xxxx
  python3 tools/ai_digest.py --dry-run        # 先看要发多少 token
  python3 tools/ai_digest.py                  # 真跑一次

注意：模型名默认 deepseek-v4-flash。旧的 deepseek-chat / deepseek-reasoner
已于 2026-07-24 15:59 UTC 停用，不要再传旧名字。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DESK = os.path.join(ROOT, "data", "desk.json")
OUT = os.path.join(ROOT, "data", "ai_digest.json")
CONFIG_JS = os.path.join(ROOT, "assets", "config.js")

API_URL = "https://api.deepseek.com/chat/completions"
CST = timezone(timedelta(hours=8))

# 官方美元费率（每 100 万 token），用于估算。DeepSeek 于 2026-08-17 起改峰谷定价，
# 且会调整费率 —— 这里只做量级参考，真实账单以官方为准。可用 --rates 覆盖。
DEFAULT_RATES = {
    "deepseek-v4-flash": {"miss": 0.14, "hit": 0.0028, "out": 0.28},
    "deepseek-v4-pro":   {"miss": 0.435, "hit": 0.003625, "out": 0.87},
}

# 官方标称的高峰时段（北京时间），空闲时段按半价计
PEAK_HOURS = [(9, 12), (14, 18)]

# 关键词分级权重。不做分级的话，「消费」「订单」这种泛词会把茅台、苹果的新闻
# 一起捞进来，模型拿到的上下文一半是噪声 —— 那比不筛更糟。
# 权重：3 = 品种与产业链机制词；2 = 能化相关的宏观变量；1 = 一般；
#       0.5 = 泛词/季节词，单独命中不足以入选。
KW_TIER = {}
for _w in [
    "原油", "石脑油", "对二甲苯", "PX", "PTA", "精对苯二甲酸", "乙二醇", "MEG", "聚酯",
    "瓶片", "PET", "聚酯瓶片", "短纤", "涤纶", "长丝", "POY", "FDY", "DTY", "切片",
    "化纤", "纺织原料", "再生", "加工差", "加工费", "现金流", "检修", "装置", "开工",
    "负荷", "仓单", "减产", "OPEC", "炼厂", "郑商所", "大商所", "上期所", "上期能源",
    "石脑油", "汽油", "柴油", "航煤", "芳烃", "棉花", "棉纱",
]:
    KW_TIER[_w] = 3
for _w in [
    "库存", "美联储", "FOMC", "降息", "加息", "议息", "利率决议", "美国CPI", "美国通胀",
    "美国就业", "非农就业", "国债", "收益率", "债市", "央行", "货币政策", "降准", "MLF",
    "逆回购", "资金面", "社零", "社会消费品零售", "CPI", "PPI", "PMI", "工业增加值",
    "房地产", "出口", "进口", "外贸", "美元指数", "美债", "关税", "GDP", "M2", "社融",
    "银行间", "LPR", "招标", "中标",
]:
    KW_TIER[_w] = 2
for _w in [
    "消费", "零售", "内需", "促消费", "以旧换新", "补贴", "专项债", "股市", "美股", "A股",
    "沪指", "上证指数", "深证成指", "创业板", "恒生指数", "港股", "纳斯达克", "标普500",
    "道琼斯", "北向资金", "融资余额", "IPO", "退市", "涨停", "跌停", "回购", "财政",
    "利率", "就业", "秋冬", "春夏", "订单", "品牌服饰", "快时尚", "跨境电商", "亚马逊",
    "优衣库", "耐克", "Nike", "阿迪达斯", "Adidas", "Zara", "H&M", "Shein", "SHEIN",
    "羽绒服", "运动鞋服", "成衣", "鞋服", "服装", "纺服", "特别国债", "国开债",
]:
    KW_TIER[_w] = 0.5

MIN_SCORE = 2.0          # 低于这个分数不进上下文
WEAK_QUOTA = 3           # 全是泛词命中的条目，最多留 3 条

# config.js 解析失败时的兜底关键词
FALLBACK_KW = [
    "原油", "石脑油", "PX", "PTA", "乙二醇", "MEG", "聚酯", "瓶片", "PET", "短纤", "涤纶",
    "长丝", "POY", "FDY", "DTY", "加工差", "加工费", "现金流", "检修", "装置", "开工",
    "负荷", "仓单", "库存", "降息", "加息", "美联储", "国债", "收益率", "社零", "CPI",
    "PPI", "PMI", "消费", "服装", "纺织", "棉花", "OPEC", "减产",
]


# ---------------------------------------------------------------- 文本工具

def approx_tokens(s: str) -> int:
    """粗略 token 估算：CJK 约 1 字 1 token，ASCII 约 4 字符 1 token。
    真值以 API 返回的 usage 为准，这里只用来在 --dry-run 阶段给个量级。"""
    cjk = len(re.findall(r"[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]", s))
    rest = len(s) - cjk
    return cjk + max(1, rest // 4)


def now_cst() -> datetime:
    return datetime.now(CST)


def is_peak(dt: datetime) -> bool:
    if dt.weekday() >= 5:
        return False
    return any(a <= dt.hour < b for a, b in PEAK_HOURS)


# ---------------------------------------------------------------- 读配置

def channel_keywords() -> tuple[list[str], str]:
    """从 assets/config.js 里抠出新闻关键词，保证「前端筛的」和「喂模型的」是同一份词典。"""
    try:
        src = open(CONFIG_JS, encoding="utf-8").read()
        block = src.split("const NEWS_CHANNELS", 1)[1].split("\n];", 1)[0]
        kws: list[str] = []
        for m in re.finditer(r"kw:\s*\[(.*?)\]", block, re.S):
            kws += re.findall(r"'([^']+)'", m.group(1))
        kws = [k for k in dict.fromkeys(kws) if k]
        if len(kws) >= 20:
            return kws, "assets/config.js"
    except Exception as e:                                  # noqa: BLE001
        print(f"  [warn] 解析 config.js 失败（{e}），改用内置词典", file=sys.stderr)
    return FALLBACK_KW, "内置兜底"


# ---------------------------------------------------------------- 取新闻

def fetch_news(page_size: int = 60) -> list[dict]:
    url = ("https://np-listapi.eastmoney.com/comm/web/getFastNewsList"
           f"?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize={page_size}&req_trace=1")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    return (data.get("data") or {}).get("fastNewsList") or []


def pick_news(items: list[dict], kws: list[str], limit: int) -> tuple[list[dict], dict]:
    """按分级权重挑新闻。

    返回 (入选条目, 统计)。分数 = Σ 命中词的权重。这与前端「频道命中」是两套口径：
    页面要的是覆盖广度，喂模型要的是信噪比，所以这里额外做了分级和配额。
    """
    scored = []
    for x in items:
        text = f"{x.get('title', '')} {x.get('summary', '')}"
        score, hits = 0.0, []
        for k in kws:
            if k in text:
                w = KW_TIER.get(k, 1.0)
                score += w
                hits.append(k)
        if score >= MIN_SCORE:
            scored.append((score, hits, str(x.get("showTime") or ""), x))
    # 分高的在前；同分时新的在前
    scored.sort(key=lambda t: (-t[0], t[2]), reverse=False)

    strong = [s for s in scored if s[0] >= 3]
    weak = [s for s in scored if s[0] < 3]
    chosen = strong[:limit]
    room = max(0, limit - len(chosen))
    chosen += weak[:min(room, WEAK_QUOTA)]

    stat = {
        "candidates": len(items),
        "scored": len(scored),
        "strong": len(strong),
        "weak": len(weak),
        "used": len(chosen),
        "top_hits": ["+".join(h[:3]) for _, h, _, _ in chosen[:5]],
    }
    return [x for _, _, _, x in chosen], stat


# ---------------------------------------------------------------- 拼上下文

def build_context(desk: dict, news: list[dict]) -> str:
    L: list[str] = []
    L.append(f"# 截面数据 截至 {desk.get('as_of')}")

    # 涨跌：一行一个品种，只给必要数字
    inst = {i["code"]: i for i in desk.get("instruments", [])}
    fut, spot = [], []
    for code in ["SC", "NAPHTHA", "PX", "PTA", "MEG", "PF", "PR", "POY", "CHIP", "BRENT", "WTI"]:
        for kind, bucket in (("futures", fut), ("spot", spot)):
            l = (desk.get("latest", {}).get(code) or {}).get(kind)
            if not l:
                continue
            nm = inst.get(code, {}).get("name_cn", code)
            pct = l.get("chg_pct")
            pcts = f"{pct:+.2f}%" if isinstance(pct, (int, float)) else "n/a"
            bucket.append(f"{nm}{l.get('value')}({pcts})")
    if fut:
        L.append("期货主力: " + "，".join(fut))
    if spot:
        L.append("现货: " + "，".join(spot))

    # 价差 / 加工费
    sp = []
    for name, s in desk.get("spreads", {}).items():
        l = s.get("latest") or {}
        if l.get("value") is None:
            continue
        ch = l.get("chg")
        sp.append(f"{s.get('label', name)}={l['value']}"
                  + (f"({ch:+.1f})" if isinstance(ch, (int, float)) else ""))
    if sp:
        L.append("价差/加工费: " + "，".join(sp))

    # 血统警号 —— 这条最容易被忽略，但它决定数字能不能用
    warns = []
    for key, pv in desk.get("provenance", {}).items():
        if pv.get("quality_flag") or pv.get("grade") == "single":
            code, kind = key.split("|")
            tag = pv.get("quality_flag") or "单源"
            warns.append(f"{inst.get(code, {}).get('name_cn', code)}·{kind}={tag}")
    for key, arr in (desk.get("conflicts") or {}).items():
        if arr:
            a = arr[0]
            warns.append(f"{key} 源间差 {a.get('diff_pct')}%(容忍{a.get('tol_pct')}%)")
    if warns:
        L.append("数据警号: " + "；".join(warns[:10]))

    # 前一日的一句话总结，给模型一个连续性锚点（省掉它自己推断趋势）
    s = (desk.get("summary") or {}).get("summary_text")
    if s:
        L.append("上期摘要: " + s[:180].rstrip("；") + "…")

    # 已筛过的新闻，压到一行一条
    if news:
        L.append("")
        L.append("# 命中关键词的新闻（按相关度排序）")
        for x in news:
            t = (x.get("title") or "").replace("\n", " ").strip()
            L.append("- " + t[:54])
    return "\n".join(L)


SYSTEM = (
    "你是聚酯产业链研究员，服务于一个只做能化的自用看板。"
    "严格只依据用户给的数据说话：不给目标价，不预测点位，不引入你没有的数据。\n"
    "输出一个 JSON 对象，字段固定为：\n"
    '{"digest": "2-3 句中文复盘，说明今天的核心矛盾与成本-需求传导是否顺畅",\n'
    ' "drivers": [{"code": "品种代码", "text": "一句话归因"}],\n'
    ' "warnings": ["数据或口径上的提醒"]}\n'
    "drivers 只写异动幅度大或价差明显变化的品种，最多 3 条；没有就留空数组。\n"
    "写作要求：数字写进句子里，不要孤立罗列；不要用「不是X而是Y」这种句式；"
    "不要用「首先/其次/最后」这类机械连接词；不要写免责声明。"
)


# ---------------------------------------------------------------- 调模型

def call_deepseek(key: str, model: str, context: str, max_out: int,
                  temperature: float, thinking: bool = False) -> dict:
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},      # 固定前缀 → 命中磁盘缓存
            {"role": "user", "content": context},
        ],
        "max_tokens": max_out,
        "temperature": temperature,
        "response_format": {"type": "json_object"},
        "stream": False,
        # DeepSeek V4 默认【开】思考模式（effort 默认 high）：推理过程走 reasoning_content，
        # content 才是正式答案。默认开着的话，max_tokens 会被推理吃光 → content 是空字符串
        # → json.loads 抛 "Expecting value: line 1 column 1"。这个坑很隐蔽，
        # 因为响应本身是 200、usage 也正常，只有 content 是空的。
        "thinking": {"type": "enabled" if thinking else "disabled"},
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None


def extract_answer(resp: dict) -> dict:
    """从响应里取正式答案，并区分三种失败：真报错 / 只有思考没有答案 / 内容不是 JSON。
    不区分的话只会看到一句 "Expecting value"，完全看不出发生了什么。"""
    choice = (resp.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content = (msg.get("content") or "").strip()
    reasoning = (msg.get("reasoning_content") or "").strip()

    if not content:
        if reasoning:
            raise RuntimeError(
                f"模型只输出了思考过程，正式答案是空的（reasoning_content {len(reasoning)} 字符）。"
                f"把 --max-out 调大（当前 {len(reasoning)} 字符的推理至少需要再留 400 token），"
                f"或确认 thinking 已关闭。")
        raise RuntimeError(f"模型返回空内容。finish_reason={choice.get('finish_reason')}")

    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"返回的不是合法 JSON：{e}\n前 300 字符：{content[:300]}") from None


def estimate_cost(usage: dict, rates: dict) -> dict:
    hit = usage.get("prompt_cache_hit_tokens", 0) or 0
    miss = usage.get("prompt_cache_miss_tokens")
    if miss is None:
        miss = max(0, (usage.get("prompt_tokens") or 0) - hit)
    out = usage.get("completion_tokens") or 0
    cost = hit / 1e6 * rates["hit"] + miss / 1e6 * rates["miss"] + out / 1e6 * rates["out"]
    return {"prompt_hit": hit, "prompt_miss": miss, "completion": out,
            "cost_usd": round(cost, 6)}


# ---------------------------------------------------------------- 主流程

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="不发请求，只打印 prompt 与 token 估算")
    ap.add_argument("--model", default=os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash"))
    ap.add_argument("--max-out", type=int, default=700, help="输出上限 token（关掉 thinking 后 700 很宽裕）")
    ap.add_argument("--thinking", action="store_true", help="开启思考模式（更准但更贵，且需要更大的 max-out）")
    ap.add_argument("--news-limit", type=int, default=10, help="喂给模型的新闻条数，压 token 的主要旋钮")
    ap.add_argument("--anomaly", type=float, default=0.0,
                    help="只有某品种 |涨跌幅| 超过该值才调用，例如 2 表示 2%%")
    ap.add_argument("--temperature", type=float, default=0.3)
    ap.add_argument("--force", action="store_true", help="数据没变也强制重新调用")
    ap.add_argument("--off-peak-only", action="store_true", help="只在空闲时段运行（高峰半价差）")
    args = ap.parse_args()

    if not os.path.exists(DESK):
        print(f"[x] 找不到 {DESK}，先跑 tools/export_desk_json.py", file=sys.stderr)
        return 1
    desk = json.load(open(DESK, encoding="utf-8"))

    t = now_cst()
    peak = is_peak(t)
    print(f"▸ 北京时间 {t:%Y-%m-%d %H:%M}（{'高峰时段' if peak else '空闲时段'}）")
    if args.off_peak_only and peak:
        print("  当前是高峰时段，--off-peak-only 已开启，本次不调用。")
        return 0

    # 1) 关键词先筛，这一步不花 token
    kws, kw_src = channel_keywords()
    try:
        raw_news = fetch_news(60)
        news, nstat = pick_news(raw_news, kws, args.news_limit)
        news_note = (f"抓到 {len(raw_news)} 条 → 过阈 {nstat['scored']} 条"
                     f"（强相关 {nstat['strong']} / 泛词 {nstat['weak']}）→ 送入 {nstat['used']} 条")
    except Exception as e:                                   # noqa: BLE001
        news, nstat = [], {}
        news_note = f"新闻源不可达（{e}），本次只用行情数据"
    print(f"▸ 词典来源 {kw_src}（{len(kws)} 词）· {news_note}")
    if nstat.get("top_hits"):
        print(f"  入选条目命中词：{' | '.join(nstat['top_hits'])}")

    # 2) 异动闸门
    if args.anomaly > 0:
        moves = []
        for code, kinds in desk.get("latest", {}).items():
            for kind, l in kinds.items():
                p = l.get("chg_pct")
                if isinstance(p, (int, float)) and abs(p) >= args.anomaly:
                    moves.append(f"{code}.{kind} {p:+.2f}%")
        if not moves:
            print(f"  没有任何品种涨跌超过 {args.anomaly}%，跳过本次调用（0 token）。")
            return 0
        print(f"  触发异动闸门：{', '.join(moves[:6])}")

    context = build_context(desk, news)
    digest_hash = hashlib.sha256((SYSTEM + context).encode("utf-8")).hexdigest()[:16]

    # 3) 数据没变就复用，省掉整次调用
    if not args.force and os.path.exists(OUT):
        try:
            prev = json.load(open(OUT, encoding="utf-8"))
            if prev.get("data_hash") == digest_hash:
                prev["cached"] = True
                prev["cached_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
                json.dump(prev, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
                print("▸ 输入数据与上次完全一致，直接复用上次结论（本次 0 token）。")
                return 0
        except Exception:                                    # noqa: BLE001
            pass

    sys_tok, ctx_tok = approx_tokens(SYSTEM), approx_tokens(context)
    print(f"\n--- 将要发送的上下文（{len(context)} 字符，约 {ctx_tok} token）---")
    print(context)
    print(f"--- system 约 {sys_tok} token · 输出上限 {args.max_out} token ---")
    print(f"--- 单次估算：输入约 {sys_tok + ctx_tok} token，粗算成本 "
          f"${(sys_tok + ctx_tok) / 1e6 * DEFAULT_RATES.get(args.model, DEFAULT_RATES['deepseek-v4-flash'])['miss']:.6f}"
          f"（命中缓存更低）---\n")

    if args.dry_run:
        print("▸ --dry-run：未调用 API。确认无误后去掉该参数即可。")
        return 0

    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        envfile = os.path.join(ROOT, ".env")
        if os.path.exists(envfile):
            for line in open(envfile, encoding="utf-8"):
                m = re.match(r"\s*DEEPSEEK_API_KEY\s*=\s*(.+)\s*$", line)
                if m:
                    key = m.group(1).strip().strip('"').strip("'")
                    break
    if not key:
        print("[x] 没有找到 DEEPSEEK_API_KEY。放到环境变量里，或写进（已 gitignore 的）.env：",
              file=sys.stderr)
        print('    DEEPSEEK_API_KEY=sk-xxxxxxxx', file=sys.stderr)
        return 1

    print("▸ 调用 DeepSeek …")
    try:
        resp = call_deepseek(key, args.model, context, args.max_out,
                             args.temperature, thinking=args.thinking)
    except Exception as e:                                   # noqa: BLE001
        print(f"[x] 调用失败：{e}", file=sys.stderr)
        return 1

    try:
        parsed = extract_answer(resp)
    except Exception as e:                                   # noqa: BLE001
        print(f"[x] {e}", file=sys.stderr)
        return 1

    usage = resp.get("usage") or {}
    est = estimate_cost(usage, DEFAULT_RATES.get(args.model, DEFAULT_RATES["deepseek-v4-flash"]))
    payload = {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "model": resp.get("model") or args.model,
        "data_hash": digest_hash,
        "cached": False,
        "as_of": desk.get("as_of"),
        "digest": parsed.get("digest", ""),
        "drivers": parsed.get("drivers") or [],
        "warnings": parsed.get("warnings") or [],
        "tokens": est,
        "peak": peak,
        "thinking": bool(args.thinking),
        "inputs": {"headlines": len(news), "context_chars": len(context)},
    }
    json.dump(payload, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    print(f"[ok] 已写出 {OUT}")
    print(f"     tokens: 输入命中缓存 {est['prompt_hit']} / 未命中 {est['prompt_miss']} / "
          f"输出 {est['completion']} · 约 ${est['cost_usd']}")
    print(f"     复盘：{payload['digest']}")
    for d in payload["drivers"]:
        print(f"     · {d.get('code')} {d.get('text')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
