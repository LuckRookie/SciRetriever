#!/usr/bin/env python3
"""Import one Zotero library into SciRetriever through an intake batch.

Usage:
  zotero_import.py [--config-dir DIR] [--zotero URL] probe [--library LIB]
  zotero_import.py [--config-dir DIR] [--zotero URL] libraries [--library LIB]
  zotero_import.py [--config-dir DIR] [--zotero URL] import --library LIB
                   [--collection KEY ...] [--data-dir DIR]
  zotero_import.py [--config-dir DIR] [--zotero URL] files [--data-dir DIR]

LIB is `user` (the personal library) or `group:<ID>`. Zotero is only read,
never written. The library address and device credential come from the
connection files in --config-dir (default ~/.config/sciretriever), exactly as
for upload_files.py; no token is accepted on the command line or printed.
`import` sends the data and the standalone PDFs, starts the preview and stops:
the user confirms on the web. `files` then uploads the PDFs the library still
lists as pending. Only the batch ID, the library and the data folder are kept
locally (zotero-import.json in the config directory); re-running continues
from the library's pending list.
"""
import argparse
import collections as counters
import importlib.util
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "sciretriever_upload_files", Path(__file__).resolve().with_name("upload_files.py")
)
upload = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(upload)

DEFAULT_ZOTERO = "http://localhost:23119"
STATE_FILE = "zotero-import.json"
#: JSON bytes of one data segment; the library accepts 8 MiB with its envelope.
SEGMENT_BYTES = 6 * 1024 * 1024
KEY = re.compile(r"[A-Z0-9]{8}")
ENABLE_HINT = ("请在 Zotero 里打开本地接口：设置 → 高级 → 勾选“允许此计算机上的其他应用程序与 Zotero 通讯”，"
               "然后重新运行。本程序不会改动 Zotero 的设置，也不会尝试别的地址。")


class ZoteroUnavailable(Exception):
    def __init__(self, code, status=None):
        super().__init__(code)
        self.code, self.status = code, status


class _KeepRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Report a redirect instead of following it.


class ZoteroLocal:
    """Every path, header and paging rule used on Zotero's local API.

    Written from Zotero's public local API documentation (the Web API v3 under
    /api, the personal library as /users/0); to be confirmed by `probe`.
    """
    HEADERS = {"Zotero-API-Version": "3", "Zotero-Allowed-Request": "1"}
    PAGE = 100

    def __init__(self, address=DEFAULT_ZOTERO, timeout=30):
        parsed = urllib.parse.urlsplit(address.rstrip("/"))
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path or parsed.query or parsed.fragment):
            raise ZoteroUnavailable("zotero-address-invalid")
        self.base = address.rstrip("/") + "/api"
        self.timeout = timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _KeepRedirect())

    @staticmethod
    def library_path(library):
        return "/users/0" if library == "user" else "/groups/" + library.split(":", 1)[1]

    def request(self, path, query=None):
        """GET without following redirects: (status, headers, response or None)."""
        url = self.base + path + ("?" + urllib.parse.urlencode(query) if query else "")
        try:
            response = self.opener.open(urllib.request.Request(url, headers=self.HEADERS), timeout=self.timeout)
            return response.status, response.headers, response
        except urllib.error.HTTPError as error:
            headers, status = error.headers, error.code
            error.close()
            return status, headers, None
        except (urllib.error.URLError, socket.timeout, OSError):
            raise ZoteroUnavailable("zotero-unreachable") from None

    def json(self, path, query=None):
        status, headers, response = self.request(path, query)
        if status != 200 or response is None:
            raise ZoteroUnavailable("zotero-http-" + str(status), status)
        with response:
            try:
                return json.loads(response.read()), headers
            except ValueError:
                raise ZoteroUnavailable("zotero-response-invalid") from None

    def check(self):
        status, _, response = self.request("/users/0/items", {"limit": 1})
        if response is not None:
            response.close()
        if status != 200:
            raise ZoteroUnavailable("zotero-local-api-disabled", status)

    def pages(self, path, query=None):
        start = 0
        while True:
            values, headers = self.json(path, {**(query or {}), "start": start, "limit": self.PAGE})
            if not isinstance(values, list):
                raise ZoteroUnavailable("zotero-response-invalid")
            yield from values
            start += len(values)
            total = headers.get("Total-Results")
            if len(values) < self.PAGE or (total and total.isdigit() and start >= int(total)):
                return

    def items(self, library):
        path = self.library_path(library) + "/items"
        try:
            return list(self.pages(path, {"include": "data,csljson"}))
        except ZoteroUnavailable as error:
            # Without csljson the adapter maps the Zotero fields (6.4.9).
            if error.status != 400:
                raise
            return list(self.pages(path))

    def collections(self, library):
        return list(self.pages(self.library_path(library) + "/collections"))

    def groups(self):
        return list(self.pages("/users/0/groups"))

    def total(self, path):
        _, headers = self.json(path, {"limit": 1})
        value = headers.get("Total-Results")
        return int(value) if value and value.isdigit() else None

    def file(self, library, key, directory):
        """The attachment's bytes as a local path, or None when the API gives none.

        A redirect to file:// names the stored file on this computer; a 200
        response is the file itself, kept in `directory` until the upload ends.
        """
        status, headers, response = self.request(self.library_path(library) + "/items/" + key + "/file")
        if response is not None and status == 200:
            target = Path(directory) / key
            with response, open(target, "wb") as stream:
                shutil.copyfileobj(response, stream, 1 << 20)
            return str(target)
        if response is not None:
            response.close()
        location = headers.get("Location") if headers else None
        if status in (301, 302, 303, 307, 308) and location:
            parsed = urllib.parse.urlsplit(location)
            if parsed.scheme == "file":
                path = urllib.request.url2pathname(parsed.path)
                # Only a plain .pdf file; anything else is no file from the API.
                if (path.lower().endswith(".pdf") and os.path.isfile(path)
                        and not os.path.islink(path)):
                    return path
        return None


