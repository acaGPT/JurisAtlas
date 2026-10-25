#!/usr/bin/env python3
"""从《法理学》课程 Wiki 的周报页抽取「本周 AI+法律动态」数据层。

用途
    解析 Wiki 克隆目录中的 Weekly-AI+Law-Brief.md，把「主题 → 事件类型 → 条目」
    三层结构还原为站点可渲染的 JSON。每条信息带一个稳定 id，供页面上的
    Law / Tech 人工标记回指（标记存在浏览器本地，导出后交回课程侧）。

    周报是机器生成的（pre-class-overview-writing 技能的 render_reader），格式
    稳定：`## 主题` / `### 事件类型` / `- **标题**` 加缩进的日期行与出处行。
    本脚本只做「读回来」，不改写任何一个字——站点呈现的就是 Wiki 上那一份。

输出
    weekly.json       纯数据，不含时间戳，字节稳定，供 CI 做前后 diff
    weekly-meta.json  生成时间、源 commit、条目统计

用法
    python3 tools/extract-weekly.py --wiki <wiki 克隆目录> --out <数据输出目录> [--auto]

参数
    --wiki  已克隆的 Jurisprudence.wiki 目录（须含 Weekly-AI+Law-Brief.md）
    --out   输出目录，脚本会写入 weekly.json 与 weekly-meta.json
    --auto  非交互式执行；本脚本无交互环节，保留该参数以统一脚本约定
    --week  只保留这一周（默认取页面自身声明的周次）

返回值
    0  成功
    1  参数缺失或源文件不可读
    2  解析结果异常（未解析出任何条目）

依赖
    仅标准库。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

WIKI_REPO = "https://github.com/acaGPT/Jurisprudence.wiki"
WIKI_BASE = "https://github.com/acaGPT/Jurisprudence/wiki"
PAGE = "Weekly-AI+Law-Brief"

# 页面里可能出现的行型。顺序有意义：先认日期，再认出处，最后当正文。
RE_STAGE = re.compile(r"^(\d{2}-\d{2})\s*(?:\u3000| )?([^\uff5c]{0,12}?)\uff5c\s*(.+)$")
RE_SINGLE = re.compile(r"^(\d{4}-\d{2}-\d{2})\uff5c(.+)$")
RE_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^)]+)\)")
RE_CARRIED = re.compile(r"^>\s*此前\s*(\d{4}-\d{2}-\d{2})\uff1a\s*(.+)$")
RE_WEEK = re.compile(r"^>\s*(\d{4})\s*年\s*第\s*(\d{1,2})\s*周[（(]([^）)]*)[）)]")
RE_PERIOD = re.compile(r"(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[\u2014\u2013\-]\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")


def item_id(topic: str, group: str, title: str) -> str:
    """条目身份：主题 + 事件类型 + 标题。

    不含位置与日期——同一周重排、重新聚类都不会换 id，人工标记才不会漂。
    """
    raw = "\x1f".join((topic, group, title))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]


def split_links(text: str) -> tuple[list[dict], str]:
    """把一行里用 ｜ 串起来的链接拆出来，剩下的当来源名。"""
    links = [{"label": label, "url": url} for label, url in RE_LINK.findall(text)]
    rest = RE_LINK.sub("", text)
    rest = "｜".join(part.strip() for part in rest.split("｜") if part.strip())
    return links, rest.strip(" ｜")


def parse_week_line(line: str) -> dict:
    """`> 2026 年第 43 周（10 月 18 日—10 月 24 日）` → 周次与起止日。"""
    match = RE_WEEK.match(line.strip())
    if not match:
        return {"week": "", "week_line": line.strip().lstrip("> ").strip(), "period": {}}
    year, week, inside = match.group(1), int(match.group(2)), match.group(3)
    period: dict[str, str] = {}
    span = RE_PERIOD.search(inside)
    if span:
        start_month, start_day, end_month, end_day = (int(value) for value in span.groups())
        period = {
            "start": f"{year}-{start_month:02d}-{start_day:02d}",
            "end": f"{year}-{end_month:02d}-{end_day:02d}",
        }
    return {
        "week": f"{year}-W{week:02d}",
        "week_line": line.strip().lstrip("> ").strip(),
        "period": period,
    }


def parse_page(text: str) -> dict:
    lines = text.split("\n")
    data: dict = {
        "title": "本周 AI+法律动态",
        "week": "",
        "week_line": "",
        "period": {},
        "overview": [],
        "topics": [],
    }

    topic: dict | None = None
    group: dict | None = None
    item: dict | None = None
    in_overview = False
    overview_buffer: list[str] = []

    def close_item() -> None:
        nonlocal item
        if item is None:
            return
        target = group if group is not None else None
        if target is not None:
            target["items"].append(item)
        item = None

    def close_group() -> None:
        nonlocal group
        close_item()
        if group is not None and topic is not None:
            topic["groups"].append(group)
        group = None

    def close_topic() -> None:
        nonlocal topic
        close_group()
        if topic is not None:
            data["topics"].append(topic)
        topic = None

    def close_overview() -> None:
        nonlocal in_overview, overview_buffer
        if in_overview:
            paragraphs = [part.strip() for part in "\n".join(overview_buffer).split("\n\n")]
            data["overview"].extend(p for p in paragraphs if p)
        in_overview = False
        overview_buffer = []

    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            if in_overview:
                overview_buffer.append("")
            continue

        if line.startswith("# "):
            data["title"] = stripped[2:].strip()
            continue
        if line.startswith("> ") and not data["week_line"]:
            data.update(parse_week_line(line))
            continue
        if line.startswith("## "):
            heading = stripped[3:].strip()
            if heading in ("本周概览", "概览"):
                close_topic()
                in_overview = True
                continue
            close_overview()
            close_topic()
            topic = {"name": heading, "groups": []}
            continue
        if line.startswith("### "):
            close_overview()
            close_group()
            group = {"name": stripped[4:].strip(), "items": []}
            continue

        if in_overview:
            overview_buffer.append(stripped)
            continue

        if topic is None:
            continue

        if line.startswith("- **") and stripped.endswith("**"):
            close_item()
            if group is None:
                # 主题下没有事件类型分节时，自己兜一个空名分组，渲染层据此省略小标题。
                group = {"name": "", "items": []}
            item = {
                "id": "",
                "kind": "",
                "title": stripped[4:-2].strip(),
                "_stages": [],
                "_fact": [],
            }
            continue

        if item is None:
            continue

        # 条目内部：先认「此前」行，再认阶段行，再认单条的日期行，最后当正文。
        carried = RE_CARRIED.match(stripped)
        if carried:
            item.setdefault("carried", []).append(
                {"date": carried.group(1), "title": carried.group(2).strip()}
            )
            continue

        if stripped.startswith("[") and RE_LINK.match(stripped):
            links, _ = split_links(stripped)
            item.setdefault("links", []).extend(links)
            continue

        single = RE_SINGLE.match(stripped)
        if single and not item["_stages"]:
            links, source = split_links(single.group(2))
            item["date"] = single.group(1)
            if source:
                item["source"] = source
            if links:
                item.setdefault("links", []).extend(links)
            continue

        stage = RE_STAGE.match(stripped)
        if stage:
            item["_stages"].append({
                "date": stage.group(1),
                "stage": stage.group(2).strip(),
                "text": stage.group(3).strip(),
            })
            continue

        # 落到这里的都是正文段：事件卡里是补充说明，单条里是事实摘要。
        item["_fact"].append(stripped)

    close_overview()
    close_topic()

    # 收尾：把内部字段整理成对外的形状，并补 id。
    total = 0
    for topic in data["topics"]:
        for group in topic["groups"]:
            for item in group["items"]:
                stages = item.pop("_stages", []) or []
                facts = item.pop("_fact", []) or []
                if stages:
                    item["kind"] = "event"
                    item["stages"] = stages
                else:
                    item["kind"] = "single"
                if facts:
                    item["fact"] = "\n".join(facts)
                item["links"] = item.get("links", [])
                item["id"] = item_id(topic["name"], group["name"], item["title"])
                total += 1
        topic["count"] = sum(len(group["items"]) for group in topic["groups"])

    data["counts"] = {
        "topics": len(data["topics"]),
        "groups": sum(len(topic["groups"]) for topic in data["topics"]),
        "items": total,
        "events": sum(1 for topic in data["topics"] for group in topic["groups"]
                      for item in group["items"] if item["kind"] == "event"),
    }
    data["source_url"] = f"{WIKI_BASE}/{PAGE}"
    return data


def source_commit(wiki_dir: Path) -> str:
    try:
        out = subprocess.run(["git", "-C", str(wiki_dir), "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def main() -> int:
    parser = argparse.ArgumentParser(
        description="从课程 Wiki 的周报页抽取「本周 AI+法律动态」数据层。",
    )
    parser.add_argument("--wiki", required=True, help="已克隆的 Jurisprudence.wiki 目录")
    parser.add_argument("--out", required=True, help="数据输出目录")
    parser.add_argument("--auto", action="store_true", help="非交互式执行")
    parser.add_argument("--week", default="", help="只接受这一周（默认取页面声明的周次）")
    args = parser.parse_args()

    wiki_dir = Path(args.wiki).expanduser().resolve()
    out_dir = Path(args.out).expanduser().resolve()
    page = wiki_dir / f"{PAGE}.md"
    if not page.exists():
        print(f"错误：找不到周报页 {page}", file=sys.stderr)
        return 1

    data = parse_page(page.read_text(encoding="utf-8"))
    if not data["counts"]["items"]:
        print("错误：未解析出任何条目，请检查周报页的标题层级与条目缩进。",
              file=sys.stderr)
        return 2
    if args.week and data["week"] != args.week:
        print(f"提示：页面周次为 {data['week']}，与 --week {args.week} 不符；本脚本只处理"
              f"当前页面，不做历史归档。", file=sys.stderr)

    meta = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M %z"),
        "source_repo": WIKI_REPO,
        "source_commit": source_commit(wiki_dir),
        "source_page": PAGE,
        "source_url": f"{WIKI_BASE}/{PAGE}",
        "week": data["week"],
        "stats": data["counts"],
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "weekly.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    (out_dir / "weekly-meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    counts = data["counts"]
    print(f"周次 {data['week'] or '（未识别）'} · 主题 {counts['topics']} · "
          f"事件类型 {counts['groups']} · 条目 {counts['items']} · 事件卡 {counts['events']}")
    print(f"源 commit：{meta['source_commit'] or '（非 git 目录）'}")
    print(f"输出：{out_dir / 'weekly.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
