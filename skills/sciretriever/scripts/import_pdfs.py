#!/usr/bin/env python3
"""Import PDFs that come without a bibliography file (format `file`).

Usage: import_pdfs.py [--config-dir DIR] [--wait SECONDS] [--confirm] FOLDER_OR_FILE [...]

Collects the .pdf files under the given paths (symbolic links are not
followed), creates one intake batch of file-only items, sends every file with
its path relative to the given folder, starts the preview and reads it until
recognition ends, prints a summary and stops: the user confirms on the web.
--confirm confirms only when nothing waits for a decision; use it only when
the user said to import directly. Connection files are those of
upload_files.py (default ~/.config/sciretriever); no token is accepted on the
command line or printed, and no full local path is printed. Only the batch ID
and the given paths are kept locally (import-pdfs.json in the config
directory); re-running continues the same unconfirmed batch and does not send
a file the batch already holds.
"""
import argparse
import collections as counters
import importlib.util
import json
import os
import sys
import time
import urllib.parse
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "sciretriever_upload_files", Path(__file__).resolve().with_name("upload_files.py")
)
upload = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(upload)

STATE_FILE = "import-pdfs.json"
#: A batch holds at most this many items (INTAKE_LIMITS.records).
MAX_FILES = 50_000
DEFAULT_WAIT = 600


class TooMany(Exception):
    pass


def collect(paths):
    """[(path, relative path or None, file name)] in a stable order; no links."""
    found = []
    for given in paths:
        root = Path(given).expanduser()
        if root.is_symlink():
            continue
        if root.is_file():
            if root.suffix.lower() == ".pdf":
                found.append((str(root.resolve()), None, root.name))
            continue
        if not root.is_dir():
            raise OSError("Not a file or folder")
        root = root.resolve()
        for directory, subdirs, names in os.walk(root, followlinks=False):
            subdirs[:] = sorted(n for n in subdirs if not (Path(directory) / n).is_symlink())
            for name in sorted(names):
                full = Path(directory) / name
                if full.suffix.lower() != ".pdf" or full.is_symlink() or not full.is_file():
                    continue
                found.append((str(full), full.relative_to(root).as_posix(), name))
                if len(found) > MAX_FILES:
                    raise TooMany()
    if len(found) > MAX_FILES:
        raise TooMany()
    return found