def library_name(zotero, library):
    if library == "user":
        return "我的文库"
    wanted = library.split(":", 1)[1]
    for group in zotero.groups():
        if str(group.get("id")) == wanted:
            data = group.get("data") if isinstance(group.get("data"), dict) else {}
            return str(data.get("name") or "群组 " + wanted)
    raise ZoteroUnavailable("zotero-library-missing")


def library_argument(value):
    if value == "user" or re.fullmatch(r"group:[0-9]{1,12}", value or ""):
        return value
    raise argparse.ArgumentTypeError("library must be `user` or `group:<ID>`")


# --- Local record ---------------------------------------------------------

def load_state(directory):
    try:
        value = json.loads((Path(directory) / STATE_FILE).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def save_state(directory, batch_id, library, data_dir):
    path = Path(directory) / STATE_FILE
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump({"batch_id": batch_id, "library": library, "data_dir": str(data_dir)}, stream)


# --- Selection and segments ------------------------------------------------

def _data(item):
    return item.get("data") if isinstance(item, dict) and isinstance(item.get("data"), dict) else {}


def _key(item):
    key = item.get("key") if isinstance(item, dict) else None
    return key if isinstance(key, str) else _data(item).get("key")


def select(items, collections, chosen):
    """The items to send and the collections to send with them (6.4.9).

    With chosen collections: the top-level items in them or their
    subcollections, with all descendants; the collections sent are only those
    and their ancestors. Memberships in other collections are left out by the
    library.
    """
    by_key = {_key(c): c for c in collections}
    parent_of = {k: _data(c).get("parentCollection") or None for k, c in by_key.items()}
    if not chosen:
        return list(items), list(collections)
    missing = [k for k in chosen if k not in by_key]
    if missing:
        raise ValueError("collection-missing")
    scope = set(chosen)
    grew = True
    while grew:
        grew = False
        for key, parent in parent_of.items():
            if parent in scope and key not in scope:
                scope.add(key)
                grew = True
    kept = {_key(i) for i in items
            if not _data(i).get("parentItem") and scope & set(_data(i).get("collections") or [])}
    grew = True
    while grew:
        grew = False
        for item in items:
            if _data(item).get("parentItem") in kept and _key(item) not in kept:
                kept.add(_key(item))
                grew = True
    sent = [i for i in items if _key(i) in kept]
    needed = set(scope)
    for key in list(needed):
        parent = parent_of.get(key)
        while parent and parent in by_key and parent not in needed:
            needed.add(parent)
            parent = parent_of.get(parent)
    return sent, [c for c in collections if _key(c) in needed]


def _size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()) + 1


