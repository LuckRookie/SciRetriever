#!/usr/bin/env python3
"""Upload the outstanding files of an intake batch without guessing attachments.

Usage: upload_files.py [--config-dir DIRECTORY] BATCH_ID FOLDER [FOLDER ...]
Connection files default to ~/.config/sciretriever. No token is printed or
accepted on the command line. Re-running reads the library's current pending
list; interrupted files restart from byte zero, accepted files are skipped.
"""
import argparse
import hashlib
import http.client
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

MAX_RESPONSE = 8 * 1024 * 1024
MAX_RETRIES = 3
MAX_RETRY_WAIT = 300


class RequestFailure(Exception):
    def __init__(self, code, status=None):
        super().__init__(code)
        self.code, self.status = code, status


class ConnectionLost(RequestFailure):
    """Authentication failed; stop without sending any more requests."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a private device header to another address.
        raise RequestFailure("redirect-refused", code)


def settings(directory):
    try:
        address = (directory / "address").read_text(encoding="utf-8").strip().rstrip("/")
        parsed = urllib.parse.urlsplit(address)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path or parsed.query or parsed.fragment):
            raise ValueError("Invalid address")
        headers = {}
        for line in (directory / "curl.conf").read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == "header":
                value = value.strip().strip('"')
                name, colon, content = value.partition(":")
                if not colon or "\r" in value or "\n" in value:
                    raise ValueError("Invalid header")
                headers[name.strip()] = content.strip()
        if not headers.get("Authorization", "").startswith("Bearer "):
            raise ValueError("Missing device credential")
        headers["X-Sciretriever-Protocol-Version"] = "1"
        return address, headers
    except (OSError, ValueError):
        raise RequestFailure("connection-files-invalid") from None


def retry_delay(value, attempt, now=None):
    if value:
        try:
            if re.fullmatch(r"[0-9]+", value.strip()):
                return float(value)
            instant = parsedate_to_datetime(value)
            if instant.tzinfo is None:
                instant = instant.replace(tzinfo=timezone.utc)
            return max(0, (instant - (now or datetime.now(timezone.utc))).total_seconds())
        except (ValueError, TypeError, OverflowError):
            pass
    return float(2 ** attempt)


class Client:
    def __init__(self, directory, *, sleep=time.sleep):
        self.address, self.headers = settings(Path(directory))
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.sleep = sleep

    def post(self, path, body, content_type="application/json", length=None, extra=None):
        waited = 0
        for attempt in range(MAX_RETRIES + 1):
            if hasattr(body, "seek"):
                body.seek(0)
            headers = {**self.headers, **(extra or {}), "Content-Type": content_type}
            if length is not None:
                headers["Content-Length"] = str(length)
            request = urllib.request.Request(self.address + path, data=body, headers=headers, method="POST")
            try:
                with self.opener.open(request, timeout=70) as response:
                    data = response.read(MAX_RESPONSE + 1)
                if len(data) > MAX_RESPONSE:
                    raise RequestFailure("response-too-large")
                result = json.loads(data)
                if not isinstance(result, dict) or not isinstance(result.get("result"), dict):
                    raise RequestFailure("response-invalid")
                return result["result"]
            except urllib.error.HTTPError as error:
                code = "http-" + str(error.code)
                try:
                    payload = json.loads(error.read(65536))
                    candidate = payload.get("code") if isinstance(payload, dict) else None
                    if isinstance(candidate, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,95}", candidate):
                        code = candidate
                except (ValueError, OSError, http.client.HTTPException):
                    pass
                retry_after = error.headers.get("Retry-After")
                status = error.code
                error.close()
                if status == 401:
                    raise ConnectionLost(code, status) from None
                if status in (408, 429) and attempt < MAX_RETRIES:
                    delay = retry_delay(retry_after, attempt)
                    if delay > MAX_RETRY_WAIT - waited:
                        # Defer rather than retry earlier than the server permits.
                        raise RequestFailure(code + ":retry-deferred", status) from None
                    self.sleep(delay)
                    waited += delay
                    continue
                raise RequestFailure(code, status) from None
            except (urllib.error.URLError, socket.timeout, OSError, http.client.HTTPException):
                # An ambiguous disconnect may follow an accepted write. A new run
                # reads the pending list instead of blindly retrying that write.
                raise RequestFailure("connection-interrupted") from None
            except (ValueError, TypeError):
                raise RequestFailure("response-invalid") from None
        raise RequestFailure("retry-exhausted")

    def call(self, path, request):
        return self.post(path, json.dumps({"protocol_version": 1, "request": request}).encode())


def index(folders):
    by_name, by_path, by_suffix = {}, {}, {}
    for folder in folders:
        root = Path(folder).expanduser().resolve(strict=True)
        if not root.is_dir():
            raise OSError("Not a folder")
        for directory, subdirs, names in os.walk(root, followlinks=False):
            subdirs[:] = [name for name in subdirs if not (Path(directory) / name).is_symlink()]
            for name in names:
                full = Path(directory) / name
                if full.is_symlink() or not full.is_file():
                    continue
                full = str(full.resolve())
                parts = Path(full).relative_to(root).as_posix().casefold().split("/")
                by_name.setdefault(name.casefold(), set()).add(full)
                by_path.setdefault("/".join(parts), set()).add(full)
                for start in range(1, len(parts) - 1):
                    by_suffix.setdefault("/".join(parts[start:]), set()).add(full)
    return by_name, by_path, by_suffix


def find(item, indexed):
    by_name, by_path, by_suffix = indexed
    reference = item.get("external_id", "").replace("\\", "/").casefold()
    parts = reference.split("/")
    relative = (len(parts) > 1 and all(p not in ("", ".", "..") for p in parts)
                and ":" not in parts[0] and not reference.startswith("~"))
    candidates = (by_path.get(reference) or by_suffix.get(reference)) if relative else None
    if candidates:
        if len(candidates) != 1:
            return None, "ambiguous-relative-path"
    else:
        candidates = by_name.get(item["file_name"].casefold(), set())
        if not candidates:
            return None, "file-not-found"
        if len(candidates) != 1:
            return None, "ambiguous-file-name"
        if item.get("size_bytes") is None:
            return None, "file-name-needs-size"
    path = next(iter(candidates))
    size = item.get("size_bytes")
    if size is not None and os.path.getsize(path) != size:
        return None, "size-mismatch"
    return path, None


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(client, batch, folders, *, output=sys.stdout, sleep=time.sleep, locate=None, failures=None):
    """locate(item) -> (path, reason) replaces the folder search; failures, when
    given, collects {file_id: (file_name, reason)} for the caller."""
    base = "/api/v1/intake/batches/" + batch
    failures = {} if failures is None else failures
    tried, successful = set(), 0
    state = "unknown"
    stopped = None
    pending = None
    try:
        if locate is None:
            indexed = index(folders)
            locate = lambda item: find(item, indexed)  # noqa: E731
        while True:
            current = client.call(base + "/status", {})["batch"]
            state = current["state"]
            metadata_running = state == "running" and (current.get("progress") or {}).get("phase") == "metadata"
            if state in ("collecting", "awaiting-confirmation"):
                raise RequestFailure("intake-not-confirmed")
            if state in ("cancelled", "withdrawn"):
                raise RequestFailure("intake-batch-" + state)
            cursor, pending, fresh = None, 0, False
            while True:
                page = client.call(base + "/files", {"cursor": cursor, "limit": 200, "pending": True})
                for item in page["items"]:
                    pending += 1
                    key, name = item["file_id"], item["file_name"]
                    if key in tried:
                        continue
                    tried.add(key)
                    fresh = True
                    reason = None
                    try:
                        if state == "finished":
                            raise RequestFailure("intake-batch-finished")
                        path, reason = locate(item)
                        if reason is None:
                            route = base + "/files/" + urllib.parse.quote(key, safe="")
                            if item.get("expected_sha256") and sha256(path) != item["expected_sha256"]:
                                raise RequestFailure("sha256-mismatch")
                            if item["action"] == "hash":
                                result = client.call(route + "/hash", {"sha256": sha256(path)})
                            elif item["action"] == "upload":
                                with open(path, "rb") as stream:
                                    result = client.post(route + "/bytes", stream, "application/pdf", os.fstat(stream.fileno()).st_size)
                            else:
                                raise RequestFailure("file-action-invalid")
                            settled = result["file"]
                            if settled["status"] in ("uploaded", "existing"):
                                successful += 1
                                pending -= 1
                                print(settled["status"] + "\t" + name, file=output)
                            elif settled["status"] == "conflict":
                                reason = "intake-file-conflict"
                                pending -= 1
                            else:
                                reason = "file-response-invalid"
                    except ConnectionLost:
                        raise
                    except RequestFailure as error:
                        reason = error.code
                    except OSError:
                        reason = "local-file-unreadable"
                    except (KeyError, TypeError, ValueError):
                        reason = "response-invalid"
                    if reason:
                        failures[key] = (name, reason)
                cursor = page.get("next_cursor")
                if not cursor:
                    break
            current = client.call(base + "/status", {})["batch"]
            state = current["state"]
            progress = current.get("progress")
            if state == "running" and progress and progress.get("phase") == "metadata":
                sleep(2)
                continue
            if fresh or metadata_running:
                # Re-read after writes and the final metadata checkpoint. Its
                # file entries may have appeared after this scan; an accepted
                # write whose reply was lost is no longer pending, either.
                continue
            break
    except ConnectionLost as error:
        stopped = error.code
        pending = None
        print("连接已失效（" + error.code + "）；请使用新的连接码重新连接。已立即停止。", file=output)
    except RequestFailure as error:
        stopped = error.code
        print("批次请求失败：" + error.code, file=output)
    except OSError:
        stopped = "local-folder-unreadable"
        print("无法读取指定的文件夹。", file=output)
    except (KeyError, TypeError, ValueError):
        stopped = "response-invalid"
        print("文献库返回了无法识别的结果。", file=output)
    except KeyboardInterrupt:
        stopped = "interrupted"
        print("已中断；重跑时将重新读取服务端缺失清单。", file=output)
    print(f"本次成功 {successful} 个；批次状态：{state}；待交：{pending if pending is not None else '未知'}。", file=output)
    if failures:
        print("失败或跳过的文件（修正后可重跑）：", file=output)
        for key, (name, reason) in failures.items():
            print(f"  {name}\t{key}\t{reason}", file=output)
    if stopped:
        return 130 if stopped == "interrupted" else 2
    return 1 if failures else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-dir", type=Path, help="含 address 与私有 curl.conf 的目录")
    parser.add_argument("batch_id")
    parser.add_argument("folders", nargs="+")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", args.batch_id):
        parser.error("batch_id must be a UUID")
    directory = args.config_dir if args.config_dir is not None else Path.home() / ".config" / "sciretriever"
    try:
        client = Client(directory)
    except RequestFailure as error:
        print("连接文件不可用（" + error.code + "）；请重新连接。", file=sys.stderr)
        return 2
    return run(client, args.batch_id, args.folders)


if __name__ == "__main__":
    raise SystemExit(main())
