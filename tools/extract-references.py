#!/usr/bin/env python3
"""从《法理学》课程 Wiki 抽取文献条目，生成文献库所需的数据层。

用途
    解析 Wiki 克隆目录中的 Course-Syllabus.md，把各章「经典文献」与「延伸阅读」
    小节还原为逐条结构化数据：作者、年份、题名、条目类型、获取渠道（粗细双维）、
    所属章节。输出站点使用的 references.json（纯数据，字节稳定，供 CI diff）与
    references-meta.json（生成时间、源 commit、汇总统计）。

    解析不了的条目不丢弃：保留原始行并标记 parsed=false，由前端照录。

用法
    python3 tools/extract-references.py --wiki <wiki 克隆目录> --out <数据输出目录> [--auto]

参数
    --wiki  已克隆的 Jurisprudence.wiki 目录（须含 Course-Syllabus.md）
    --out   输出目录，脚本会写入 references.json 与 references-meta.json
    --auto  非交互式执行；本脚本无交互环节，保留该参数以统一脚本约定

返回值
    0  成功
    1  参数缺失或源文件不可读
    2  解析结果异常（未解析出任何条目）

依赖
    仅标准库。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

WIKI_BASE = "https://github.com/acaGPT/Jurisprudence/wiki"
WIKI_REPO = "https://github.com/acaGPT/Jurisprudence.wiki"
# Wiki 条目里的头像走相对路径（images/*.png），只在 wiki 域内有效；
# 站点引用时必须改写为 wiki 仓库的 raw 绝对地址，否则全部 404。
WIKI_RAW = "https://raw.githubusercontent.com/wiki/acaGPT/Jurisprudence"

RE_UNIT = re.compile(r"^###\s+第(.+?)单元\s*·\s*(.+?)（(.+?)）\s*$")
RE_HEAD = re.compile(r"^\*\*(.+?)\*\*\s*(?:——|—|–|--|-{2,})\s*(.*)$")
RE_CODE = re.compile(r"^(P[IVX]+\.[0-9a-z.]*)\.")
RE_SECTION = re.compile(r"^\*(经典文献|延伸阅读|课前概览)")
RE_ITEM = re.compile(r"^-\s+")
RE_ARROW = re.compile(r"\[→\s*([^\]]+)\]\(([^)]+)\)")
RE_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
RE_IMG = re.compile(r"^<img\s+src=\"([^\"]+)\"[^>]*>\s*")
RE_AUTHOR_YEAR = re.compile(r"^(.*?)\s*\((\d{4})[^)]*\)\s*")
RE_AUTHOR_YEAR_ZH = re.compile(r"^(.*?)（(\d{4})[^）]*）\s*《([^》]+)》")
RE_MD_ITALIC = re.compile(r"\*([^*\n]+)\*")
RE_MD_QUOTED = re.compile(r"'([^'\n]+)'")

UNIT_NUMERALS = {
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
}

# 渠道归一：标签（[→ xx] 的人写名）优先，域名兜底。粗维只分「全文直读」与「需定位或订阅」。
CHANNEL_BY_LABEL = {
    "open library": ("Open Library", "fulltext"),
    "doi.org": ("doi.org", "locator"),
    "project gutenberg": ("Project Gutenberg", "fulltext"),
    "heinonline": ("HeinOnline", "locator"),
    "internet archive": ("Internet Archive", "fulltext"),
    "archive.org": ("Internet Archive", "fulltext"),
    "tanner lectures": ("Tanner Lectures", "fulltext"),
    "new advent": ("New Advent", "fulltext"),
    "pdf": ("直接 PDF", "fulltext"),
    "open access": ("开放获取", "fulltext"),
    "yale law school open repository": ("Yale 开放仓储", "fulltext"),
    "georgia law review repository": ("Georgia Law Review 仓储", "fulltext"),
    "cardozo law review repository": ("Cardozo Law Review 仓储", "fulltext"),
}
CHANNEL_BY_DOMAIN = {
    "openlibrary.org": ("Open Library", "fulltext"),
    "doi.org": ("doi.org", "locator"),
    "www.gutenberg.org": ("Project Gutenberg", "fulltext"),
    "gutenberg.org": ("Project Gutenberg", "fulltext"),
    "heinonline.org": ("HeinOnline", "locator"),
    "archive.org": ("Internet Archive", "fulltext"),
    "tannerlectures.utah.edu": ("Tanner Lectures", "fulltext"),
    "www.newadvent.org": ("New Advent", "fulltext"),
    "openyls.law.yale.edu": ("Yale 开放仓储", "fulltext"),
}
FULLTEXT_DOMAINS = {
    "plato.stanford.edu", "iep.utm.edu", "en.wikipedia.org",
    "www.law.cornell.edu", "www.worldhistory.org",
}


def read_source_commit(wiki_dir: Path) -> str:
    """读取 Wiki 克隆当前的 commit 短哈希，用于追溯数据版本。"""
    try:
        out = subprocess.run(
            ["git", "-C", str(wiki_dir), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=10, check=False,
        )
        return out.stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def normalize_channel(label: str | None, url: str) -> tuple[str, str]:
    """把条目的获取渠道归一为 (细粒度渠道名, 粗分类)。

    标签是人写的（「Open Library」「PDF」……），优先按标签匹配；匹配不到再看域名；
    仍无法识别时按「开放获取」处理并保留标签原文——大纲里未识别的渠道几乎都是
    期刊开放仓储或直链 PDF，误判为「需订阅」会让可读文献被筛没，方向宁可乐观。
    """
    if label:
        known = CHANNEL_BY_LABEL.get(label.strip().lower())
        if known:
            return known
    domain = urlparse(url).netloc.lower()
    if domain in CHANNEL_BY_DOMAIN:
        return CHANNEL_BY_DOMAIN[domain]
    if domain in FULLTEXT_DOMAINS:
        return domain, "fulltext"
    if label:
        return label.strip(), "fulltext"
    return domain or "未标注", "fulltext"


def strip_markup(text: str) -> str:
    """去掉行内 Markdown 的斜体星号与引注标记，保留纯文本。"""
    return text.replace("*", "").strip()


def extract_title(body: str) -> tuple[str, str]:
    """从条目正文提取题名与条目类型。

    题名用斜体（书）或单引号（文章）区分；古籍译本常无「作者 (年份)」前缀，
    只剩斜体题名，同样按此判定。取靠前出现的那个标记。
    """
    italic = RE_MD_ITALIC.search(body)
    quoted = RE_MD_QUOTED.search(body)
    if italic and (not quoted or italic.start() < quoted.start()):
        return italic.group(1).strip(), "book"
    if quoted:
        return quoted.group(1).strip(), "article"
    return strip_markup(body), "misc"


def parse_classic(item: str) -> dict:
    """解析一条经典文献。

    支持三种书写形态：英文「作者 (年份) *题名*, …」、年份区间或跨年
    （如 (1739–40)、(1781/1787)，括号内以 4 位数字开头即可）、中文
    「作者（年份）《书名》」。缺作者或年份不算失败——古籍译本本就常无年份，
    判定 parsed 只看题名与链接是否拿得到。
    """
    arrow = RE_ARROW.search(item)
    access_label = arrow.group(1).strip() if arrow else None
    access_url = arrow.group(2).strip() if arrow else ""
    channel, access_kind = normalize_channel(access_label, access_url)

    body = item[:arrow.start()] if arrow else item
    body = body.strip()

    zh = RE_AUTHOR_YEAR_ZH.match(body)
    if zh:
        author = strip_markup(zh.group(1))
        year = int(zh.group(2))
        title = zh.group(3).strip()
        entry_type = "book"
    else:
        entry_type = "misc"
        match = RE_AUTHOR_YEAR.match(body)
        if match:
            author = strip_markup(match.group(1))
            year = int(match.group(2))
            rest = body[match.end():]
            title, entry_type = extract_title(rest)
        else:
            author, year = "", None
            title, entry_type = extract_title(body)

    return {
        "author": author,
        "year": year,
        "title": title,
        "entry_type": entry_type,
        "access": channel,
        "access_kind": access_kind,
        "access_url": access_url,
        "parsed": bool(title and access_url),
    }


def parse_further(item: str) -> dict:
    """解析一条延伸阅读：整条即链接，可能带学者头像前缀。"""
    avatar = None
    img = RE_IMG.match(item)
    if img:
        avatar = img.group(1).strip()
        if not urlparse(avatar).netloc:
            avatar = f"{WIKI_RAW}/{avatar.lstrip('/')}"
        item = item[img.end():]

    link = RE_LINK.search(item)
    if not link:
        return {
            "author": "", "year": None, "title": strip_markup(item),
            "entry_type": "misc", "access": "未标注", "access_kind": "fulltext",
            "access_url": "", "avatar": avatar, "parsed": False,
        }

    label, url = link.group(1).strip(), link.group(2).strip()
    channel, access_kind = normalize_channel(None, url)
    return {
        "author": "", "year": None, "title": label,
        "entry_type": "web", "access": channel, "access_kind": access_kind,
        "access_url": url, "avatar": avatar, "parsed": True,
    }


def collect_chapter_blocks(lines: list[str]) -> list[tuple[str, int, list[str]]]:
    """复用课程地图的配对逻辑，切出各章文本块。

    中英题名成对合并后，块终点须越过本章两行再找下一个异章标题行；
    两章题名紧邻（PVI.1.a 与 PVI.1.b）时，单纯的「后一个标题行」会落进
    下一章题名，把本章文献整段丢掉——这是 v0.1.1 修过的坑，此处必须沿用。
    """
    headings = []
    for index, line in enumerate(lines):
        if not line.startswith("**"):
            continue
        match = RE_HEAD.match(line)
        if match and RE_CODE.match(match.group(1).strip()):
            headings.append((index, match))

    def code_of(entry):
        return RE_CODE.match(entry[1].group(1).strip()).group(1)

    def next_chapter_start(start: int, code: str) -> int:
        for probe in range(start, len(headings)):
            if code_of(headings[probe]) != code:
                return headings[probe][0]
        return len(lines)

    # 章节块的终点不得越过顶层 ## 标题：最后一章（PIX.4）之后还有
    # 「课程政策」等小节，其列表条目不是文献，不截断就会混进延伸阅读。
    top_level = [i for i, line in enumerate(lines) if line.startswith("## ")]

    def block_end(candidate: int, after: int) -> int:
        later = [i for i in top_level if i > after]
        return min(candidate, later[0]) if later else candidate

    blocks = []
    cursor = 0
    while cursor < len(headings):
        index, match = headings[cursor]
        code = code_of(headings[cursor])
        end = headings[cursor + 1][0] if cursor + 1 < len(headings) else len(lines)
        if cursor + 1 < len(headings) and code_of(headings[cursor + 1]) == code:
            end = next_chapter_start(cursor + 2, code)
            cursor += 2
        else:
            cursor += 1
        blocks.append((code, index, lines[index:block_end(end, index)]))
    return blocks


def extract(wiki_dir: Path) -> tuple[dict, dict]:
    """解析大纲全文，返回 (数据层, 元信息)。"""
    source = wiki_dir / "Course-Syllabus.md"
    if not source.is_file():
        raise FileNotFoundError(f"未找到大纲文件：{source}")

    lines = source.read_text(encoding="utf-8").split("\n")

    unit_marks = []
    for index, line in enumerate(lines):
        unit = RE_UNIT.match(line)
        if unit:
            unit_marks.append(
                (UNIT_NUMERALS.get(unit.group(1).strip(), 0), index)
            )

    items: list[dict] = []
    for code, index, block in collect_chapter_blocks(lines):
        unit = next((num for num, start in reversed(unit_marks) if start < index), 0)
        current = None
        seq = {"classic": 0, "further": 0}

        for line in block:
            section = RE_SECTION.match(line)
            if section:
                current = {"经典文献": "classic", "延伸阅读": "further",
                           "课前概览": "preclass"}[section.group(1)]
                continue
            if not current or current == "preclass" or not RE_ITEM.match(line):
                continue

            seq[current] += 1
            raw = line.strip()[2:].strip()
            parsed = parse_classic(raw) if current == "classic" else parse_further(raw)
            items.append({
                "id": f"{code}-{current}-{seq[current]:02d}",
                "kind": current,
                "chapter": code,
                "unit": unit,
                "raw": raw,
                **parsed,
            })

    # 同一著作在多章出现时标注共引，拼阅读清单时可据此去重。
    # 只认「作者 + 题名」都非空的条目：延伸阅读多为百科条目，缺少作者，
    # 强行按题名归并会把同名不同页的条目误判为重复。
    def dup_key(item: dict) -> tuple[str, str]:
        return ((item.get("author") or "").strip().lower(),
                (item.get("title") or "").strip().lower())

    chapters_by_key: dict[tuple[str, str], list[str]] = {}
    for item in items:
        key = dup_key(item)
        if not key[0]:
            continue
        bucket = chapters_by_key.setdefault(key, [])
        if item["chapter"] not in bucket:
            bucket.append(item["chapter"])

    for item in items:
        key = dup_key(item)
        chapters = chapters_by_key.get(key, [item["chapter"]])
        item["dup_count"] = len(chapters)
        if len(chapters) > 1:
            item["dup_chapters"] = chapters

    channels = Counter(item["access"] for item in items)
    data = {
        "stats": {
            "total": len(items),
            "classic": sum(1 for i in items if i["kind"] == "classic"),
            "further": sum(1 for i in items if i["kind"] == "further"),
            "fulltext": sum(1 for i in items if i["access_kind"] == "fulltext"),
            "locator": sum(1 for i in items if i["access_kind"] == "locator"),
            "unparsed": sum(1 for i in items if not i["parsed"]),
            "dup_items": sum(1 for i in items if i["dup_count"] > 1),
            "channels": dict(channels.most_common()),
        },
        "items": items,
    }

    meta = {
        "generated_at": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M %z"),
        "source_repo": WIKI_REPO,
        "source_commit": read_source_commit(wiki_dir),
        "wiki_base": WIKI_BASE,
        "stats": data["stats"],
    }
    return data, meta


def main() -> int:
    parser = argparse.ArgumentParser(
        description="从《法理学》课程 Wiki 抽取文献条目，生成文献库数据层。",
    )
    parser.add_argument("--wiki", required=True, help="已克隆的 Jurisprudence.wiki 目录")
    parser.add_argument("--out", required=True, help="数据输出目录")
    parser.add_argument("--auto", action="store_true", help="非交互式执行")
    args = parser.parse_args()

    wiki_dir = Path(args.wiki).expanduser().resolve()
    out_dir = Path(args.out).expanduser().resolve()

    try:
        data, meta = extract(wiki_dir)
    except FileNotFoundError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1

    if not data["items"]:
        print("错误：未解析出任何文献条目，请检查大纲的小节格式。", file=sys.stderr)
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "references.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8",
    )
    (out_dir / "references-meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8",
    )

    stats = data["stats"]
    print(f"文献 {stats['total']} · 经典 {stats['classic']} · 延伸 {stats['further']} · "
          f"全文直读 {stats['fulltext']} · 需定位或订阅 {stats['locator']} · "
          f"解析失败 {stats['unparsed']}")
    print(f"渠道分布：{dict(list(stats['channels'].items())[:6])}")
    print(f"源 commit：{meta['source_commit']}")
    print(f"输出：{out_dir / 'references.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