def segments(items, collections):
    """Data segments: collections first, then each parent with all its children.

    Children are followed up the `parentItem` chain, so an annotation (whose
    parent is the attachment it is on) travels with the attachment's parent
    item, as the library needs to put it under the preferred PDF (6.4.13).
    """
    parents = {_key(i): _data(i).get("parentItem") for i in items}

    def root(key):
        seen = set()
        while parents.get(key) and parents[key] in parents and key not in seen:
            seen.add(key)
            key = parents[key]
        return key

    units = {}
    for item in items:
        units.setdefault(root(_key(item)), []).append(item)
    out, skipped = [], 0

    def pack(field, groups):
        nonlocal skipped
        current, size = [], 0
        for group in groups:
            weight = sum(_size(v) for v in group)
            if weight > SEGMENT_BYTES:
                skipped += 1
                continue
            if current and size + weight > SEGMENT_BYTES:
                out.append({field: current})
                current, size = [], 0
            current.extend(group)
            size += weight
        if current:
            out.append({field: current})

    pack("collections", [[c] for c in sorted(collections, key=lambda c: str(_key(c)))])
    pack("items", [sorted(units[k], key=lambda i: (i is not units[k][0], str(_key(i))))
                   for k in sorted(units, key=str)])
    return out, skipped


#: Why an annotation was not imported, as the library reports it (6.4.13).
ANNOTATION_REASONS = {
    "unsupported-kind": "便签、文字框或手绘",
    "annotation-other-file": "在其他附件上",
    "pdf-differs": "PDF 与库里的不同",
    "file-missing": "文件没交来",
    "position-invalid": "位置换算不了",
    "comment-too-long": "评论超过 20,000 字",
    "quote-invalid": "原文缺失或太长",
    "already-imported": "以前导入过",
}


def annotation_line(summary, estimated):
    """One line on the batch's annotations, or None when the batch has no counts."""
    counts = summary.get("annotations") if isinstance(summary, dict) else None
    if not isinstance(counts, dict) or not isinstance(counts.get("by_reason"), dict):
        return None
    reasons = [f"{ANNOTATION_REASONS.get(k, k)} {v}" for k, v in sorted(counts["by_reason"].items())
               if isinstance(v, int) and v > 0]
    head = (f"批注：PDF 交来并与库里的主 PDF 相同时可导入 {counts.get('importable', 0)} 条"
            if estimated else
            f"批注：已导入 {counts.get('imported', 0)} 条，还在等文件的 {counts.get('deferred', 0)} 条")
    return head + ("；不导入：" + "，".join(reasons) if reasons else "") + "。"


def standalone_pdfs(items):
    return sorted(
        (i for i in items
         if _data(i).get("itemType") == "attachment" and not _data(i).get("parentItem")
         and not _data(i).get("deleted")
         and str(_data(i).get("contentType", "")).lower() == "application/pdf"
         and _data(i).get("linkMode") in ("imported_file", "imported_url")
         and isinstance(_data(i).get("filename"), str) and _data(i)["filename"]),
        key=lambda i: _key(i))


# --- Finding a file ---------------------------------------------------------

def from_storage(data_dir, key, name):
    """storage/<key>/: its only PDF, else the one named like the attachment."""
    folder = Path(data_dir) / "storage" / key
    if not folder.is_dir() or folder.is_symlink():
        return None, "storage-folder-missing"
    pdfs = [p for p in folder.iterdir()
            if p.is_file() and not p.is_symlink() and p.suffix.lower() == ".pdf"]
    if len(pdfs) == 1:
        return str(pdfs[0]), None
    if not pdfs:
        return None, "storage-no-pdf"
    named = [p for p in pdfs if p.name == name]
    return (str(named[0]), None) if len(named) == 1 else (None, "storage-ambiguous")


