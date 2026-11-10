#!/usr/bin/env python3
"""Hand an import session the files it still needs from a local folder.

Usage: upload_files.py SESSION_ID FOLDER [FOLDER ...]

Reads the address and request headers from ~/.config/sciretriever (see
connect.md), asks the library which files are still owed, finds each one in the
folders by its relative reference or file name, and uploads it or reports only
its SHA-256. Run it again after an interruption: it starts from the library's
current list, so nothing is sent twice. The token is never printed.
"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser(os.environ.get("SCIRETRIEVER_HOME", "~/.config/sciretriever"))


def settings():
    with open(os.path.join(HOME, "address")) as f:
        address = f.read().strip()
    headers = {}
    with open(os.path.join(HOME, "curl.conf")) as f:
        for line in f:
            line = line.strip()
            if line.startswith("header"):
                name, _, value = line.split("=", 1)[1].strip().strip('"').partition(":")
                headers[name.strip()] = value.strip()
    return address, headers


ADDRESS, HEADERS = settings()
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(path, body, content_type="application/json", length=None):
    headers = dict(HEADERS, **{"Content-Type": content_type})
    if length is not None:
        headers["Content-Length"] = str(length)
    request = urllib.request.Request(ADDRESS + path, data=body, headers=headers, method="POST")
    try:
        with OPENER.open(request) as response:
            return json.load(response)["result"]
    except urllib.error.HTTPError as error:
        try:
            code = json.load(error).get("code")
        except Exception:
            code = None
        raise SystemExit(f"文献库拒绝了请求：{code or error.code}（{path}）")
    except urllib.error.URLError:
        raise SystemExit(f"连不上 {ADDRESS}。文献库在服务器上时，请检查端口映射是否开着。")


def call(path, request):
    return post(path, json.dumps({"protocol_version": 1, "request": request}).encode())


def index(folders):
    by_name, by_path = {}, {}
    for folder in folders:
        root = os.path.abspath(os.path.expanduser(folder))
        for directory, _, names in os.walk(root):
            for name in names:
                full = os.path.join(directory, name)
                by_name.setdefault(name.lower(), []).append(full)
                by_path[os.path.relpath(full, root).replace(os.sep, "/").lower()] = full
    return by_name, by_path


def find(item, by_name, by_path):
    reference = item.get("external_id", "").replace("\\", "/").lower()
    if reference in by_path:
        return by_path[reference]
    for path, full in by_path.items():
        if reference and path.endswith("/" + reference):
            return full
    candidates = by_name.get(item["file_name"].lower(), [])
    if len(candidates) > 1 and item.get("size_bytes"):
        sized = [c for c in candidates if os.path.getsize(c) == item["size_bytes"]]
        candidates = sized or candidates
    return candidates[0] if candidates else None


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    session, folders = sys.argv[1], sys.argv[2:]
    base = f"/api/v1/import/sessions/{session}"
    state = call(base + "/status", {})["session"]["state"]
    if state in ("collecting", "awaiting-confirmation"):
        raise SystemExit("会话还没确认，确认之后才交文件。")
    by_name, by_path = index(folders)
    tried, missing, done = set(), [], 0
    while True:
        progressed, cursor = False, None
        while True:
            page = call(base + "/files", {"cursor": cursor, "limit": 200, "pending": True})
            for item in page["items"]:
                if item["file_id"] in tried:
                    continue
                tried.add(item["file_id"])
                path = find(item, by_name, by_path)
                if not path:
                    missing.append(item["file_name"])
                    continue
                route = f"{base}/files/{item['file_id']}"
                if item["action"] == "hash":
                    result = call(route + "/hash", {"sha256": sha256(path)})
                else:
                    with open(path, "rb") as f:
                        result = post(route + "/bytes", f, "application/pdf", os.path.getsize(path))
                done += 1
                progressed = True
                print(f"{result['file']['status']}\t{item['file_name']}")
            cursor = page.get("next_cursor")
            if not cursor:
                break
        status = call(base + "/status", {})["session"]
        if status["state"] not in ("collecting", "awaiting-confirmation", "importing"):
            break
        if status["metadata_complete"] and not progressed:
            break
        if not progressed:
            time.sleep(2)
    print(f"本次交了 {done} 个文件；会话状态：{status['state']}；还差 {status['pending_files']} 个。")
    if missing:
        print("文件夹里没找到：")
        for name in missing:
            print(f"  {name}")


if __name__ == "__main__":
    main()
