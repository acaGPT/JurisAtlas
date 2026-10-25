#!/usr/bin/env python3
"""对周报做「同主体」初审：同一主体下的两条信息，是重复，还是连锁？

为什么要有这一步
    周报按「制度主题」组织，同一主体的信息因此被拆到不同主题里去。W43 的
    Anthropic 有 29 条散在 7 个主题、OpenAI 有 28 条散在 7 个主题。读者按主题
    读，看不出「这几条其实是一件事」；维护者靠肉眼也查不过来。这个脚本按主体
    重新归拢一遍，逐组回答两个问题：

        重复？  同一件事被两个主题各收一次，或同一件事的几种措辞各占一条。
        连锁？  同一主体的一串信息，在制度动作上先后相续，或围绕同一事项展开。

    判定只出「候选 + 置信度 + 理由」，不改写周报一个字，也不删任何条目。周报该
    怎么写还是怎么写——审查结论是给人复核的旁证，页面上一律标「机器初审」。

判定口径
    主体    先看标题，再看摘要。标题命中的算「主要涉及」，只在摘要里出现的算
            「仅提及」（进 related，不进主体卡）。
    重复    只认四种有据可查的情形，每条都能说清理由：
              ① 共享同一链接；
              ② 标题词集 Jaccard ≥ 0.60；
              ③ 短标题被长标题包含且长度比 ≥ 0.60；
              ④ 同主题同事件类型，且摘要内容词重合 ≥ 0.45（措辞不同、讲同一件事）。
            跨主题的重复另有一条：共享 ≥ 4 个稀有内容词且标题共享 ≥ 3 个词。
            逐条只归一个重复组，不做链式传染——被并走的条目不再参与后续配对。
    连锁    三型，各按各的证据：
              同类事项    同主题同事件类型的 ≥ 2 条，按日期串起来。不推断，只并置。
              程序推进    跨事件类型、制度动作阶段递增、且共享稀有对象。推断，低置信。
              同案        共享稀有专名（项目名、产品名、案件名），阶段不可比。
    稀有    中文二字词与拉丁词都按本份语料的 df 算（df ≤ 5 为稀有）。中文二字
            词不能当专名用——「元损」「益基」这类分词碎片天然稀有；所以它只用来
            判「同案」，不单独当连锁证据。专名只认原文首字母大写的拉丁词。

    中文标题的难处：真实重复的一对，标题 Jaccard 常常只有 0.1–0.3（措辞、数字、
    长尾都在稀释），所以不能只靠标题相似度，要挂在「同主题同事件类型」这个结构
    约束上；摘要重合才是可靠信号。

用法
    python3 tools/audit-subjects.py [--data site/assets/data/weekly.json]
                                    [--out site/assets/data/weekly-subjects.json]
                                    [--write] [--dup-threshold 0.75] [--quiet]

参数
    --data            周报数据层（由 tools/extract-weekly.py 产出）
    --out             审查结果输出路径
    --write           落盘。默认只打印审查表（dry-run）
    --dup-threshold   判重线，默认 0.75
    --min-chain       成链的最少条目数，默认 2
    --quiet           只打印统计行

返回值
    0  成功
    1  数据文件缺失或不可读
    2  数据层为空

依赖
    仅标准库。
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

SCHEMA = "jurisatlas-weekly-subjects/v1"

# ---------------------------------------------------------------- 主体词表
# key 稳定标识，name 展示名，aliases 正则。同一家公司的简称、旧名、旗舰产品都并到
# 一个 key 之下——「xAI 现在叫 SpaceXAI」这种改名，分开放等于把一条线切断。
SUBJECTS: list[dict] = [
    {"key": "openai", "name": "OpenAI", "kind": "company",
     "aliases": [r"OpenAI", r"ChatGPT", r"Altman", r"奥尔特曼", r"Codex"]},
    {"key": "anthropic", "name": "Anthropic", "kind": "company",
     "aliases": [r"Anthropic", r"Claude", r"Amodei"]},
    {"key": "google", "name": "Google", "kind": "company",
     "aliases": [r"Google", r"Alphabet", r"Gemini", r"DeepMind", r"AI Overview"]},
    {"key": "meta", "name": "Meta", "kind": "company",
     "aliases": [r"\bMeta\b", r"Facebook", r"Instagram", r"Llama"]},
    {"key": "xai", "name": "xAI", "kind": "company",
     "aliases": [r"xAI", r"SpaceXAI", r"Grok", r"Colossus"]},
    {"key": "nvidia", "name": "Nvidia", "kind": "company",
     "aliases": [r"Nvidia", r"英伟达"]},
    {"key": "microsoft", "name": "Microsoft", "kind": "company",
     "aliases": [r"Microsoft", r"微软", r"Copilot"]},
    {"key": "deepseek", "name": "DeepSeek", "kind": "company",
     "aliases": [r"DeepSeek", r"深度求索"]},
    {"key": "alibaba", "name": "阿里", "kind": "company",
     "aliases": [r"Alibaba", r"阿里巴巴", r"阿里", r"Qwen", r"通义"]},
    {"key": "bytedance", "name": "字节跳动", "kind": "company",
     "aliases": [r"ByteDance", r"字节跳动", r"TikTok", r"抖音"]},
    {"key": "moonshot", "name": "月之暗面", "kind": "company",
     "aliases": [r"Moonshot", r"Kimi", r"月之暗面"]},
    {"key": "minimax", "name": "MiniMax", "kind": "company", "aliases": [r"MiniMax"]},
    {"key": "apple", "name": "Apple", "kind": "company", "aliases": [r"Apple", r"苹果公司"]},
    {"key": "amazon", "name": "Amazon", "kind": "company",
     "aliases": [r"Amazon", r"AWS", r"亚马逊"]},
    {"key": "characterai", "name": "Character.AI", "kind": "company",
     "aliases": [r"Character\.?\s?AI"]},
    {"key": "disney", "name": "Disney", "kind": "company", "aliases": [r"Disney", r"迪士尼"]},
    {"key": "softbank", "name": "软银", "kind": "company", "aliases": [r"SoftBank", r"软银"]},
    {"key": "nscale", "name": "Nscale", "kind": "company", "aliases": [r"Nscale"]},
    {"key": "perplexity", "name": "Perplexity", "kind": "company", "aliases": [r"Perplexity"]},
    {"key": "huggingface", "name": "Hugging Face", "kind": "company",
     "aliases": [r"Hugging\s?Face"]},
    {"key": "mistral", "name": "Mistral", "kind": "company", "aliases": [r"Mistral"]},
    {"key": "suno", "name": "Suno", "kind": "company", "aliases": [r"Suno"]},
    {"key": "cloudflare", "name": "Cloudflare", "kind": "company", "aliases": [r"Cloudflare"]},
    {"key": "reddit", "name": "Reddit", "kind": "company", "aliases": [r"Reddit"]},
    {"key": "mofcom", "name": "商务部", "kind": "agency", "aliases": [r"商务部"]},
    {"key": "most", "name": "科技部", "kind": "agency", "aliases": [r"科技部"]},
    {"key": "statecouncil", "name": "国务院", "kind": "agency",
     "aliases": [r"国务院办公厅", r"国务院"]},
    {"key": "cac", "name": "网信办", "kind": "agency",
     "aliases": [r"网信办", r"国家互联网信息办公室"]},
    {"key": "mfa", "name": "外交部", "kind": "agency", "aliases": [r"外交部"]},
    {"key": "dhs", "name": "国土安全部", "kind": "agency",
     "aliases": [r"国土安全部", r"\bDHS\b"]},
    {"key": "doj", "name": "司法部", "kind": "agency", "aliases": [r"司法部", r"司法会议"]},
    {"key": "ftc", "name": "联邦贸易委员会", "kind": "agency",
     "aliases": [r"联邦贸易委员会", r"\bFTC\b"]},
    {"key": "eu", "name": "欧盟", "kind": "agency",
     "aliases": [r"欧盟委员会", r"欧盟", r"欧洲议会"]},
    {"key": "sec", "name": "SEC", "kind": "agency", "aliases": [r"\bSEC\b", r"证券交易委员会"]},
    {"key": "treasury", "name": "美国财政部", "kind": "agency", "aliases": [r"财政部"]},
    {"key": "congress", "name": "美国国会", "kind": "agency",
     "aliases": [r"国会", r"参议院", r"众议院"]},
    {"key": "tceq", "name": "得州环境质量委员会", "kind": "agency",
     "aliases": [r"得州环境质量委员会", r"\bTCEQ\b"]},
]

SUBJECT_BY_KEY = {entry["key"]: entry for entry in SUBJECTS}

# ---------------------------------------------------------------- 制度动作阶段
# 「同主体 + 阶段递增 + 共享对象」才连边。数字是制度链条上的位置，不是重要性。
STAGE: dict[tuple[str, str], tuple[int, str]] = {
    ("立法与政策制定", "法案进程"): (1, "提案"),
    ("立法与政策制定", "政策文件"): (2, "发布"),
    ("出口管制、制裁与投资审查", "其他管制事项"): (1, "提案"),
    ("出口管制、制裁与投资审查", "出口管制与制裁"): (2, "措施"),
    ("出口管制、制裁与投资审查", "禁用与移除"): (4, "执行"),
    ("监管执法与行政处罚", "调查与立案"): (3, "调查"),
    ("监管执法与行政处罚", "处罚与整改"): (4, "处罚"),
    ("监管执法与行政处罚", "下架与封禁"): (4, "下架"),
    ("监管执法与行政处罚", "其他执法事项"): (3, "执法"),
    ("司法与诉讼", "刑事案件"): (5, "起诉"),
    ("司法与诉讼", "民事与集体诉讼"): (5, "起诉"),
    ("司法与诉讼", "程序、证据与上诉"): (6, "上诉"),
    ("司法与诉讼", "其他司法事项"): (5, "诉讼"),
    ("知识产权", "权利申请与登记"): (2, "登记"),
    ("知识产权", "侵权与纠纷"): (5, "诉讼"),
    ("知识产权", "其他知产事项"): (4, "处置"),
    ("资本市场与公司交易", "融资与估值"): (2, "融资"),
    ("资本市场与公司交易", "上市与招股"): (3, "上市"),
    ("资本市场与公司交易", "信息披露与治理"): (3, "披露"),
    ("资本市场与公司交易", "并购与收购"): (4, "并购"),
    ("资本市场与公司交易", "破产与重整"): (5, "重整"),
    ("产业与商业动向", "发布与上线"): (2, "发布"),
    ("产业与商业动向", "合作与签约"): (3, "合作"),
    ("产业与商业动向", "人事与组织"): (3, "人事"),
    ("数据保护与个人信息", ""): (3, "处理"),
    ("竞争与平台治理", ""): (4, "处置"),
    ("内容治理、人格权与深度伪造", "标识与审核"): (3, "审核"),
    ("内容治理、人格权与深度伪造", "深度伪造与肖像"): (5, "诉讼"),
}

# ---------------------------------------------------------------- 文本处理
STOP_CHARS = set("的了是在和与及或对为以于其等这那也就都而但并很更最非常可被把从到向由所因如若"
                 "并且着过们你我他它之也都还要会能没有不上下个种些里外时年月日")

STOP_LATIN = {
    "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "by", "at",
    "from", "as", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that",
    "these", "those", "new", "said", "says", "say", "will", "can", "may", "could",
    "would", "should", "has", "have", "had", "not", "but", "after", "before", "now",
    "more", "than", "about", "into", "over", "under", "up", "out", "off",
    "ai", "vs", "via", "per", "inc", "ltd", "corp", "com", "org", "www", "http", "https",
}

RE_LATIN = re.compile(r"[A-Za-z][A-Za-z0-9\-']{1,}")
RE_CJK = re.compile(r"[\u4e00-\u9fff]+")


def cjk_bigrams(text: str) -> set[str]:
    """中文按相邻两字切。虚字参与的碎片丢掉——它们高频且没有区分度。"""
    out = set()
    for run in RE_CJK.findall(str(text or "")):
        for i in range(len(run) - 1):
            piece = run[i:i + 2]
            if piece[0] in STOP_CHARS or piece[1] in STOP_CHARS:
                continue
            out.add(piece)
    return out


def latin_tokens(text: str) -> set[str]:
    out = set()
    for token in RE_LATIN.findall(str(text or "")):
        word = token.strip("-'\u2019").lower()
        if len(word) < 2 or word in STOP_LATIN or word.isdigit():
            continue
        out.add(word)
    return out


def latin_propers(text: str) -> set[str]:
    """原文里首字母大写的拉丁词——项目名、产品名、案名的主要来源。

    小写的长串（X 上的用户名、域名片段）不收：它们在语料里天然稀有，会把
    「同一对象」判成一大堆不相干的社群碎片。
    """
    out = set()
    for token in RE_LATIN.findall(str(text or "")):
        head = token[0]
        if not head.isupper():
            continue
        word = token.strip("-'\u2019").lower()
        if len(word) < 4 or word in STOP_LATIN:
            continue
        out.add(word)
    return out


def cjk_phrases(text: str, low: int = 3, high: int = 6) -> set[str]:
    """中文 3–6 字短语。

    二字词是分词的碎片，撑不起判重；三字以上的短语几乎不会碎（「无投票权」
    「公共利益」「深度伪造」），而且低频短语本身就等于一个事件的名字。这是中文
    短文本里最靠得住的一条证据。
    """
    out = set()
    for run in RE_CJK.findall(str(text or "")):
        for size in range(low, high + 1):
            for start in range(len(run) - size + 1):
                out.add(run[start:start + size])
    return out


def tokens(text: str) -> set[str]:
    return latin_tokens(text) | cjk_bigrams(text)


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


# ---------------------------------------------------------------- 读数据
def load_items(path: Path) -> tuple[dict, list[dict]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    year = (data.get("period") or {}).get("start", "")[:4] or "2026"
    records: list[dict] = []

    def full_date(raw: str) -> str:
        raw = (raw or "").strip()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            return raw
        if re.fullmatch(r"\d{2}-\d{2}", raw):
            return f"{year}-{raw}"
        return raw

    for topic in data.get("topics", []):
        for group in topic.get("groups", []):
            for item in group.get("items", []):
                stages = item.get("stages") or []
                carried = item.get("carried") or []
                title = item.get("title", "")
                fact = item.get("fact", "")
                detail = " ".join(
                    [stage.get("stage", "") + " " + stage.get("text", "") for stage in stages] +
                    [step.get("title", "") for step in carried])
                date = item.get("date") or (stages[0]["date"] if stages else "")
                records.append({
                    "id": item["id"],
                    "title": title,
                    "topic": topic.get("name", ""),
                    "group": group.get("name", ""),
                    "date": full_date(date),
                    "kind": item.get("kind", "single"),
                    "stage_count": len(stages),
                    "head": title,
                    "summary": " ".join(part for part in (title, fact, detail) if part),
                    "urls": sorted({link.get("url", "") for link in item.get("links", [])
                                    if link.get("url")}),
                })
    return data, records


# ---------------------------------------------------------------- 主体识别
def match_subjects(text: str) -> list[str]:
    """按出现位置排序，同一位置取最长别名，避免 Meta 命中 metadata 这类事。"""
    hits: list[tuple[int, int, str]] = []
    for entry in SUBJECTS:
        best = None
        for alias in entry["aliases"]:
            match = re.search(alias, text, flags=re.IGNORECASE)
            if match and (best is None or match.start() < best[0]):
                best = (match.start(), len(match.group(0)))
        if best:
            hits.append((best[0], best[1], entry["key"]))
    hits.sort(key=lambda row: (row[0], -row[1]))
    seen: list[str] = []
    for _, _, key in hits:
        if key not in seen:
            seen.append(key)
    return seen


def primary_subject(record: dict) -> str:
    hits = match_subjects(record["title"])
    if hits:
        return hits[0]
    hits = match_subjects(record["summary"])
    return hits[0] if hits else ""


# ---------------------------------------------------------------- 稀有度
ALIAS_WORDS = {alias.lower().lstrip("\\b") for entry in SUBJECTS for alias in entry["aliases"]}
ALIAS_WORDS |= {"claude", "chatgpt", "grok", "gemini", "llama", "qwen", "kimi", "copilot",
                "codex", "spacexai", "openai", "anthropic"}


def build_idf(records: list[dict]) -> dict[str, float]:
    df: Counter[str] = Counter()
    for record in records:
        df.update(tokens(record["title"] + " " + record["summary"]))
    total = max(len(records), 1)
    return {term: math.log((total + 1) / (count + 1)) for term, count in df.items()}


def build_phrase_df(records: list[dict]) -> Counter[str]:
    df: Counter[str] = Counter()
    for record in records:
        df.update(cjk_phrases(record["title"]))
    return df


def rare_floor(total: int, limit_df: int = 5) -> float:
    return math.log((total + 1) / (limit_df + 1))


def content_terms(record: dict, idf: dict[str, float]) -> set[str]:
    """标题里的内容词：去掉主体别名，剩下的都算。"""
    return {term for term in tokens(record["title"])
            if term not in ALIAS_WORDS and idf.get(term, 0) > 0}


def rare_terms(record: dict, idf: dict[str, float], floor: float) -> set[str]:
    terms = tokens(record["title"] + " " + record["summary"])
    return {term for term in terms if term not in ALIAS_WORDS and idf.get(term, 0) >= floor}


RE_NUMERIC_PHRASE = re.compile(r"[0-9０-９%％]|亿|万元|美元|亿元")


def rare_phrases(record: dict, pdf: Counter[str], limit_df: int = 6) -> set[str]:
    """标题里够少见的 3–6 字短语。df ≤ 6 的短语基本就是一个事件的名字。

    带数字的短语一律不收：「亿美元损失」「亿美元算力」这种在两条无关的新闻里都会
    出现，它们相似是因为都提到了钱，不是因为讲了同一件事。
    """
    return {phrase for phrase in cjk_phrases(record["title"])
            if 0 < pdf.get(phrase, 99) <= limit_df
            and not RE_NUMERIC_PHRASE.search(phrase)}


def objects(record: dict, idf: dict[str, float], floor: float) -> set[str]:
    """稀有专名：首字母大写的拉丁词，且在语料里够少见。"""
    return {term for term in latin_propers(record["title"] + " " + record["summary"])
            if idf.get(term, 0) >= floor}


# ---------------------------------------------------------------- 判重
def duplicate_evidence(a: dict, b: dict, idf: dict[str, float], floor: float,
                       pdf: Counter[str]) -> tuple[float, str]:
    """返回（置信度，理由）。0 表示没有证据。"""
    if set(a["urls"]) & set(b["urls"]):
        return 1.0, "共享同一链接"

    shared_phrases = rare_phrases(a, pdf) & rare_phrases(b, pdf)
    strong = {phrase for phrase in shared_phrases if len(phrase) >= 4}
    """「无投票权股票类别」与「无投票权股份」这类，标题词集只有 0.3 的重合，但共享
    整段稀有短语——这才是同一件事的硬证据。还要过一道摘要：只共享短语、正文毫无
    交集的，是标题撞词（「ChinaTalk」和一篇政策解读都写着「出口管制」）。"""
    if strong and jaccard(tokens(a["summary"]), tokens(b["summary"])) >= 0.10:
        longest = max(strong, key=len)
        return 0.88, f"共同短语「{longest}」等 {len(shared_phrases)} 处"

    score = jaccard(tokens(a["title"]), tokens(b["title"]))
    if score >= 0.60:
        return 0.85, f"标题词集重合 {score:.2f}"

    short, long = sorted((a["title"], b["title"]), key=len)
    if short and short in long and len(short) / max(len(long), 1) >= 0.60:
        return 0.82, "短标题被长标题包含（长度比 ≥ 0.60）"

    same_group = (a["topic"], a["group"]) == (b["topic"], b["group"])
    if same_group:
        """同主题同事件类型里比对摘要——同一条目的两种措辞，摘要必然重合得多。"""
        summary_score = jaccard(tokens(a["summary"]), tokens(b["summary"]))
        if summary_score >= 0.45:
            return 0.80, f"同主题同事件类型，摘要内容词重合 {summary_score:.2f}"

    if a["topic"] == b["topic"] and score >= 0.45:
        """同一制度主题下标题高度类似，但事件类型被分到了两边（Meta 那四条无投票权
        股的报道就有两条落在「并购与收购」、两条落在「信息披露与治理」）。这类是
        真重复，只是聚类时归错了类。"""
        return 0.78, f"同主题下标题高度相似（词集重合 {score:.2f}），被分到了不同事件类型"

    shared_rare = rare_terms(a, idf, floor) & rare_terms(b, idf, floor)
    shared_head = content_terms(a, idf) & content_terms(b, idf)
    """跨主题这一路只给弱候选（0.6），不当结论。

    实测过：真重复的「安全法案」两条（摘要重合 0.15）、真重复的「5% 股份」两条
    （0.16）、以及并非同一件事的「5% 股份 vs 工人援助基金」（0.14），三项指标几乎
    分不开。这个域里跨主题判重没有可靠信号，只能出「请人看一眼」的候选，不能替人
    下结论——所以它进 suspects，不进 duplicates，也不计入疑重复统计。
    """
    if len(shared_rare) >= 4 and len(shared_head) >= 3:
        return 0.60, (f"跨主题候选：共享 {len(shared_rare)} 个稀有内容词"
                      f"（{'、'.join(sorted(shared_rare)[:3])}…）")
    return 0.0, ""


def find_duplicates(records: list[dict], idf: dict[str, float], floor: float,
                    pdf: Counter[str], threshold: float) -> tuple[list[dict], list[dict]]:
    """代表制：置信度高的先并，一条只能被并走一次，不做链式传染。

    返回（强证据组，弱候选组）。弱候选（0.6 的跨主题重合）只提示、不并入，所以
    不占用 absorbed——它那两条仍会各自参与连锁判定。
    """
    pairs: list[tuple[float, str, str, str]] = []
    weak: list[tuple[float, str, str, str]] = []
    for i in range(len(records)):
        for j in range(i + 1, len(records)):
            score, reason = duplicate_evidence(records[i], records[j], idf, floor, pdf)
            if not reason:
                continue
            row = (score, records[i]["id"], records[j]["id"], reason)
            if score >= threshold:
                pairs.append(row)
            else:
                weak.append(row)

    pairs.sort(key=lambda row: -row[0])
    groups: list[dict] = []
    used: dict[str, int] = {}
    for score, id_a, id_b, reason in pairs:
        holders = {used.get(id_a), used.get(id_b)} - {None}
        if len(holders) == 2:
            continue                      # 两条都已各自归组，不再并第三组
        if len(holders) == 1:
            index = holders.pop()
            for item in (id_a, id_b):
                if item not in groups[index]["ids"]:
                    groups[index]["ids"].append(item)
                    used[item] = index
            groups[index]["confidence"] = max(groups[index]["confidence"], round(score, 2))
            continue
        groups.append({"ids": [id_a, id_b], "confidence": round(score, 2), "reason": reason})
        used[id_a] = used[id_b] = len(groups) - 1

    """弱候选不进代表制：它不是「合并」，只是「这几条请对照看」。但同一簇的两两
    组合会重复出现（Meta 那四条无投票权股的报道能凑出五对），所以按连通性归簇，
    一个簇只报一次。"""
    parent: dict[str, str] = {}

    def find(node: str) -> str:
        parent.setdefault(node, node)
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    for _, id_a, id_b, _ in weak:
        root_a, root_b = find(id_a), find(id_b)
        if root_a != root_b:
            parent[root_b] = root_a

    roots: dict[str, set[str]] = defaultdict(set)
    for node in list(parent):
        roots[find(node)].add(node)
    best_of: dict[str, tuple[float, str]] = {}
    for score, id_a, id_b, reason in weak:
        root = find(id_a)
        if root not in best_of or score > best_of[root][0]:
            best_of[root] = (score, reason)

    suspects: list[dict] = []
    for root, ids in roots.items():
        if len(ids) < 2:
            continue
        score, reason = best_of.get(root, (0.6, ""))
        suspects.append({"ids": sorted(ids), "confidence": round(score, 2), "reason": reason})
    suspects.sort(key=lambda row: (-len(row["ids"]), row["ids"][0]))

    for group in groups:
        group["ids"] = sorted(group["ids"])
    return groups, suspects


# ---------------------------------------------------------------- 连锁
def find_chains(records: list[dict], absorbed: set[str], idf: dict[str, float],
                floor: float) -> list[dict]:
    """只认「有关系的两条」，不认「同一类堆在一起」。

    一个事件类型下堆了 11 条，那不叫连锁——那说明这个类型是个杂物筐。按主体读的
    时候条目本来就按主题分块、块内按日期排，同类并置的价值由版式提供，不必在这里
    再算一遍。这里只出两类真关系：
        程序推进    跨类型、制度动作阶段递增、共享稀有对象。
        同案        共享稀有专名，阶段不可比。
    """
    chains: list[dict] = []

    # ① 程序推进：阶段递增是推断，置信度低，所以再加一条「必须共享对象」。
    rest = [record for record in records if record["id"] not in absorbed]
    for i in range(len(rest)):
        for j in range(i + 1, len(rest)):
            a, b = rest[i], rest[j]
            if (a["topic"], a["group"]) == (b["topic"], b["group"]):
                continue
            stage_a = STAGE.get((a["topic"], a["group"]))
            stage_b = STAGE.get((b["topic"], b["group"]))
            if not stage_a or not stage_b or stage_a[0] >= stage_b[0]:
                continue
            shared = objects(a, idf, floor) & objects(b, idf, floor)
            """两条都提到同一个人（Musk、某个创始人）就相连，是这类判定最常见的
            误报。所以还要求标题里有一个「不是专名」的共同实词。"""
            words = (content_terms(a, idf) & content_terms(b, idf)) - shared
            if not shared or len(words) < 2:
                continue
            first, second = (a, b) if (a["date"] or "") <= (b["date"] or "") else (b, a)
            chains.append({
                "type": "程序推进",
                "ids": [first["id"], second["id"]],
                "relation": f"{stage_a[1]} → {stage_b[1]}",
                "confidence": 0.7,
                "reason": "同一对象：" + "、".join(sorted(shared)[:3]),
            })

    # ③ 同案：共享稀有专名，阶段不可比。同一批材料被不同主题各取一面。
    for i in range(len(rest)):
        for j in range(i + 1, len(rest)):
            a, b = rest[i], rest[j]
            if (a["topic"], a["group"]) == (b["topic"], b["group"]):
                continue
            shared = objects(a, idf, floor) & objects(b, idf, floor)
            words = (content_terms(a, idf) & content_terms(b, idf)) - shared
            if len(shared) < 2 or len(words) < 2:
                continue
            stage_a = STAGE.get((a["topic"], a["group"]))
            stage_b = STAGE.get((b["topic"], b["group"]))
            if stage_a and stage_b and stage_a[0] != stage_b[0]:
                continue                   # 已经由「程序推进」解释过
            first, second = sorted((a, b), key=lambda row: (row["date"] or "9999", row["id"]))
            chains.append({
                "type": "同案",
                "ids": [first["id"], second["id"]],
                "relation": "同案不同侧面",
                "confidence": 0.68,
                "reason": "共享：" + "、".join(sorted(shared)[:3]),
            })
    return chains


# ---------------------------------------------------------------- 主体审查
def audit_subject(key: str, records: list[dict], idf: dict[str, float], floor: float,
                  pdf: Counter[str], dup_threshold: float, min_chain: int) -> dict:
    duplicates, suspects = find_duplicates(records, idf, floor, pdf, dup_threshold)
    absorbed = {item for group in duplicates for item in group["ids"]}
    chains = [chain for chain in find_chains(records, absorbed, idf, floor)
              if len(chain["ids"]) >= min_chain]

    items = []
    for record in sorted(records, key=lambda row: (row["date"] or "9999", row["id"])):
        items.append({
            "id": record["id"], "title": record["title"], "topic": record["topic"],
            "group": record["group"], "date": record["date"], "kind": record["kind"],
        })
    return {
        "key": key,
        "name": SUBJECT_BY_KEY.get(key, {}).get("name", key),
        "kind": SUBJECT_BY_KEY.get(key, {}).get("kind", ""),
        "count": len(records),
        "topics": sorted({record["topic"] for record in records}),
        "items": items,
        "duplicates": duplicates,
        "suspects": suspects,
        "chains": chains,
    }


# ---------------------------------------------------------------- 输出
def main() -> int:
    parser = argparse.ArgumentParser(description="对周报做同主体初审：判重与找连锁。")
    parser.add_argument("--data", default="site/assets/data/weekly.json")
    parser.add_argument("--out", default="site/assets/data/weekly-subjects.json")
    parser.add_argument("--write", action="store_true", help="落盘（默认只打印审查表）")
    parser.add_argument("--dup-threshold", type=float, default=0.75)
    parser.add_argument("--min-chain", type=int, default=2)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    data_path = Path(args.data)
    if not data_path.exists():
        print(f"错误：找不到周报数据 {data_path}", file=sys.stderr)
        return 1
    try:
        data, records = load_items(data_path)
    except (json.JSONDecodeError, KeyError) as error:
        print(f"错误：数据层读不了（{error}）", file=sys.stderr)
        return 1
    if not records:
        print("错误：数据层里没有条目。", file=sys.stderr)
        return 2

    idf = build_idf(records)
    pdf = build_phrase_df(records)
    floor = rare_floor(len(records))

    subjects_of: dict[str, list[dict]] = defaultdict(list)
    related: dict[str, list[str]] = defaultdict(list)
    for record in records:
        primary = primary_subject(record)
        record["subject"] = primary
        if primary:
            subjects_of[primary].append(record)
        for key in match_subjects(record["summary"]):
            if key != primary:
                related[key].append(record["id"])

    groups = [audit_subject(key, members, idf, floor, pdf, args.dup_threshold,
                            args.min_chain)
              for key, members in subjects_of.items()]
    groups.sort(key=lambda row: (-row["count"], row["name"]))

    dup_groups = [(group, dup) for group in groups for dup in group["duplicates"]]
    dup_items = len({item for _, dup in dup_groups for item in dup["ids"]})
    suspect_pairs = [(group, row) for group in groups for row in group["suspects"]]
    chains = [(group, chain) for group in groups for chain in group["chains"]]
    chain_items = len({item for _, chain in chains for item in chain["ids"]})
    review = {
        "status": "machine",
        "items_checked": len(records),
        "subjects": len(groups),
        "subjects_multi": sum(1 for group in groups if group["count"] > 1),
        "unassigned": sum(1 for record in records if not record["subject"]),
        "duplicate_groups": len(dup_groups),
        "duplicate_items": dup_items,
        "suspects": len(suspect_pairs),
        "chains": len(chains),
        "chain_items": chain_items,
        "by_type": dict(Counter(chain["type"] for _, chain in chains)),
    }

    payload = {
        "schema": SCHEMA,
        "week": data.get("week", ""),
        "generated_from": data_path.name,
        "params": {"dup_threshold": args.dup_threshold, "min_chain": args.min_chain,
                   "rare_df": 5},
        "review": review,
        "subjects": groups,
        "related": {key: sorted(set(ids)) for key, ids in sorted(related.items())},
    }

    if not args.quiet:
        print(f"本周条目 {len(records)} 条，认出主体 {review['subjects']} 个"
              f"（2 条以上 {review['subjects_multi']} 个），"
              f"{review['unassigned']} 条未挂主体。")
        print()
        index = {item["id"]: item for group in groups for item in group["items"]}
        for group in groups:
            if group["count"] < 2:
                continue
            mark = ""
            if group["duplicates"]:
                mark += f"  疑重复 {len(group['duplicates'])} 组"
            if group["suspects"]:
                mark += f"  待复核 {len(group['suspects'])} 簇"
            if group["chains"]:
                mark += f"  链 {len(group['chains'])} 条"
            print(f"{group['name'][:12]:12} {group['count']:3} 条 · 跨 "
                  f"{len(group['topics'])} 主题{mark}")
            for dup in group["duplicates"]:
                print(f"    ⟳ 重复（{dup['confidence']}）{dup['reason']}")
                for item_id in dup["ids"]:
                    row = index.get(item_id)
                    if row:
                        print(f"        {row['date']} {row['title'][:50]}")
            for suspect in group["suspects"]:
                print(f"    ? 待复核（{suspect['confidence']}）{suspect['reason']}")
                for item_id in suspect["ids"]:
                    row = index.get(item_id)
                    if row:
                        print(f"        {row['date']} {row['title'][:50]}")
            for chain in group["chains"]:
                print(f"    → {chain['type']}（{chain['confidence']}）{chain['reason']}")
                for item_id in chain["ids"]:
                    row = index.get(item_id)
                    if row:
                        print(f"        {row['date']} {row['title'][:50]}")
        print()
        print(f"合计：疑重复 {review['duplicate_groups']} 组（{review['duplicate_items']} 条）"
              f"· 待复核 {review['suspects']} 簇"
              f"· 链 {review['chains']} 条（{review['chain_items']} 条）"
              f"· 分型 {review['by_type']}")

    if args.write:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
                            encoding="utf-8")
        print(f"已写出 {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
