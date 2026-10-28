#!/usr/bin/env python3
"""把一周的分散条目还原成「系列」——同一件事在时间上的连续进展。

用途
    周报按制度主题组织，一件事的前后几步常被拆到不同主题下（草案在「出口管制与
    制裁」、企业履行登记在「禁用与移除」），读者读到的是一堆平行的事实，而不是一条
    线。本脚本找出「共用一个稀有短语、各自都带制度动作、日期不同」的条目，串成时间
    轴，输出 weekly-series.json 供页面「按系列」视图读取。

    另有一类不用推断：条目本身就是多阶段事件（kind == "event"，条目内已带 stages），
    它天然是一条系列，直接收进来。

判据（宁可少认，不硬凑）
    ① 两条共享一个 4 字以上、全周出现不超过 6 次的短语（「出口管制」这类事件名），
       同一短语被八条以上共用就不再当事件名——那是通用词；
    ② 两条各自都带制度动作词（拟议／草案／登记／裁决…）。这一条挡掉播客栏目名与
       社群碎片帖：它们会和很多新闻共享关键词，但没有制度动作；
    ③ 日期不同。同一件事被两家媒体同一天各报一次是重复，不是进展，归
       audit-subjects.py 管。

    只出候选与证据，不改周报、不删条目。页面上的「是同一系列／不是」由人判定。

用法
    python3 tools/build-series.py                 # 打印候选，不落盘
    python3 tools/build-series.py --write         # 写入 site/assets/data/weekly-series.json
    python3 tools/build-series.py --data <路径> --out <路径>
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

SCHEMA = "jurisatlas-weekly-series/v1"

# 制度动作词：出现即说明这条讲的是「有人对某件事做了制度上的动作」，而不是在转述
# 某个人的说法、或推荐一个产品。清单有意保守——「发布」「推出」这类通用动词不收，
# 否则任何产品稿都能进系列。
ACTION_WORDS = (
    "拟议", "草案", "征求意见", "审议", "表决", "三读", "签署", "生效", "修订", "废止",
    "登记", "备案", "许可", "批准", "核准", "立案", "起诉", "应诉", "开庭", "上诉",
    "判决", "裁决", "裁定", "处罚", "罚款", "调查", "约谈", "通报", "列入", "暂停",
    "下架", "召回", "禁令", "起诉书", "合规", "监管", "执法", "审查", "听证", "和解",
    "管辖", "豁免", "义务", "责任",
)
RE_ACTION = re.compile("|".join(ACTION_WORDS))

RE_NUMERIC_PHRASE = re.compile(r"[0-9０-９%％]|亿|万元|美元|亿元")
RE_SPEECH_PHRASE = re.compile(r"回应|表示|调侃|吐槽|认为|称赞|抱怨|透露|澄清")

MAX_PHRASE_DF = 6          # 超过这个数就不算事件名，算通用词
MAX_CLUSTER_DF = 8         # 一个短语被八条以上共用，簇就没意义了
MIN_PHRASE_LEN = 4         # 三个字的短语太容易撞（「马斯克」「机器人」）


def load_audit_module():
    """复用审查脚本的分词与稀有度实现：两边口径必须一致，不能各写一套。"""
    path = Path(__file__).with_name("audit-subjects.py")
    spec = importlib.util.spec_from_file_location("audit_subjects", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def series_id(name: str) -> str:
    return "sr" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]


def has_action(record: dict) -> bool:
    return bool(RE_ACTION.search(record["title"]))


def phrases_of(record: dict, pdf: Counter, audit) -> set[str]:
    """标题里够少见的短语。带数字、带表态的一律不收。"""
    out = set()
    for phrase in audit.cjk_phrases(record["title"]):
        if len(phrase) < MIN_PHRASE_LEN:
            continue
        if not (0 < pdf.get(phrase, 99) <= MAX_PHRASE_DF):
            continue
        if RE_NUMERIC_PHRASE.search(phrase) or RE_SPEECH_PHRASE.search(phrase):
            continue
        out.add(phrase)
    return out


def link_series(records: list[dict], pdf: Counter, audit) -> list[dict]:
    """按共享稀有短语做连通分量，每个簇给出最能代表它的那个短语。"""
    by_id = {record["id"]: record for record in records}
    phrase_ids: dict[str, set[str]] = defaultdict(set)
    for record in records:
        if not has_action(record):
            continue
        for phrase in phrases_of(record, pdf, audit):
            phrase_ids[phrase].add(record["id"])

    parent: dict[str, str] = {}

    def find(node: str) -> str:
        parent.setdefault(node, node)
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    for ids in phrase_ids.values():
        if len(ids) < 2 or len(ids) > MAX_CLUSTER_DF:
            continue
        ordered = sorted(ids)
        for i in range(len(ordered)):
            for j in range(i + 1, len(ordered)):
                a, b = by_id[ordered[i]], by_id[ordered[j]]
                if a["date"] and a["date"] == b["date"]:
                    continue            # 同一天的两条：重复，不是进展
                root_a, root_b = find(ordered[i]), find(ordered[j])
                if root_a != root_b:
                    parent[root_b] = root_a

    clusters: dict[str, set[str]] = defaultdict(set)
    for node in list(parent):
        clusters[find(node)].add(node)

    out = []
    for members in clusters.values():
        if len(members) < 2:
            continue
        best = None
        for phrase, ids in phrase_ids.items():
            covered = len(ids & members)
            if covered < 2:
                continue
            # 覆盖得越多越能命名整个簇；覆盖一样时取更短、更通用的那个
            score = (covered, -len(phrase))
            if best is None or score > best[0]:
                best = (score, phrase, covered)
        if best is None:
            continue
        out.append({"ids": sorted(members), "phrase": best[1], "covered": best[2]})
    out.sort(key=lambda entry: -len(entry["ids"]))
    return out


def nodes_of(ids: list[str], by_id: dict[str, dict], dup_of: dict[str, int]) -> list[dict]:
    """同一件事被报道多次时并成一个节点，轴上只留进展，不留转载。"""
    buckets: dict[int | str, list[str]] = defaultdict(list)
    for item_id in ids:
        bucket = dup_of.get(item_id)
        buckets[bucket if bucket is not None else item_id].append(item_id)
    nodes = []
    for members in buckets.values():
        members = sorted(members, key=lambda item_id: by_id[item_id]["date"] or "")
        head = by_id[members[0]]
        nodes.append({
            "date": head["date"] or "",
            "ids": members,
            "count": len(members),
            "title": head["title"],
        })
    nodes.sort(key=lambda node: (node["date"], node["title"]))
    return nodes


def lead_subject(ids: list[str], by_id: dict[str, dict], audit) -> str:
    """系列该挂谁：有机关就挂机关（制度动作的实施者），否则挂出现次数最多的主体。
    按出现次数挂公司会把「商务部出台出口管制、DeepSeek 去登记」这条线挂到 DeepSeek
    名下——被监管的一方成了主线的主角。"""
    counts = Counter(audit.primary_subject(by_id[item_id]) for item_id in ids
                     if audit.primary_subject(by_id[item_id]))
    if not counts:
        return ""
    agencies = [key for key in counts
                if audit.SUBJECT_BY_KEY.get(key, {}).get("kind") == "agency"]
    if agencies:
        return sorted(agencies, key=lambda key: (-counts[key], key))[0]
    return sorted(counts, key=lambda key: (-counts[key], key))[0]


def collect(data_path: Path, subjects_path: Path) -> dict:
    audit = load_audit_module()
    data, records = audit.load_items(data_path)
    by_id = {record["id"]: record for record in records}
    pdf = audit.build_phrase_df(records)
    raw = {item["id"]: item for topic in data.get("topics", [])
           for group in topic.get("groups", []) for item in group.get("items", [])}

    # 疑重复簇：同一次发生的多条报道在轴上并成一个节点
    dup_of: dict[str, int] = {}
    if subjects_path.exists():
        subjects = json.loads(subjects_path.read_text(encoding="utf-8"))
        index = 0
        for group in subjects.get("subjects") or []:
            for cluster in group.get("duplicates") or []:
                index += 1
                for item_id in cluster.get("ids") or []:
                    dup_of[item_id] = index

    entries: list[dict] = []

    # ① 本周多阶段事件：条目内自带时间线，不必推断
    for record in records:
        item = raw.get(record["id"]) or {}
        stages = item.get("stages") or []
        if record["kind"] != "event" or len(stages) < 2:
            continue
        subject = audit.primary_subject(record)
        # 不写证据行：卡头已经给了步数、卡内时间轴逐条列了进展，再加一句
        # 「本周 N 次进展」是重复，写「条目自带 N 个阶段」则是把数据形状当内容。
        entries.append({
            "id": series_id("event:" + record["title"]),
            "name": record["title"],
            "kind": "event",
            "confidence": 1.0,
            "ids": [record["id"]],
            "topics": [record["topic"]],
            "subjects": [subject] if subject else [],
            "nodes": [{"date": stage.get("date") or "", "ids": [record["id"]],
                       "count": 1, "title": stage.get("text") or ""} for stage in stages],
        })

    # ② 跨条目的进展链
    for cluster in link_series(records, pdf, audit):
        ids = cluster["ids"]
        nodes = nodes_of(ids, by_id, dup_of)
        if len(nodes) < 2 or len({node["date"] for node in nodes}) < 2:
            continue                     # 全落在同一天或同一簇：那是重复，不是进展
        subjects = sorted({audit.primary_subject(by_id[item_id]) for item_id in ids
                           if audit.primary_subject(by_id[item_id])})
        name = cluster["phrase"]
        lead = lead_subject(ids, by_id, audit)
        if lead:
            name = audit.SUBJECT_BY_KEY.get(lead, {}).get("name", lead) + " · " + name
        entries.append({
            "id": series_id("progression:" + name),
            "name": name,
            "kind": "progression",
            "confidence": 0.72,
            # 同上：不说「共享短语、几条直接命中」，说这条线索围绕什么、走了几步。
            "evidence": "围绕「" + cluster["phrase"] + "」，" + str(len(nodes)) +
                        " 个时间点依次推进",
            "ids": ids,
            "topics": sorted({by_id[item_id]["topic"] for item_id in ids}),
            "subjects": subjects,
            "nodes": nodes,
        })

    entries.sort(key=lambda entry: (entry["kind"] != "event", -len(entry["nodes"]), entry["name"]))
    items = {item_id for entry in entries for item_id in entry["ids"]}
    return {
        "schema": SCHEMA,
        "week": data.get("week", ""),
        "generated_from": data_path.name,
        "params": {"min_phrase_len": MIN_PHRASE_LEN, "max_phrase_df": MAX_PHRASE_DF},
        "counts": {
            "series": len(entries),
            "progression": sum(1 for entry in entries if entry["kind"] == "progression"),
            "event": sum(1 for entry in entries if entry["kind"] == "event"),
            "items": len(items),
        },
        "series": entries,
    }


def report(series: dict) -> None:
    counts = series["counts"]
    print(f"系列 {counts['series']} 条（进展链 {counts['progression']} · "
          f"本周多阶段 {counts['event']}），涉及 {counts['items']} 条信息")
    for entry in series["series"]:
        print(f"  [{entry['kind'][:4]}] {entry['name']}（{len(entry['ids'])} 条）")
        if entry.get("evidence"):
            print(f"      {entry['evidence']}")
        for node in entry["nodes"]:
            print(f"        {node['date']}  {node['title'][:52]}")


def main() -> int:
    parser = argparse.ArgumentParser(description="从周报数据里串出系列")
    parser.add_argument("--data", default="site/assets/data/weekly.json")
    parser.add_argument("--subjects", default="site/assets/data/weekly-subjects.json")
    parser.add_argument("--out", default="site/assets/data/weekly-series.json")
    parser.add_argument("--write", action="store_true", help="落盘（默认只打印）")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    data_path = Path(args.data)
    if not data_path.exists():
        raise SystemExit(f"找不到周报数据：{data_path}")
    series = collect(data_path, Path(args.subjects))
    if args.write:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(series, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        if not args.quiet:
            print(f"已写入 {out}")
    report(series)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
