#!/usr/bin/env python3
"""检查课程地图站点与课程 Wiki 的同步状态。

用途
    数据层（site/assets/data/*.json）由 Wiki 大纲生成，生成时把源 Wiki 的 commit
    短哈希写进 meta.json 的 source_commit。本脚本沿「Wiki 远端 → 仓库数据层 →
    线上 Pages」三级比对该哈希，判断站点是否落后于大纲，并给出下一步动作。

    三级各自独立判定，互不依赖：任一级取不到只影响该行的结论，不中断整次检查。

用法
    python3 tools/check-sync.py [--wiki-dir DIR] [--meta FILE] [--repo-root DIR]
                                [--site-url URL] [--offline] [--json]

参数
    --wiki-dir    本地 Wiki 克隆目录；给出时用它替代远端查询作为 Wiki 侧基准
    --meta        被检数据层的 meta.json，默认 <仓库根>/site/assets/data/meta.json；
                  CI 里可指到 gh-pages 分支检出物上的 meta.json，检查「待发布产物」
    --repo-root   仓库根目录（默认取本脚本上级目录），数据层由此定位
    --site-url    线上站点地址，默认 <https://acagpt.github.io/JurisAtlas/>
    --offline     只做本地检查，跳过远端 Wiki 与线上 Pages 的联网查询
    --json        以 JSON 输出结论，供脚本或 CI 消费
    --auto        非交互式执行；本脚本无交互环节，保留该参数以统一脚本约定

返回值
    0  三级全部对齐
    1  存在不一致（至少一个环节的源 commit 落后）
    2  无法判定（数据层缺失、联网失败、仓库结构异常）

依赖
    仅标准库。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

WIKI_REPO = "https://github.com/acaGPT/Jurisprudence.wiki.git"
WIKI_DEFAULT_BRANCH = "master"
DEFAULT_SITE_URL = "https://acagpt.github.io/JurisAtlas/"

# 三级状态：对齐 / 落后 / 取不到
OK = "ok"
BEHIND = "behind"
UNKNOWN = "unknown"


def short(sha: str | None) -> str:
    """把 commit 哈希截成短形式；空值给占位符，避免下游拿到 None 拼接。"""
    return sha[:7] if sha else "—"


def same(base: str | None, current: str | None) -> bool:
    """按短哈希比对两个 commit；任一侧缺失时判为不一致，交由上层降级为「无法判定」。"""
    if not base or not current:
        return False
    return base[:7] == current[:7]


def read_commits(
    root: Path, wiki_dir: Path | None, no_remote: bool
) -> tuple[str | None, str]:
    """取 Wiki 侧的源 commit 基准。

    给了本地克隆就用它的 HEAD（离线可用、最准）；否则查远端 master 的 HEAD。
    返回 (短哈希, 说明)，取不到时哈希为 None。
    """
    if wiki_dir:
        try:
            out = subprocess.run(
                ["git", "-C", str(wiki_dir), "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=10, check=False,
            )
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip(), f"本地克隆 {wiki_dir.name}"
        except (OSError, subprocess.SubprocessError):
            pass

    if no_remote:
        return None, "未给本地克隆且 --offline，跳过 Wiki 侧查询"

    try:
        out = subprocess.run(
            ["git", "ls-remote", "--heads", WIKI_REPO,
             f"refs/heads/{WIKI_DEFAULT_BRANCH}"],
            capture_output=True, text=True, timeout=20, check=False,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.split()[0], f"远端 {WIKI_DEFAULT_BRANCH}"
        return None, f"ls-remote 失败：{out.stderr.strip()[:80]}"
    except (OSError, subprocess.SubprocessError):
        return None, "ls-remote 无法执行"


def read_layer(meta_path: Path) -> tuple[str | None, dict, str]:
    """读某个数据层的源 commit 与统计。

    同时服务两处：仓库内站点数据层，以及 CI 检出的 gh-pages 分支产物。
    返回 (短哈希, 统计摘要, 说明)。文件缺失或不可解析时哈希为 None。
    """
    if not meta_path.is_file():
        return None, {}, f"数据层缺失：{meta_path}"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as error:
        return None, {}, f"数据层不可解析：{error}"

    source = meta.get("source_commit")
    stats = meta.get("stats", {})
    return source, stats, str(meta_path)


def fetch_live_layer(site_url: str) -> tuple[str | None, dict, str]:
    """读线上 Pages 上的数据层源 commit 与统计。

    站点位于子路径（/<仓库名>/）时，data 目录的地址是 <站点根>assets/data/meta.json，
    这里先按传入地址直取，取不到再补一个 assets/data 路径，兼容传站点根与传文件地址两种用法。
    """
    candidates = [f"{site_url.rstrip('/')}/assets/data/meta.json"]
    if not site_url.rstrip("/").endswith("/assets/data/meta.json"):
        candidates.append(f"{site_url.rstrip('/')}/assets/data/meta.json")

    last_error = "无候选地址"
    for url in dict.fromkeys(candidates):
        request = urllib.request.Request(url, headers={"User-Agent": "check-sync"})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                meta = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as error:
            last_error = f"{url} 取不到（{error}）"
            continue
        return meta.get("source_commit"), meta.get("stats", {}), url

    return None, {}, last_error


def judge(base: str | None, current: str | None, label: str) -> tuple[str, str]:
    """把一对哈希判成 对齐/落后/未知，并给出人类可读的一句结论。"""
    if base is None or current is None:
        return UNKNOWN, f"{label} 无法比对（Wiki {short(base)} / 站点 {short(current)}）"
    if same(base, current):
        return OK, f"{label} 已对齐（{short(base)}）"
    return BEHIND, f"{label} 落后：站点 {short(current)}，Wiki {short(base)}"


def build_report(args) -> dict:
    """执行一次完整三级检查，返回结构化结论。"""
    root = Path(args.repo_root).expanduser().resolve()
    wiki_dir = Path(args.wiki_dir).expanduser().resolve() if args.wiki_dir else None
    if wiki_dir is not None and not wiki_dir.is_dir():
        wiki_dir = None

    base, base_note = read_commits(root, wiki_dir, args.offline)
    meta_path = Path(args.meta).expanduser().resolve() if args.meta else \
        root / "site" / "assets" / "data" / "meta.json"
    local_commit, local_stats, local_note = read_layer(meta_path)

    if args.offline:
        live_commit, live_stats, live_note = None, {}, "跳过联网检查（--offline）"
    else:
        live_commit, live_stats, live_note = fetch_live_layer(args.site_url)

    local_state, local_text = judge(base, local_commit, "数据层")
    live_state, live_text = judge(base, live_commit, "线上 Pages")

    behind = (base is not None
              and (not same(base, local_commit) or not same(base, live_commit)))

    if args.offline:
        # 离线只做一半：线上 Pages 未查，不能报「同步」；Wiki 侧也取不到
        # 就更是无从判定，两种都不能驱动 CI 去发布。
        if base is None:
            verdict, advice = ("无法判定", "Wiki 侧基准缺失，跳过同步")
        elif same(base, local_commit):
            verdict, advice = ("本地已对齐", "未查线上；联网运行可复查 Pages 是否同步")
        else:
            verdict, advice = ("不同步", "重跑 tools/extract-syllabus.py 更新数据层")
    elif behind:
        verdict = "不同步"
        advice = "先重跑 tools/extract-syllabus.py 更新数据层，再把站点重新发布到 gh-pages"
    else:
        verdict, advice = "同步", "三级源 commit 一致，无需处理"

    return {
        "wiki_source": base,
        "wiki_source_note": base_note,
        "local_layer": local_commit,
        "local_stats": local_stats,
        "local_note": local_note,
        "meta_path": str(meta_path),
        "local_state": local_state,
        "live_layer": live_commit,
        "live_stats": live_stats,
        "live_note": live_note,
        "live_state": live_state,
        "verdict": verdict,
        "advice": advice,
        "lines": [local_text, live_text],
    }


def print_report(report: dict) -> None:
    """把结论打成一段两行式的简短报告，供人工直接读。"""
    print(f"源 Wiki    ：{short(report['wiki_source'])}（{report['wiki_source_note']}）")
    print(f"数据层     ：{short(report['local_layer'])}｜{report['lines'][0]}")
    print(f"线上 Pages ：{short(report['live_layer'])}｜{report['lines'][1]}")
    print(f"结论       ：{report['verdict']}")
    if report["verdict"] == "不同步":
        print(f"动作       ：{report['advice']}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="检查课程地图站点与课程 Wiki 的源 commit 是否一致。",
    )
    parser.add_argument("--wiki-dir", help="本地 Wiki 克隆目录，作为 Wiki 侧基准")
    parser.add_argument("--meta", help="被检数据层的 meta.json 路径")
    parser.add_argument("--repo-root", help="仓库根目录（默认脚本上级目录）")
    parser.add_argument("--site-url", default=DEFAULT_SITE_URL,
                        help="线上站点地址")
    parser.add_argument("--offline", action="store_true",
                        help="只做本地检查，跳过联网查询")
    parser.add_argument("--json", dest="as_json", action="store_true",
                        help="以 JSON 输出结论")
    parser.add_argument("--auto", action="store_true",
                        help="非交互式执行；本脚本无交互环节，保留该参数以统一约定")
    args = parser.parse_args()

    if not args.repo_root:
        args.repo_root = Path(__file__).resolve().parent.parent

    report = build_report(args)

    if args.as_json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    else:
        print_report(report)

    if report["verdict"] == "不同步":
        return 1
    if report["verdict"] == "无法判定":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
