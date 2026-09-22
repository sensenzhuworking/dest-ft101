#!/usr/bin/env python3
"""导出聚酯链驾驶舱的静态数据 data/desk.json。

只读 ~/Desktop/data_run/data/polyester.db，不修改原库、不生成中间文件。
只用 Python 标准库，不需要 pandas / openpyxl。

      用法： python3 tools/export_desk_json.py
可自定义源库：python3 tools/export_desk_json.py --db /path/to/polyester.db
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

DEFAULT_DB = os.path.expanduser("~/Desktop/data_run/data/polyester.db")
DEFAULT_FX = os.path.expanduser("~/Desktop/Database/2026/FX rate/FX_rate_Source.xlsx")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "desk.json")

# 品种 -> 前端图表映射。em = 东方财富 secid（备源），sina = 新浪期货代码（主源）。
# 没有国内期货的品种（石脑油/切片/长丝）只有现货，前端不给 K 线入口。
CHART_MAP = {
    "SC":     {"sina": "SC0", "em": "142.scm", "label": "SC原油"},
    "PX":     {"sina": "PX0", "em": "115.PXM", "label": "对二甲苯PX"},
    "PTA":    {"sina": "TA0", "em": "115.TAM", "label": "PTA"},
    "MEG":    {"sina": "EG0", "em": "114.egm", "label": "乙二醇MEG"},
    "PF":     {"sina": "PF0", "em": "115.PFM", "label": "涤纶短纤"},
    "PR":     {"sina": "PR0", "em": "115.PRM", "label": "聚酯瓶片"},
}

# 产业链传导链的顺序与显示名（前端画链条用）
CHAIN_ORDER = [
    {"code": "SC", "name": "原油SC", "kind": "futures"},
    {"code": "NAPHTHA", "name": "石脑油", "kind": "spot"},
    {"code": "PX", "name": "PX", "kind": "futures"},
    {"code": "PTA", "name": "PTA", "kind": "futures"},
    {"code": "MEG", "name": "MEG", "kind": "futures"},
    {"code": "PR", "name": "瓶片PR", "kind": "futures"},
    {"code": "PF", "name": "短纤PF", "kind": "futures"},
    {"code": "POY", "name": "长丝POY", "kind": "spot"},
]

# 价差面板展示顺序 + 中文标签
SPREAD_LABELS = {
    "PTA_PX": "PTA-PX 加工差",
    "PF_COST": "PF 现金流",
    "PR_COST": "PR 现金流",
    "POY_PTA": "POY-PTA 价差",
    "PX_NAPHTHA": "PX-石脑油 价差",
    "PF_FUT_PTA_FUT": "PF 盘面加工差",
    "PR_FUT_PTA_FUT": "PR 盘面加工差",
}

CONFLICT_STATUS = {
    "ok": "一致",
    "warn": "偏离",
    "conflict": "冲突",
    "BREACH": "超限",
}


def rowdict(cur):
    return [dict(r) for r in cur]


def provenance_grade(n_sources, agreement, quality_flag):
    """把源数量/一致度/质量旗标折算成一个前端好渲染的等级。

    ok      多源且一致   -> 绿点
    partial 多源但分歧，或有质量旗标 -> 黄点
    single  单源        -> 灰点（不是错，但要知道它只有一个来源）
    """
    qf = (quality_flag or "").upper()
    ag = (agreement or "").lower()
    if n_sources >= 2 and ag in ("ok", "") and not qf:
        return "ok"
    if n_sources >= 2:
        return "partial"
    return "single"


def read_fx(path):
    """读 FX_rate_Source.xlsx。表头已声明方向（Rate(CNY/USD) = 1 美元兑多少人民币），
    所以不猜方向 —— 直接用表头的单位字符串，避免 100× / 10000× 级别的换算事故。

    需要 openpyxl；没装就返回空 dict，不阻断主流程。
    """
    if not path or not os.path.exists(path):
        print("     [skip] 未找到 FX 工作簿，跳过汇率")
        return {}
    try:
        import openpyxl
    except ImportError:
        print("     [skip] 未安装 openpyxl，跳过汇率（pip install openpyxl）")
        return {}

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out = {}
    for name in wb.sheetnames:
        if name.upper() == "README":
            continue
        ws = wb[name]
        it = ws.iter_rows(values_only=True)
        try:
            header = next(it)
        except StopIteration:
            continue
        unit = str(header[2]) if len(header) > 2 and header[2] else ""
        series = []
        for row in it:
            if not row or row[0] is None or row[2] is None:
                continue
            d = str(row[0])[:10]
            try:
                v = float(row[2])
            except (TypeError, ValueError):
                continue
            series.append([d, round(v, 6)])
        if not series:
            continue
        series.sort(key=lambda x: x[0])
        series = series[-400:]
        prev = series[-2][1] if len(series) >= 2 else None
        chg = round(series[-1][1] - prev, 6) if prev else None
        pct = round(chg / abs(prev) * 100, 4) if prev else None
        out[name.upper()] = {
            "label": name.upper(),
            "unit": unit,
            "series": series,
            "latest": {"date": series[-1][0], "value": series[-1][1], "prev_value": prev,
                       "chg": chg, "chg_pct": pct},
        }
    wb.close()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--fx", default=DEFAULT_FX)
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print(f"[x] 找不到数据库：{args.db}", file=sys.stderr)
        return 1

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    instruments = rowdict(cur.execute(
        "select code, name_cn, stage, unit, has_futures, exchange, sys_symbol "
        "from dim_instrument order by code"
    ))

    # ---- 日序列：只为绘图/迷你趋势服务，保留最近 90 个交易日 ----
    series: dict[str, dict[str, list]] = {}
    latest: dict[str, dict[str, dict]] = {}
    provenance: dict[str, dict] = {}

    rows = rowdict(cur.execute(
        "select trade_date, code, price_type, value, prev_value, chg, chg_pct, "
        "       unit, primary_source, n_sources, agreement, quality_flag, "
        "       basis_note, main_contract "
        "from fact_daily_price order by trade_date"
    ))

    for r in rows:
        code, pt = r["code"], r["price_type"]
        series.setdefault(code, {}).setdefault(pt, [])
        # 数值统一按 2 位小数存储，避免把浮点尾巴写进 JSON
        series[code][pt].append([r["trade_date"], round(r["value"], 4) if r["value"] is not None else None])
        latest.setdefault(code, {})[pt] = {
            "date": r["trade_date"],
            "value": r["value"],
            "prev_value": r["prev_value"],
            "chg": r["chg"],
            "chg_pct": r["chg_pct"],
            "unit": r["unit"],
            "primary_source": r["primary_source"],
            "main_contract": r["main_contract"],
            "basis_note": r["basis_note"],
        }
        provenance[f"{code}|{pt}"] = {
            "n_sources": r["n_sources"],
            "agreement": r["agreement"],
            "quality_flag": r["quality_flag"] or "",
            "grade": provenance_grade(r["n_sources"], r["agreement"], r["quality_flag"]),
        }

    for code in series:
        for pt in series[code]:
            series[code][pt] = series[code][pt][-90:]

    # ---- 价差 / 加工费 ----
    spreads: dict[str, dict] = {}
    for r in rowdict(cur.execute(
        "select trade_date, spread_name, value, unit, formula from fact_spread order by trade_date"
    )):
        s = spreads.setdefault(r["spread_name"], {
            "label": SPREAD_LABELS.get(r["spread_name"], r["spread_name"]),
            "unit": r["unit"],
            "formula": r["formula"],
            "series": [],
        })
        s["series"].append([r["trade_date"], round(r["value"], 4) if r["value"] is not None else None])

    for name, s in spreads.items():
        s["series"] = s["series"][-90:]
        s["latest"] = {"date": s["series"][-1][0], "value": s["series"][-1][1]} if s["series"] else None
        prev = s["series"][-2][1] if len(s["series"]) >= 2 else None
        if s["latest"] and prev not in (None, 0):
            s["latest"]["chg"] = round(s["latest"]["value"] - prev, 2)
            s["latest"]["chg_pct"] = round((s["latest"]["value"] - prev) / abs(prev) * 100, 2)
        else:
            if s["latest"]:
                s["latest"]["chg"] = None
                s["latest"]["chg_pct"] = None

    # ---- 来源间冲突（血统徽章的红点用）----
    conflicts: dict[str, list] = {}
    for r in rowdict(cur.execute(
        "select trade_date, code, price_type, source_a, value_a, source_b, value_b, "
        "       diff, diff_pct, tol_pct, status "
        "from fact_source_conflict where status is not null and status <> 'ok' "
        "order by trade_date desc"
    )):
        conflicts.setdefault(f"{r['code']}|{r['price_type']}", []).append({
            "date": r["trade_date"],
            "a": r["source_a"], "va": r["value_a"],
            "b": r["source_b"], "vb": r["value_b"],
            "diff_pct": round(r["diff_pct"], 2) if r["diff_pct"] is not None else None,
            "tol_pct": r["tol_pct"],
            "status": r["status"],
        })

    # ---- 汇率（来自 FX_rate_Source.xlsx，表头声明方向）----
    fx = read_fx(args.fx)

    # ---- 来源字典 ----
    sources = {r["source_id"]: {
        "name": r["name_cn"], "kind": r["kind"], "tier": r["tier"], "notes": r["notes"],
    } for r in rowdict(cur.execute("select * from dim_source"))}

    # ---- 一句话总结（取最新一条）----
    sm = cur.execute(
        "select trade_date, method, summary_text, created_at from fact_daily_summary "
        "order by trade_date desc limit 1"
    ).fetchone()
    summary = dict(sm) if sm else None

    # ---- 健康度 ----
    grades = {"ok": 0, "partial": 0, "single": 0}
    for p in provenance.values():
        grades[p["grade"]] = grades.get(p["grade"], 0) + 1

    as_of = max((s["latest"]["date"] for s in spreads.values() if s["latest"]), default=None)

    payload = {
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "as_of": as_of,
        "db": os.path.basename(args.db),
        "summary": summary,
        "instruments": instruments,
        "chart_map": CHART_MAP,
        "chain_order": CHAIN_ORDER,
        "series": series,
        "latest": latest,
        "spreads": spreads,
        "fx": fx,
        "provenance": provenance,
        "conflicts": conflicts,
        "sources": sources,
        "health": {
            "series_total": len(provenance),
            "grades": grades,
            "conflict_groups": len(conflicts),
        },
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(args.out) / 1024
    print(f"[ok] 已写出 {args.out}")
    print(f"     数据截止 {as_of} | 序列 {len(provenance)} 条 | "
          f"血统 ok={grades.get('ok',0)} partial={grades.get('partial',0)} single={grades.get('single',0)}")
    print(f"     价差 {len(spreads)} 组 | 冲突组 {len(conflicts)} | "
          f"汇率 {len(fx)} 组 {list(fx.keys())} | 体积 {size_kb:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