class Finder:
    """6.4.9 "文件": the API's file first, then the data folder; never a guess."""

    def __init__(self, zotero, library, data_dir):
        self.zotero, self.library, self.data_dir = zotero, library, data_dir
        self.temporary = tempfile.mkdtemp(prefix="sciretriever-zotero-")
        os.chmod(self.temporary, 0o700)
        self.reasons = counters.Counter()

    def __call__(self, item):
        path, reason = self.find(item.get("external_id", ""), item.get("file_name", ""))
        size = item.get("size_bytes")
        if path and size is not None and os.path.getsize(path) != size:
            path, reason = None, "size-mismatch"
        if reason:
            self.reasons[reason] += 1
        return path, reason

    def find(self, key, name):
        if not KEY.fullmatch(key or ""):
            return None, "file-reference-not-zotero"
        if self.zotero is not None:
            try:
                path = self.zotero.file(self.library, key, self.temporary)
                if path:
                    return path, None
            except ZoteroUnavailable:
                self.zotero = None
        return from_storage(self.data_dir, key, name)

    def close(self):
        shutil.rmtree(self.temporary, ignore_errors=True)


def default_data_dir():
    return Path.home() / "Zotero"


# --- Commands -----------------------------------------------------------------

def libraries(zotero, library, output):
    if library:
        collections = zotero.collections(library)
        names = {_key(c): _data(c).get("name") for c in collections}
        parent = {_key(c): _data(c).get("parentCollection") or None for c in collections}

        def path(key):
            parts, seen = [], set()
            while key and key in names and key not in seen:
                seen.add(key)
                parts.append(str(names[key]))
                key = parent[key]
            return " / ".join(reversed(parts))

        for key in sorted(names, key=path):
            print(f"{key}\t{path(key)}", file=output)
        return 0
    rows = [("user", "我的文库", zotero.total("/users/0/items/top"))]
    for group in zotero.groups():
        data = group.get("data") if isinstance(group.get("data"), dict) else {}
        key = "group:" + str(group.get("id"))
        rows.append((key, str(data.get("name") or key),
                     zotero.total("/groups/" + str(group.get("id")) + "/items/top")))
    for key, name, total in rows:
        print(f"{key}\t{name}\t{'?' if total is None else total} 条", file=output)
    return 0


def _post_file(client, batch, item, path):
    name = _data(item)["filename"]
    with open(path, "rb") as stream:
        return client.post(
            "/api/v1/intake/batches/" + batch + "/file-items", stream, "application/pdf",
            os.fstat(stream.fileno()).st_size,
            {"X-Sciretriever-File-Name": urllib.parse.quote(name, safe=""),
             "X-Sciretriever-Relative-Path": urllib.parse.quote(
                 "storage/" + _key(item) + "/" + name, safe="")})