def load_state(directory):
    try:
        value = json.loads((Path(directory) / STATE_FILE).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def save_state(directory, batch_id, paths):
    fd = os.open(Path(directory) / STATE_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump({"batch_id": batch_id, "paths": paths}, stream)


def items(client, batch):
    out, cursor = [], None
    while True:
        page = client.call("/api/v1/intake/batches/" + batch + "/items", {"cursor": cursor, "limit": 200})
        out.extend(page["items"])
        cursor = page.get("next_cursor")
        if not cursor:
            return out


def summarize(preview, listed):
    """Each file in exactly one class, by the preview's own counts.

    The preview counts every admitted record once: new (created, of which
    needs_metadata have no recognized bibliography), already in the library
    (matched, restored), possible duplicate, conflict or rejected. The items
    only add which new ones have candidates to pick from.
    """
    files = [i for i in listed if i.get("origin") == "file"]
    records = (preview.get("summary") or {}).get("records") or {}
    count = lambda key: int(records.get(key) or 0)  # noqa: E731
    rejected = [i for i in files if i.get("disposition") == "rejected" or i.get("reason")]
    state = lambda i: ((i.get("recognition") or {}).get("state"))  # noqa: E731
    return {
        "files": len(files),
        "created": count("created"),
        "needs_metadata": count("needs_metadata"),
        "existing": count("matched") + count("restored"),
        "duplicates": count("possible_duplicates"),
        "conflicts": count("conflicts"),
        # Among the new ones: no bibliography chosen yet among candidates.
        "candidates": sum(1 for i in files if state(i) == "candidates" and i.get("needs_decision")
                          and not i.get("possible_duplicates")),
        "rejected_total": count("rejected"),
        "rejected": counters.Counter(i.get("reason") or "rejected" for i in rejected),
        "rejected_names": sorted(i.get("file_name") or "" for i in rejected),
        "decisions": sum(1 for i in files if i.get("needs_decision")),
    }


def run(client, config_dir, paths, *, wait=DEFAULT_WAIT, confirm=False, output=sys.stdout, sleep=time.sleep,
        clock=time.monotonic):
    try:
        found = collect(paths)
    except TooMany:
        print(f"PDF 超过一个批次的上限（{MAX_FILES} 个）；请分成几次导入。没有交任何文件。", file=output)
        return 2
    except OSError:
        print("给定的路径不是可读的文件或文件夹。", file=output)
        return 2
    if not found:
        print("给定的路径下没有 PDF。", file=output)
        return 2
    given = [str(Path(p).expanduser().resolve()) for p in paths]
    state, batch = load_state(config_dir), None
    if state and state.get("paths") == given and isinstance(state.get("batch_id"), str):
        current = client.call("/api/v1/intake/batches/" + state["batch_id"] + "/status", {})["batch"]
        if current["state"] in ("collecting", "awaiting-confirmation"):
            batch = state["batch_id"]
    if batch is None:
        label = Path(given[0]).name[:1024]
        batch = client.call("/api/v1/intake/batches", {
            "format": "file", "source": None, "scope": "PDF files",
            # The folder's name labels the batch when it is plain text.
            "file_name": label if label.strip() and label.isprintable() else None})["batch"]["batch_id"]
        save_state(config_dir, batch, given)
    base = "/api/v1/intake/batches/" + batch
    # The batch's own items say what was already sent: file names, counted.
    sent = counters.Counter(i.get("file_name") for i in items(client, batch) if i.get("origin") == "file")
    delivered, failed = 0, counters.Counter()
    for path, relative, name in found:
        if sent[name]:
            sent[name] -= 1
            continue
        extra = {"X-Sciretriever-File-Name": urllib.parse.quote(name, safe="")}
        if relative:
            extra["X-Sciretriever-Relative-Path"] = urllib.parse.quote(relative, safe="")
        try:
            with open(path, "rb") as stream:
                client.post(base + "/file-items", stream, "application/pdf", os.fstat(stream.fileno()).st_size, extra)
            delivered += 1
        except upload.ConnectionLost:
            raise
        except upload.RequestFailure as error:
            failed[error.code] += 1
        except OSError:
            failed["local-file-unreadable"] += 1
    deadline = clock() + wait
    while True:
        preview = client.call(base + "/preview", {})
        recognition = preview.get("recognition") or {}
        if recognition.get("state") in ("done", "cancelled"):
            break
        if clock() >= deadline:
            print(f"已交 {delivered} 个文件；认篇还在进行（{recognition.get('recognized', 0)}/"
                  f"{recognition.get('total', 0)}）。稍后重跑同一条命令即可继续，已交的文件不会重交。", file=output)
            print(f"批次 {batch}：{client.address}/?view=disc（找文献 → 批次记录）。", file=output)
            return 1
        sleep(2)
    s = summarize(preview, items(client, batch))
    print(f"本次交了 {delivered} 个文件，批次里共 {s['files']} 个。", file=output)
    recognized = s["created"] - s["needs_metadata"]
    print(f"确认后会入库 {s['created']} 篇：认出书目的 {recognized} 篇，书目待补 {s['needs_metadata']} 篇"
          + (f"（其中 {s['candidates']} 篇有候选，可在网页上挑）" if s["candidates"] else "") + "。",
          file=output)
    print(f"已在库 {s['existing']} 篇；可能重复 {s['duplicates']} 个（不决定就不入库）；"
          f"冲突 {s['conflicts']} 个；被拒绝 {s['rejected_total']} 个。", file=output)
    print(f"需要决定：可能是这一篇 {s['candidates']} 个，可能重复 {s['duplicates']} 个。", file=output)
    if s["rejected"]:
        print("被拒绝：" + "，".join(f"{k} {v}" for k, v in sorted(s["rejected"].items())), file=output)
        for name in s["rejected_names"]:
            print("  " + name, file=output)
    if failed:
        print("没交成（重跑可补交）：" + "，".join(f"{k} {v}" for k, v in sorted(failed.items())), file=output)
    page = f"{client.address}/?view=disc（找文献 → 批次记录，批次 {batch}）"
    if confirm and not s["decisions"] and not failed:
        client.call(base + "/confirm", {})
        print("已确认，入库在后台进行。进度与报告见：" + page + "。", file=output)
        return 0
    if confirm:
        print("还有需要决定的条目或没交成的文件，没有确认；请先在网页上处理：" + page + "。", file=output)
        return 1
    print("请在网页上预览、决定并确认：" + page + "。", file=output)
    return 1 if failed else 0


def main(argv=None, output=sys.stdout):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config-dir", type=Path, help="含 address 与私有 curl.conf 的目录")
    parser.add_argument("--wait", type=int, default=DEFAULT_WAIT, help="等认篇结束的秒数，默认 600")
    parser.add_argument("--confirm", action="store_true", help="使用者明确说过直接入库时才用")
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args(argv)
    config_dir = args.config_dir if args.config_dir is not None else Path.home() / ".config" / "sciretriever"
    try:
        client = upload.Client(config_dir)
    except upload.RequestFailure as error:
        print("连接文件不可用（" + error.code + "）；请重新连接。", file=output)
        return 2
    try:
        return run(client, config_dir, args.paths, wait=max(0, args.wait), confirm=args.confirm, output=output)
    except upload.ConnectionLost as error:
        print("连接已失效（" + error.code + "）；请使用新的连接码重新连接。", file=output)
        return 2
    except upload.RequestFailure as error:
        print("批次请求失败：" + error.code + "。重跑会从服务端的当前状态继续。", file=output)
        return 2
    except (KeyError, TypeError, ValueError):
        print("文献库返回了无法识别的结果。", file=output)
        return 2
    except KeyboardInterrupt:
        print("已中断；重跑会接着同一个批次，已交的文件不会重交。", file=output)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
