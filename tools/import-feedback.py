#!/usr/bin/env python3
"""读回周报页面上的人工反馈，整理成周更第一步可以直接吃的一叠数据。

用途
    周报技能每周一先读这里，把人的判断接进机器：哪些条目被改标为 Tech、哪些
    「疑重复」被确认或否认、哪些系列是不是同一件事。反馈有两个来源——
        feedback/<周次>.jsonl   本地看页面时零点击写入的（tools/serve-weekly.py）
        feedback/issue-*.md     线上读者交回的 issue 正文（可选）
    本脚本只做整理与核对，不改周报、不改金标；要写进金标仍由人决定。

用法
    python3 tools/import-feedback.py                       # 汇总并打印
    python3 tools/import-feedback.py --json feedback/latest.json
    python3 tools/import-feedback.py --emit-labels          # 只输出 id:tech 清单
    python3 tools/import-feedback.py --week 2026-W43
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

SCHEMA = "jurisatlas-weekly-feedback/v1"
RE_TARGET = re.compile(r"^(dup|suspect|series):(.+)$")


def load_items(data_path: Path) -> set[str]:
    if not data_path.exists():
        return set()
    data = json.loads(data_path.read_text(encoding="utf-8"))
    return {item["id"] for topic in data.get("topics", [])
            for group in topic.get("groups", []) for item in group.get("items", [])}


def load_series(series_path: Path) -> set[str]:
    """系列的 target 是 series:<系列 id>，与条目 id 不是一套，得分开核对。"""
    if not series_path.exists():
        return set()
    data = json.loads(series_path.read_text(encoding="utf-8"))
    return {entry["id"] for entry in data.get("series", [])}


def read_jsonl(directory: Path) -> dict[str, dict]:
    """按 (week, kind, target) 取最后一条：同一个人改来改去，以最后一次为准。"""
    out: dict[tuple[str, str, str], dict] = {}
    for path in sorted(directory.glob("*.jsonl")):
        week = path.stem
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not record.get("target"):
                continue
            record.setdefault("week", week)
            record.setdefault("kind", "mark")
            out[(record["week"], record["kind"], record["target"])] = record
    return out


def read_issue_marks(directory: Path) -> list[dict]:
    """issue 正文里那一段机读清单：一行一条 `id:tech` 或 `dup:<ids>:yes`。"""
    records = []
    for path in sorted(directory.glob("issue-*.md")):
        week = ""
        hit = re.search(r"\d{4}-W\d{2}", path.read_text(encoding="utf-8"))
        if hit:
            week = hit.group(0)
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if re.fullmatch(r"[0-9a-f]{10}:(law|tech)", line):
                item_id, value = line.split(":")
                records.append({"week": week, "kind": "mark", "target": item_id,
                                "value": value, "at": "", "source": path.name})
                continue
            hit = re.fullmatch(r"(dup|suspect|series):([0-9a-zA-Z+]+):(yes|no)", line)
            if hit:
                records.append({"week": week, "kind": "verdict",
                                "target": hit.group(1) + ":" + hit.group(2),
                                "value": hit.group(3), "at": "", "source": path.name})
    return records


def summarise(records: list[dict], known: set[str], series: set[str],
              week: str | None) -> dict:
    weeks: dict[str, dict] = defaultdict(
        lambda: {"week": "", "marks": [], "verdicts": [], "unknown": []})
    for record in records:
        if week and record.get("week") != week:
            continue
        bucket = weeks[record.get("week") or "unknown"]
        bucket["week"] = record.get("week") or "unknown"
        if record.get("kind") == "verdict":
            hit = RE_TARGET.match(record.get("target", ""))
            ids = hit.group(2).split("+") if hit else []
            if hit and hit.group(1) == "series":
                stale = bool(series) and ids[0] not in series
            else:
                stale = bool(known) and not any(item in known for item in ids)
            if stale:
                bucket["unknown"].append(record.get("target", ""))
            bucket["verdicts"].append({
                "target": record.get("target", ""),
                "kind": hit.group(1) if hit else "",
                "ids": ids,
                "value": record.get("value", ""),
                "at": record.get("at", ""),
            })
            continue
        if known and record.get("target") not in known:
            bucket["unknown"].append(record.get("target", ""))
        bucket["marks"].append({
            "id": record.get("target", ""),
            "value": record.get("value", ""),
            "at": record.get("at", ""),
        })

    ordered = []
    for key in sorted(weeks):
        bucket = weeks[key]
        bucket["marks"].sort(key=lambda row: row["id"])
        bucket["verdicts"].sort(key=lambda row: row["target"])
        bucket["counts"] = {
            "marks": len(bucket["marks"]),
            "tech": sum(1 for row in bucket["marks"] if row["value"] == "tech"),
            "verdicts": sum(1 for row in bucket["verdicts"] if row["value"]),
            "unknown": len(bucket["unknown"]),
        }
        ordered.append(bucket)
    return {
        "schema": SCHEMA,
        "weeks": ordered,
        "totals": {
            "weeks": len(ordered),
            "marks": sum(bucket["counts"]["marks"] for bucket in ordered),
            "verdicts": sum(bucket["counts"]["verdicts"] for bucket in ordered),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="读回周报页面上的人工反馈")
    parser.add_argument("--feedback", default="feedback")
    parser.add_argument("--data", default="site/assets/data/weekly.json")
    parser.add_argument("--series", default="site/assets/data/weekly-series.json",
                        help="系列数据层，用来核验 series:<id> 是否属于当周")
    parser.add_argument("--week", default=None, help="只看某一周，如 2026-W43")
    parser.add_argument("--json", default=None, help="写到这个路径")
    parser.add_argument("--emit-labels", action="store_true", help="只打印 id:tech 清单")
    args = parser.parse_args()

    directory = Path(args.feedback)
    if not directory.exists():
        print(f"没有反馈目录：{directory}（还没人在本地改过标）")
        return 0
    known = load_items(Path(args.data))
    weekly_series = load_series(Path(args.series))
    records = list(read_jsonl(directory).values()) + read_issue_marks(directory)
    summary = summarise(records, known, weekly_series, args.week)

    if args.emit_labels:
        for bucket in summary["weeks"]:
            for row in bucket["marks"]:
                if row["value"] == "tech":
                    print(row["id"] + ":tech")
        return 0

    if args.json:
        path = Path(args.json)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(summary, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"已写入 {path}")

    for bucket in summary["weeks"]:
        counts = bucket["counts"]
        print(f"{bucket['week']}：改标 {counts['marks']} 条（Tech {counts['tech']}）· "
              f"判定 {counts['verdicts']} 项 · 未匹配周报 {counts['unknown']} 处")
        tally = Counter(row["value"] for row in bucket["verdicts"] if row["value"])
        if tally:
            print("    判定分布：" + "、".join(f"{key} {value}" for key, value in tally.most_common()))
        if bucket["unknown"]:
            print("    这些 target 不在本周周报里，可能是上一周的残留：" +
                  "、".join(bucket["unknown"][:5]))
    if not summary["weeks"]:
        print("还没有记录。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