def import_library(client, zotero, config_dir, library, chosen, data_dir, output):
    name = library_name(zotero, library)
    items, collections = zotero.items(library), zotero.collections(library)
    try:
        items, collections = select(items, collections, chosen)
    except ValueError:
        print("没有这个分类编号；请先用 libraries --library 列出分类。", file=output)
        return 2
    parts, skipped = segments(items, collections)
    state = load_state(config_dir)
    batch = None
    if state and state.get("library") == library and isinstance(state.get("batch_id"), str):
        current = client.call("/api/v1/intake/batches/" + state["batch_id"] + "/status", {})["batch"]
        if current["state"] in ("collecting", "awaiting-confirmation"):
            batch = state["batch_id"]
        elif current["state"] == "running":
            print("上次的批次已经确认，还有文件待交；请运行 files。", file=output)
            return 1
    if batch is None:
        source = ({"system": "zotero", "library_id": "users/local", "identity": "local", "name": name}
                  if library == "user" else
                  {"system": "zotero", "library_id": "groups/" + library.split(":", 1)[1],
                   "identity": "global", "name": name})
        try:
            batch = client.call("/api/v1/intake/batches", {
                "format": "zotero-api", "source": source, "scope": "Zotero " + name,
                "import_user_tags": True})["batch"]["batch_id"]
        except upload.RequestFailure as error:
            if error.code == "intake-source-busy":
                print("这个库已有一个未结束的批次；请在网页上确认或取消它后再运行。", file=output)
                return 1
            raise
    save_state(config_dir, batch, library, data_dir)
    base = "/api/v1/intake/batches/" + batch
    for sequence, part in enumerate(parts):
        try:
            client.call(base + "/data", {"sequence": sequence, "data": part})
        except upload.RequestFailure as error:
            if error.code == "intake-data-conflict":
                print("Zotero 里的数据与上次交的不同；请在网页上取消这个批次后重新运行。", file=output)
                return 1
            raise
    # Standalone PDFs go in before the preview; one already sent is not resent.
    sent = counters.Counter()
    cursor = None
    while True:
        page = client.call(base + "/items", {"cursor": cursor, "limit": 200})
        sent.update(i.get("file_name") for i in page["items"] if i.get("origin") == "file")
        cursor = page.get("next_cursor")
        if not cursor:
            break
    finder = Finder(zotero, library, data_dir)
    delivered, missing = 0, counters.Counter()
    try:
        for item in standalone_pdfs(items):
            name = _data(item)["filename"]
            if sent[name]:
                sent[name] -= 1
                continue
            path, reason = finder.find(_key(item), name)
            if reason:
                missing[reason] += 1
                continue
            try:
                _post_file(client, batch, item, path)
                delivered += 1
            except upload.ConnectionLost:
                raise
            except upload.RequestFailure as error:
                missing[error.code] += 1
    finally:
        finder.close()
    preview = client.call(base + "/preview", {})
    records = preview.get("summary", {}).get("records", {})
    print(f"已交给文献库：{len(items)} 个 Zotero 对象，{len(collections)} 个分类，{len(parts)} 段；"
          f"独立 PDF 交了 {delivered} 个。", file=output)
    if skipped:
        print(f"有 {skipped} 个条目连同子条目超过一段的上限，没有交。", file=output)
    if missing:
        print("独立 PDF 没交成（按原因）：" + "，".join(f"{k} {v}" for k, v in sorted(missing.items())), file=output)
    print("预览（估计）：新增 {} 篇，已在库 {} 篇，未接纳 {} 条；认篇在后台继续。".format(
        records.get("created", 0), records.get("matched", 0) + records.get("restored", 0),
        records.get("rejected", 0)), file=output)
    line = annotation_line(preview.get("summary"), True)
    if line:
        print(line, file=output)
    print(f"请在网页上预览并确认：{client.address}/?view=disc（找文献 → 批次记录，批次 {batch}）。", file=output)
    print("确认之后运行：zotero_import.py files", file=output)
    return 0


def files(client, zotero, config_dir, data_dir, output):
    state = load_state(config_dir)
    if not state or not isinstance(state.get("batch_id"), str) or not state.get("library"):
        print("没有找到上次的导入记录；请先运行 import。", file=output)
        return 2
    data_dir = data_dir or Path(state.get("data_dir") or default_data_dir())
    save_state(config_dir, state["batch_id"], state["library"], data_dir)
    finder = Finder(zotero, state["library"], data_dir)
    failures = {}
    try:
        result = upload.run(client, state["batch_id"], [], output=output, locate=finder, failures=failures)
    finally:
        finder.close()
    if failures:
        reasons = counters.Counter(reason for _, reason in failures.values())
        print("未交（按原因）：" + "，".join(f"{k} {v}" for k, v in sorted(reasons.items())), file=output)
    # Annotations are imported by the library as each PDF settles.
    if result == 130:
        return result
    try:
        report = client.call("/api/v1/intake/batches/" + state["batch_id"] + "/report", {"limit": 1})
        line = annotation_line(report.get("summary"), False)
        if line:
            print(line, file=output)
    except upload.ConnectionLost:
        raise
    except upload.RequestFailure:
        pass
    return result


# --- Probe ----------------------------------------------------------------------

def _type(value):
    return {bool: "boolean", int: "number", float: "number", str: "string", list: "array",
            dict: "object", type(None): "null"}.get(type(value), "other")


def _shape(value):
    """An ID's form, never the ID: 数字，7 位 / 文字，8 个字符."""
    if isinstance(value, bool) or value is None:
        return _type(value)
    if isinstance(value, int):
        return "数字，" + str(len(str(abs(value)))) + " 位" if value else "数字 0"
    if isinstance(value, str):
        return ("数字文字，" if value.isdigit() else "文字，") + str(len(value)) + " 个字符"
    return _type(value)


