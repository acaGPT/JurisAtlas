#!/usr/bin/env python3
"""本地预览周报页，并把页面上的改标与判定即时写进 feedback/。

用途
    周报页在 GitHub Pages 上是纯静态的：读者标完只能点一次「交回」，而维护者自己
    复核时不该有这一下。本脚本在 127.0.0.1 上同时提供静态文件与一个写入端点，页面
    每改一次就 POST 一次，落到 feedback/<周次>.jsonl。下次跑周报技能时第一步就读这
    个目录（见 tools/import-feedback.py），人工反馈因此是「改完就在那儿」，不需要
    交回、不需要导出、也不需要 GitHub 账号。

    只绑回环地址，只写本仓库的 feedback/ 目录，不做任何转发。

接口
    GET  /api/feedback?week=2026-W43   读取该周已记录的条目
    POST /api/feedback                 写入（同一 target 以最后一次为准）

用法
    python3 tools/serve-weekly.py                 # 8765，自动开浏览器
    python3 tools/serve-weekly.py --port 8770 --no-open
"""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SITE = ROOT / "site"
DEFAULT_FEEDBACK = ROOT / "feedback"
RE_WEEK = re.compile(r"^\d{4}-W\d{2}$")
LOCK = threading.Lock()


def record_key(record: dict) -> str:
    return str(record.get("kind", "")) + "|" + str(record.get("target", ""))


def read_week(path: Path) -> dict[str, dict]:
    """一行一条记录，同一 (kind, target) 只留最后一条。"""
    out: dict[str, dict] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        key = record_key(record)
        if record.get("target"):
            out[key] = record
    return out


def write_week(path: Path, records: dict[str, dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".jsonl.tmp")
    ordered = sorted(records.values(), key=lambda row: (row.get("kind", ""), row.get("target", "")))
    tmp.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in ordered),
                   encoding="utf-8")
    os.replace(tmp, path)


def merge(week: str, incoming: list[dict], feedback_dir: Path) -> int:
    path = feedback_dir / f"{week}.jsonl"
    with LOCK:
        records = read_week(path)
        for record in incoming:
            if not record.get("kind") or not record.get("target"):
                continue
            record["week"] = week
            record.setdefault("at", datetime.now().isoformat(timespec="seconds"))
            records[record_key(record)] = record
        write_week(path, records)
        return len(records)


def make_handler(site: Path, feedback_dir: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(site), **kwargs)

        def log_message(self, fmt, *args):          # 静音，只在出错时说话
            pass

        def do_GET(self):                            # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path.rstrip("/") != "/api/feedback":
                return super().do_GET()
            week = (parse_qs(parsed.query).get("week") or [""])[0]
            if not RE_WEEK.match(week):
                return self.send_json({"error": "week 形如 2026-W43"}, 400)
            records = list(read_week(feedback_dir / f"{week}.jsonl").values())
            return self.send_json({"week": week, "records": records})

        def do_POST(self):                           # noqa: N802
            if urlparse(self.path).path.rstrip("/") != "/api/feedback":
                return self.send_json({"error": "not found"}, 404)
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 200_000:
                return self.send_json({"error": "body 长度异常"}, 400)
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return self.send_json({"error": "无法解析 JSON"}, 400)
            week = str(payload.get("week") or "")
            if not RE_WEEK.match(week):
                return self.send_json({"error": "week 形如 2026-W43"}, 400)
            records = payload.get("records")
            if not isinstance(records, list) or not records:
                return self.send_json({"error": "records 必须是非空数组"}, 400)
            total = merge(week, records, feedback_dir)
            return self.send_json({"ok": True, "week": week, "count": total})

        def send_json(self, body: dict, status: int = 200):
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def end_headers(self):
            """本地预览不该被浏览器缓存挡住改动，一律 no-store。"""
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="本地预览周报页并接收反馈")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--site", default=str(DEFAULT_SITE))
    parser.add_argument("--feedback", default=str(DEFAULT_FEEDBACK))
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()

    site = Path(args.site).resolve()
    if not (site / "weekly.html").exists():
        raise SystemExit(f"找不到 {site / 'weekly.html'}")
    feedback_dir = Path(args.feedback).resolve()

    handler = make_handler(site, feedback_dir)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    url = f"http://127.0.0.1:{args.port}/weekly.html"
    print(f"周报页：{url}")
    print(f"反馈写入：{feedback_dir}/<周次>.jsonl")
    print("Ctrl-C 结束。")
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
