#!/usr/bin/env python3
"""把周报页上的人工标记，整理为下一轮分类可用的反馈表。

用途
    weekly.html 上每条信息可以标 Law 或 Tech（默认 Law，没有第三种状态）。标记存在
    读者浏览器的本地存储里（键 jcm-weekly-marks:<周次>），页面已不提供导出按钮；
    需要成批收集时，取其值按 jurisatlas-weekly-labels/v1 包一层即可（字段见下方
    「输入格式」）。本脚本读取一份或多份这样的文件，按条目 id 合并（同一份被多人标过
    就投票），写出 JSONL 供分类校准使用。

    文件是一份**例外清单**：只列被读者改判为 Tech 的条目——默认 Law 的条目不进文件，
    因为它们是基线而不是判断。因此标为 tech 的条目就是 `classify_domain` 的候选假阳性。
    若要记录「我认为是 Law」的异见，可手工补一行 label: "law"。

    多份文件必须属于同一周——不同周的同 id 不相干，混在一起会串味。

用法
    python3 tools/apply-weekly-labels.py --in <标记.json> [<标记2.json> ...] \
        [--out <反馈.jsonl>] [--json]

参数
    --in    一份或多份标记文件（jurisatlas-weekly-labels/v1）
    --out   输出路径；默认 weekly-reports/human-labels-<周次>.jsonl
    --json  以 JSON 打印汇总，便于其他脚本消费

输出格式（每行一条）
    {"schema":"weekly-human-labels/v1","week":"2026-W43","id":"…","label":"tech",
     "votes":{"law":0,"tech":2},"agree":true,"title":"…","topic":"…","group":"…",
     "kind":"single","date":"…","source":"…","url":"…"}

输入格式
    {"schema":"jurisatlas-weekly-labels/v1","week":"2026-W43",
     "default_label":"law","labels":[{"id":"…","label":"tech"}, …]}

返回值
    0  成功
    1  输入不可读或字段缺失
    2  多份文件不属于同一周
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCHEMA_IN = "jurisatlas-weekly-labels/v1"
SCHEMA_OUT = "weekly-human-labels/v1"


class WeekMismatch(ValueError):
    """多份导出不属于同一周：合并会串味，直接拒绝。"""


def load_exports(paths: list[Path]) -> tuple[str, list[dict]]:
    labels: list[dict] = []
    week = ""
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"{path}：读不出来（{error}）") from error
        if payload.get("schema") != SCHEMA_IN:
            raise ValueError(f"{path}：schema 是 {payload.get('schema')!r}，"
                             f"不是 {SCHEMA_IN}——请按脚本头部「输入格式」重包一次")
        this_week = payload.get("week") or ""
        if not this_week:
            raise ValueError(f"{path}：缺少 week 字段")
        if week and this_week != week:
            raise WeekMismatch(f"{path}：周次是 {this_week}，与已有的 {week} 不同，"
                               f"不同周的标记不能合并")
        week = this_week
        for row in payload.get("labels") or []:
            if not row.get("id") or row.get("label") not in ("law", "tech"):
                raise ValueError(f"{path}：有条目缺少 id 或 label 非法：{row}")
            labels.append(row)
    return week, labels


def merge(labels: list[dict]) -> list[dict]:
    """同一 id 被多人标过就计票；票数打平标 agree=false，按 tech 呈现待复核。"""
    table: dict[str, dict] = {}
    for row in labels:
        entry = table.setdefault(row["id"], {"meta": row, "law": 0, "tech": 0})
        entry[row["label"]] += 1
        # 取信息最全的那条的元数据（先到先得，同 id 的标题应当一致）
        for key in ("title", "topic", "group", "kind", "date", "source", "url"):
            if not entry["meta"].get(key) and row.get(key):
                entry["meta"][key] = row.get(key)

    merged = []
    for item_id, entry in table.items():
        law, tech = entry["law"], entry["tech"]
        if tech > law:
            label, agree = "tech", True
        elif law > tech:
            label, agree = "law", True
        else:
            label, agree = "tech", False         # 打平：交给下一轮看，标成待复核

        meta = entry["meta"]
        merged.append({
            "schema": SCHEMA_OUT,
            "week": meta.get("week") or "",
            "id": item_id,
            "label": label,
            "votes": {"law": law, "tech": tech},
            "agree": agree,
            "title": meta.get("title", ""),
            "topic": meta.get("topic", ""),
            "group": meta.get("group", ""),
            "kind": meta.get("kind", ""),
            "date": meta.get("date", ""),
            "source": meta.get("source", ""),
            "url": meta.get("url", ""),
        })
    merged.sort(key=lambda row: (row["label"] != "tech", row["topic"], row["title"]))
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把周报页导出的人工 Law/Tech 标记整理为分类反馈表。")
    parser.add_argument("--in", dest="inputs", nargs="+", required=True,
                        help="weekly.html 导出的标记文件（可多份，须同周）")
    parser.add_argument("--out", help="输出 JSONL 路径")
    parser.add_argument("--json", action="store_true", help="以 JSON 打印汇总")
    args = parser.parse_args()

    paths = [Path(name).expanduser().resolve() for name in args.inputs]

    try:
        week, labels = load_exports(paths)
    except WeekMismatch as error:
        print(f"错误：{error}", file=sys.stderr)
        return 2
    except ValueError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1

    if not labels:
        print("提示：这些导出里没有任何标记，未写出文件。", file=sys.stderr)
        return 0

    merged = merge(labels)
    for row in merged:
        row["week"] = week

    out = Path(args.out).expanduser().resolve() if args.out else \
        Path("weekly-reports") / f"human-labels-{week}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in merged),
                   encoding="utf-8")

    tech = [row for row in merged if row["label"] == "tech"]
    law = [row for row in merged if row["label"] == "law"]
    summary = {
        "week": week,
        "exports": len(paths),
        "marks": len(labels),
        "items": len(merged),
        "tech": len(tech),
        "law": len(law),
        "disagree": [row["id"] for row in merged if not row["agree"]],
        "out": str(out),
    }

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=1))
        return 0

    print(f"周次 {week} · 收到 {len(labels)} 条标记（{len(paths)} 份）· "
          f"涉及 {len(merged)} 个条目")
    print(f"标为 Tech {len(tech)} 条（分类的候选假阳性）· 标为 Law {len(law)} 条")
    if summary["disagree"]:
        print(f"票数打平 {len(summary['disagree'])} 条，已按待复核处理："
              f"{', '.join(summary['disagree'][:6])}")
    for row in tech:
        print(f"  [Tech] {row['topic']}／{row['group'] or '—'}：{row['title']}")
    print(f"输出：{out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