def _fields(objects):
    found = {}
    for value in objects:
        if isinstance(value, dict):
            for key, field in value.items():
                found.setdefault(key, set()).add(_type(field))
    return {k: sorted(v) for k, v in sorted(found.items())}


def _check(name, assumption, result, evidence):
    return {"check": name, "assumption": assumption, "result": result, "evidence": evidence}


def probe_library(zotero, library):
    """Structure only: field names, types, counts and enumerations (plan 28 block 14)."""
    base = zotero.library_path(library)
    paths = {}
    for label, path, query in (
            ("items", base + "/items", {"include": "data,csljson", "limit": 1}),
            ("items-top", base + "/items/top", {"limit": 1}),
            ("collections", base + "/collections", {"limit": 1}),
            ("groups", "/users/0/groups", {"limit": 1}),
            ("trash", base + "/items/trash", {"limit": 1})):
        status, headers, response = zotero.request(path, query)
        if response is not None:
            response.close()
        paths[label] = {
            "status": status,
            "total_results": _shape(int(headers["Total-Results"]))
            if headers and (headers.get("Total-Results") or "").isdigit() else None,
            "last_modified_version": _shape(int(headers["Last-Modified-Version"]))
            if headers and (headers.get("Last-Modified-Version") or "").isdigit() else None,
        }
    items = zotero.items(library)
    collections = zotero.collections(library)
    data = [_data(i) for i in items]
    kinds = counters.Counter(str(d.get("itemType")) for d in data)
    attachments = [i for i in items if _data(i).get("itemType") == "attachment"]
    regular = [i for i in items if _data(i).get("itemType") not in ("attachment", "note", "annotation")]
    tag_types = counters.Counter(
        "absent" if "type" not in t else str(t.get("type"))
        for d in data for t in (d.get("tags") or []) if isinstance(t, dict))
    preferred = [((i.get("links") or {}).get("attachment") or {}) for i in items
                 if isinstance((i.get("links") or {}).get("attachment"), dict)]
    enclosures = [((i.get("links") or {}).get("enclosure") or {}) for i in attachments
                  if isinstance((i.get("links") or {}).get("enclosure"), dict)]
    parent = {_key(c): _data(c).get("parentCollection") or None for c in collections}

    def depth(key, seen=()):
        up = parent.get(key)
        return 1 if not up or up not in parent or key in seen else 1 + depth(up, (*seen, key))

    # Paging: two one-item pages must be different items.
    first, _ = zotero.json(base + "/items", {"start": 0, "limit": 1})
    second, _ = zotero.json(base + "/items", {"start": 1, "limit": 1})
    paging = (isinstance(first, list) and isinstance(second, list) and len(first) == 1 and len(second) == 1
              and _key(first[0]) != _key(second[0]))
    # File endpoint: one stored PDF, redirects not followed, Location's scheme only.
    stored = [i for i in attachments if _data(i).get("linkMode") in ("imported_file", "imported_url")
              and str(_data(i).get("contentType", "")).lower() == "application/pdf"]
    file_form = None
    if stored:
        status, headers, response = zotero.request(base + "/items/" + _key(stored[0]) + "/file")
        if response is not None:
            response.close()
        location = headers.get("Location") if headers else None
        file_form = {"status": status, "redirect": 300 <= status < 400,
                     "location_scheme": urllib.parse.urlsplit(location).scheme if location else None,
                     "content_type": headers.get("Content-Type") if headers and status == 200 else None}
    trashed_in_items = sum(1 for d in data if d.get("deleted"))
    trash = []
    if paths["trash"]["status"] == 200:
        trash, _ = zotero.json(base + "/items/trash", {"limit": 25})
    iso = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
    dates = [d.get("dateAdded") for d in data if "dateAdded" in d]
    checks = [
        _check("items-shape", "条目有 key、data（对象）与 links（对象），与网络 API 相同",
               "unknown" if not items else "confirmed" if all(
                   isinstance(i.get("key"), str) and isinstance(i.get("data"), dict)
                   and isinstance(i.get("links"), dict) for i in items) else "differs",
               {"items": len(items)}),
        _check("csljson", "include=data,csljson 给出 csljson（对象）",
               "unknown" if not regular else "confirmed" if all(
                   isinstance(i.get("csljson"), dict) for i in regular) else "differs",
               {"regular_items": len(regular),
                "with_csljson": sum(1 for i in regular if isinstance(i.get("csljson"), dict))}),
        _check("attachment-link", "父条目的 links.attachment.href 以 /items/<8 位编号> 结尾",
               "unknown" if not preferred else "confirmed" if all(
                   re.search(r"/items/[A-Z0-9]{8}$", str(p.get("href", ""))) for p in preferred) else "differs",
               {"with_links_attachment": len(preferred),
                "href_schemes": sorted(counters.Counter(
                    urllib.parse.urlsplit(str(p.get("href", ""))).scheme for p in preferred))}),
        _check("attachment-size", "links.attachment.attachmentSize 或附件的 links.enclosure.length 给出大小",
               "unknown" if not preferred and not enclosures else "confirmed" if all(
                   isinstance(p.get("attachmentSize"), int) for p in preferred) and all(
                   isinstance(e.get("length"), int) for e in enclosures) else "differs",
               {"links_attachment_with_size": sum(1 for p in preferred if isinstance(p.get("attachmentSize"), int)),
                "links_attachment": len(preferred),
                "enclosure_with_length": sum(1 for e in enclosures if isinstance(e.get("length"), int)),
                "enclosures": len(enclosures)}),
        _check("trash-marker", "回收站里的条目带 data.deleted，且 /items 会带上它们",
               "unknown" if not trash and not trashed_in_items else "confirmed" if trashed_in_items and all(
                   _data(t).get("deleted") for t in trash) else "differs",
               {"trash_status": paths["trash"]["status"], "trash_sample": len(trash),
                "trash_sample_with_deleted": sum(1 for t in trash if _data(t).get("deleted")),
                "items_with_deleted": trashed_in_items}),
        _check("date-added-iso", "dateAdded 是 ISO 8601（YYYY-MM-DDThh:mm:ssZ）",
               "unknown" if not dates else "confirmed" if all(
                   isinstance(d, str) and iso.fullmatch(d) for d in dates) else "differs",
               {"with_date_added": len(dates)}),
        _check("local-paths", "本地接口路径 /api/users/0/items、/collections、/groups 与 /api/groups/<编号>/…",
               "confirmed" if all(paths[k]["status"] == 200 for k in ("items", "collections", "groups"))
               else "differs", {k: v["status"] for k, v in paths.items()}),
        _check("paging", "start/limit 分页，响应带 Total-Results",
               "unknown" if len(items) < 2 else "confirmed" if paging and paths["items"]["total_results"]
               else "differs", {"distinct_pages": paging}),
        _check("version", "响应带 Last-Modified-Version",
               "confirmed" if paths["items"]["last_modified_version"] else "differs",
               {"shape": paths["items"]["last_modified_version"]}),
        _check("file-endpoint", "/items/<编号>/file 跳转到 file:// 地址，或直接给出文件",
               "unknown" if file_form is None else "confirmed" if (
                   (file_form["redirect"] and file_form["location_scheme"] == "file")
                   or file_form["status"] == 200) else "differs", file_form),
    ]
    return {
        "probe": "zotero-local-api",
        "library": "user" if library == "user" else "group",
        "requests": paths,
        "items": {
            "count": len(items),
            "item_types": dict(sorted(kinds.items())),
            "fields": _fields(items),
            "data_fields": _fields(data),
            "links_fields": _fields(i.get("links") for i in items),
            "meta_fields": _fields(i.get("meta") for i in items),
            "csljson_fields": _fields(i.get("csljson") for i in items),
            "library_fields": _fields(i.get("library") for i in items),
            "library_types": dict(counters.Counter(
                str((i.get("library") or {}).get("type")) for i in items if isinstance(i.get("library"), dict))),
            "library_id_forms": sorted({_shape((i.get("library") or {}).get("id"))
                                        for i in items if isinstance(i.get("library"), dict)}),
            "version_forms": sorted({_shape(d.get("version")) for d in data}),
            "with_parent": sum(1 for d in data if d.get("parentItem")),
        },
        "attachments": {
            "count": len(attachments),
            "link_modes": dict(sorted(counters.Counter(str(_data(a).get("linkMode")) for a in attachments).items())),
            "content_types": dict(sorted(counters.Counter(
                str(_data(a).get("contentType")) for a in attachments).items())),
            "standalone": sum(1 for a in attachments if not _data(a).get("parentItem")),
            "with_md5": sum(1 for a in attachments if _data(a).get("md5")),
            "links_attachment_fields": _fields(preferred),
            "enclosure_fields": _fields(enclosures),
        },
        "annotations": {
            "count": kinds.get("annotation", 0),
            "types": dict(sorted(counters.Counter(
                str(d.get("annotationType")) for d in data if d.get("itemType") == "annotation").items())),
            "position_fields": _fields(
                json.loads(d["annotationPosition"]) if isinstance(d.get("annotationPosition"), str)
                and d["annotationPosition"].startswith("{") else d.get("annotationPosition")
                for d in data if d.get("itemType") == "annotation"),
        },
        "tags": {"by_type": dict(sorted(tag_types.items()))},
        "collections": {"count": len(collections), "max_depth": max((depth(k) for k in parent), default=0),
                        "fields": _fields(collections), "data_fields": _fields(_data(c) for c in collections)},
        "file_endpoint": file_form,
        "checks": checks,
    }


def main(argv=None, output=sys.stdout):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config-dir", type=Path, help="含 address 与私有 curl.conf 的目录")
    parser.add_argument("--zotero", default=DEFAULT_ZOTERO, help="Zotero 地址，默认 " + DEFAULT_ZOTERO)
    commands = parser.add_subparsers(dest="command", required=True)
    probe = commands.add_parser("probe", help="只读探测本地接口的结构，不输出内容")
    probe.add_argument("--library", type=library_argument, default="user")
    listing = commands.add_parser("libraries", help="列出库；带 --library 时列出它的分类")
    listing.add_argument("--library", type=library_argument)
    importing = commands.add_parser("import", help="交数据与独立 PDF，触发预览后停下")
    importing.add_argument("--library", type=library_argument, required=True)
    importing.add_argument("--collection", action="append", default=[])
    importing.add_argument("--data-dir", type=Path)
    uploading = commands.add_parser("files", help="确认之后上传待交的 PDF")
    uploading.add_argument("--data-dir", type=Path)
    args = parser.parse_args(argv)
    config_dir = args.config_dir if args.config_dir is not None else Path.home() / ".config" / "sciretriever"
    try:
        zotero = ZoteroLocal(args.zotero)
    except ZoteroUnavailable:
        print("Zotero 地址无效。", file=output)
        return 2
    try:
        if args.command in ("probe", "libraries", "import"):
            zotero.check()
    except ZoteroUnavailable as error:
        print(f"连不上 Zotero 的本地接口（{args.zotero}，{error.code}）。" + ENABLE_HINT, file=output)
        return 3
    try:
        if args.command == "probe":
            json.dump(probe_library(zotero, args.library), output, ensure_ascii=False, indent=1)
            print(file=output)
            return 0
        if args.command == "libraries":
            return libraries(zotero, args.library, output)
        try:
            client = upload.Client(config_dir)
        except upload.RequestFailure as error:
            print("连接文件不可用（" + error.code + "）；请重新连接。", file=output)
            return 2
        if args.command == "import":
            return import_library(client, zotero, config_dir, args.library, args.collection,
                                  args.data_dir or default_data_dir(), output)
        try:
            zotero.check()
        except ZoteroUnavailable:
            print("Zotero 本地接口不可用，只在数据文件夹里找文件。", file=output)
            zotero = None
        return files(client, zotero, config_dir, args.data_dir, output)
    except ZoteroUnavailable as error:
        print(f"读取 Zotero 失败（{error.code}）。" + (ENABLE_HINT if error.code == "zotero-unreachable" else ""),
              file=output)
        return 3
    except upload.ConnectionLost as error:
        print("连接已失效（" + error.code + "）；请使用新的连接码重新连接。", file=output)
        return 2
    except upload.RequestFailure as error:
        print("批次请求失败：" + error.code + "。重新运行会从服务端的当前状态继续。", file=output)
        return 2
    except KeyboardInterrupt:
        print("已中断；重新运行会从服务端的当前状态继续。", file=output)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
