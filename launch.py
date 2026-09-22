#!/usr/bin/env python3
"""
TCG Forge - local launcher and workspace file server.

Runs entirely offline. No third-party dependencies: Python 3.8+ standard
library only. Serves the web UI on 127.0.0.1 and exposes a small REST API
that lets the browser app read and write real files in the workspace
folder (assets, templates, projects, exports).

Usage:
    python launch.py                     # start and open a browser
    python launch.py --port 7870
    python launch.py --no-browser
    python launch.py --workspace ~/cards # use a different workspace folder
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import posixpath
import re
import shutil
import socket
import stat
import sys
import threading
import time
import webbrowser
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs, unquote

APP_NAME = "TCG Forge"
APP_VERSION = "0.3.0"

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "web")

# Folders that make up a workspace. Created on first run.
ASSET_CATEGORIES = ["frames", "backgrounds", "icons", "art", "textures", "fonts"]
WORKSPACE_DIRS = (
    [os.path.join("assets", c) for c in ASSET_CATEGORIES]
    + ["templates", "projects", "exports", "batch"]
)

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".bmp"}
FONT_EXT = {".ttf", ".otf", ".woff", ".woff2"}
MAX_UPLOAD_BYTES = 64 * 1024 * 1024  # 64 MB per file
MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES * 2  # base64 inflates a 64 MB upload

# Host names a browser may legitimately use to reach a loopback server. Any
# other name means the request arrived through a DNS record someone else
# controls, which is how a remote page gets to talk to a local port.
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("font/otf", ".otf")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/woff2", ".woff2")

WORKSPACE = os.path.join(ROOT, "workspace")


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def ensure_workspace(path: str) -> None:
    for sub in WORKSPACE_DIRS:
        os.makedirs(os.path.join(path, sub), exist_ok=True)


def safe_join(rel: str) -> str:
    """Resolve a workspace-relative path, refusing anything that escapes it."""
    rel = unquote(rel or "").replace("\\", "/").lstrip("/")
    if not rel:
        raise ValueError("empty path")
    if ".." in rel.split("/"):
        raise ValueError("path traversal rejected")
    full = os.path.abspath(os.path.join(WORKSPACE, *rel.split("/")))
    root = os.path.abspath(WORKSPACE)
    if full != root and not full.startswith(root + os.sep):
        raise ValueError("path escapes workspace")
    return full


def rel_path(full: str) -> str:
    return os.path.relpath(full, WORKSPACE).replace(os.sep, "/")


def slugify(value: str, fallback: str = "untitled") -> str:
    """Mirror of the front end's slugify, so ids agree on both sides."""
    out = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return out or fallback


def safe_filename(name: str) -> str:
    name = os.path.basename(name or "").strip()
    name = re.sub(r"[^A-Za-z0-9._ \-()]", "_", name)
    name = name.lstrip(".") or "untitled"
    return name[:120]


def unique_path(directory: str, filename: str) -> str:
    stem, ext = os.path.splitext(filename)
    candidate = os.path.join(directory, filename)
    n = 2
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{stem}-{n}{ext}")
        n += 1
    return candidate


def scan_assets() -> dict:
    """Walk workspace/assets and return every usable file, grouped by category."""
    out = {}
    for category in ASSET_CATEGORIES:
        base = os.path.join(WORKSPACE, "assets", category)
        items = []
        if os.path.isdir(base):
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
                for fn in sorted(filenames):
                    if fn.startswith("."):
                        continue
                    ext = os.path.splitext(fn)[1].lower()
                    allowed = FONT_EXT if category == "fonts" else IMAGE_EXT
                    if ext not in allowed:
                        continue
                    full = os.path.join(dirpath, fn)
                    r = rel_path(full)
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    group = os.path.relpath(dirpath, base).replace(os.sep, "/")
                    items.append({
                        "name": os.path.splitext(fn)[0],
                        "file": fn,
                        "ext": ext.lstrip("."),
                        "path": r,
                        "url": "/files/" + r,
                        "group": "" if group == "." else group,
                        "size": st.st_size,
                        "modified": iso(st.st_mtime),
                    })
        out[category] = items
    return out


def scan_json_dir(subdir: str, expect_format: str | None = None) -> list:
    base = os.path.join(WORKSPACE, subdir)
    results = []
    if not os.path.isdir(base):
        return results
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for fn in sorted(filenames):
            if not fn.lower().endswith(".json") or fn.startswith("."):
                continue
            full = os.path.join(dirpath, fn)
            try:
                st = os.stat(full)
            except OSError:
                continue  # deleted between the walk and the stat
            entry = {
                "path": rel_path(full),
                "file": fn,
                "name": os.path.splitext(fn)[0],
                "id": os.path.splitext(fn)[0],
                "modified": iso(st.st_mtime),
                "size": st.st_size,
            }
            try:
                with open(full, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                if isinstance(data, dict):
                    if expect_format and data.get("format") not in (None, expect_format):
                        continue
                    entry["name"] = data.get("name") or entry["name"]
                    # The browser matches this against project.templateId, which
                    # is a slug — never the display name.
                    entry["id"] = data.get("id") or slugify(entry["name"], entry["id"])
                    entry["description"] = data.get("description", "")
                    entry["author"] = data.get("author", "")
                    entry["tags"] = data.get("tags", [])
                    entry["card"] = data.get("card", {})
                    entry["fieldCount"] = len(data.get("fields", []) or [])
                    entry["thumbnail"] = data.get("thumbnail", "")
            except Exception as exc:  # corrupt file: still list it, flag the error
                entry["error"] = str(exc)
            results.append(entry)
    return results


# --------------------------------------------------------------------------
# request handler
# --------------------------------------------------------------------------

class ForgeHandler(SimpleHTTPRequestHandler):
    server_version = f"TCGForge/{APP_VERSION}"
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    # -- logging -----------------------------------------------------------
    def log_message(self, fmt, *args):
        if self.server.verbose:  # type: ignore[attr-defined]
            sys.stderr.write("  %s\n" % (fmt % args))

    def log_error(self, fmt, *args):
        sys.stderr.write("  ! %s\n" % (fmt % args))

    # -- plumbing ----------------------------------------------------------
    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message, status=400):
        self._send_json({"ok": False, "error": message}, status=status)

    def _read_body(self) -> dict:
        if self.headers.get("Transfer-Encoding"):
            # Chunked bodies are not decoded here, and a body left unread turns
            # the next request on this connection into nonsense.
            self.close_connection = True
            raise ValueError("send a Content-Length, not a chunked body")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_REQUEST_BYTES:
            # The body is refused unread, so the bytes still in flight would be
            # parsed as the next request on a keep-alive connection. Close it.
            self.close_connection = True
            raise ValueError("payload too large")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    # -- access control ----------------------------------------------------
    # Loopback is not a security boundary. Any web page in the browser can post
    # to 127.0.0.1, and a form-style content type needs no preflight, so without
    # these two checks a visited site could rewrite the whole workspace.

    def _host_name(self) -> str:
        host = (self.headers.get("Host") or "").strip()
        if host.startswith("["):                      # [::1]:7870
            return host[1:host.find("]")].lower() if "]" in host else ""
        return host.rsplit(":", 1)[0].lower() if ":" in host else host.lower()

    def _refuse(self):
        # The body of a refused POST is never read, so the socket cannot be
        # trusted to start at a request line again. Answer and hang up.
        self.close_connection = True
        return self._error("forbidden", 403)

    def _request_allowed(self) -> bool:
        allowed = getattr(self.server, "allowed_hosts", None)
        if allowed:
            # A name we do not serve under means the request arrived through
            # someone else's DNS record: that is a rebinding attack.
            if self._host_name() not in allowed:
                return False
        origin = self.headers.get("Origin")
        if origin is None:
            return True                               # curl, CI, plain navigation
        host = (self.headers.get("Host") or "").strip()
        return origin.strip().lower() in (f"http://{host}".lower(),
                                          f"https://{host}".lower())

    def end_headers(self):
        # The app is local-only; these headers just keep dev reloads honest.
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    # -- routing -----------------------------------------------------------
    def do_GET(self):
        if not self._request_allowed():
            return self._refuse()
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path.startswith("/api/"):
                return self.handle_api_get(path[5:], query)
            if path.startswith("/files/"):
                return self.serve_workspace_file(path[len("/files/"):])
            if path == "/":
                self.path = "/index.html"
            return super().do_GET()
        except ValueError as exc:
            return self._error(str(exc), 400)
        except FileNotFoundError:
            return self._error("not found", 404)
        except Exception as exc:  # noqa: BLE001
            return self._error(f"{type(exc).__name__}: {exc}", 500)

    def do_POST(self):
        if not self._request_allowed():
            return self._refuse()
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return self._error("not found", 404)
        try:
            return self.handle_api_post(parsed.path[5:], self._read_body())
        except ValueError as exc:
            return self._error(str(exc), 400)
        except FileNotFoundError:
            return self._error("not found", 404)
        except Exception as exc:  # noqa: BLE001
            return self._error(f"{type(exc).__name__}: {exc}", 500)

    # -- GET endpoints -----------------------------------------------------
    def handle_api_get(self, route, query):
        if route == "status":
            return self._send_json({
                "ok": True,
                "app": APP_NAME,
                "version": APP_VERSION,
                "workspace": os.path.abspath(WORKSPACE),
                "categories": ASSET_CATEGORIES,
                "python": sys.version.split()[0],
                "time": iso(time.time()),
            })

        if route == "assets":
            return self._send_json({"ok": True, "assets": scan_assets()})

        if route == "templates":
            return self._send_json({
                "ok": True,
                "templates": scan_json_dir("templates", "tcgforge.template"),
            })

        if route == "projects":
            return self._send_json({
                "ok": True,
                "projects": scan_json_dir("projects", "tcgforge.project"),
            })

        if route == "read":
            rel = (query.get("path") or [""])[0]
            full = safe_join(rel)
            if not os.path.isfile(full):
                raise FileNotFoundError(rel)
            with open(full, "r", encoding="utf-8") as fh:
                return self._send_json({"ok": True, "path": rel_path(full),
                                        "content": fh.read()})

        if route == "list":
            rel = (query.get("path") or ["."])[0]
            full = WORKSPACE if rel in (".", "") else safe_join(rel)
            if not os.path.isdir(full):
                raise FileNotFoundError(rel)
            entries = []
            for name in sorted(os.listdir(full)):
                if name.startswith("."):
                    continue
                p = os.path.join(full, name)
                try:
                    st = os.stat(p)
                except OSError:
                    continue  # one file vanishing must not fail the listing
                is_dir = stat.S_ISDIR(st.st_mode)
                entries.append({
                    "name": name,
                    "path": rel_path(p),
                    "dir": is_dir,
                    "size": 0 if is_dir else st.st_size,
                    "modified": iso(st.st_mtime),
                })
            return self._send_json({"ok": True, "entries": entries})

        return self._error("unknown endpoint", 404)

    # -- POST endpoints ----------------------------------------------------
    def handle_api_post(self, route, body):
        if route == "write":
            rel = body.get("path") or ""
            content = body.get("content")
            if not isinstance(content, str):
                raise ValueError("content must be a string")
            full = safe_join(rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            if body.get("backup") and os.path.exists(full):
                shutil.copy2(full, full + ".bak")
            tmp = full + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(content)
            os.replace(tmp, full)
            return self._send_json({"ok": True, "path": rel_path(full),
                                    "bytes": len(content.encode("utf-8"))})

        if route == "upload":
            category = body.get("category") or "art"
            if category not in ASSET_CATEGORIES:
                raise ValueError(f"unknown asset category: {category}")
            filename = safe_filename(body.get("filename") or "asset.png")
            data = decode_data_url(body.get("data") or "")
            if len(data) > MAX_UPLOAD_BYTES:
                raise ValueError("file exceeds the 64 MB upload limit")
            target_dir = os.path.join(WORKSPACE, "assets", category)
            subgroup = body.get("group")
            if subgroup:
                target_dir = os.path.join(target_dir, safe_filename(subgroup))
            os.makedirs(target_dir, exist_ok=True)
            dest = unique_path(target_dir, filename)
            with open(dest, "wb") as fh:
                fh.write(data)
            r = rel_path(dest)
            return self._send_json({"ok": True, "path": r, "url": "/files/" + r,
                                    "category": category})

        if route == "export":
            filename = safe_filename(body.get("filename") or "card.png")
            data = decode_data_url(body.get("data") or "")
            target_dir = os.path.join(WORKSPACE, "exports")
            folder = body.get("folder")
            if folder:
                target_dir = os.path.join(target_dir, safe_filename(folder))
            os.makedirs(target_dir, exist_ok=True)
            # Batch runs overwrite deliberately; single exports never clobber.
            dest = (os.path.join(target_dir, filename) if body.get("overwrite")
                    else unique_path(target_dir, filename))
            with open(dest, "wb") as fh:
                fh.write(data)
            r = rel_path(dest)
            return self._send_json({"ok": True, "path": r, "url": "/files/" + r,
                                    "absolute": os.path.abspath(dest)})

        if route == "mkdir":
            full = safe_join(body.get("path") or "")
            os.makedirs(full, exist_ok=True)
            return self._send_json({"ok": True, "path": rel_path(full)})

        if route == "trash":
            # Nothing is ever hard-deleted; files move to workspace/.trash.
            full = safe_join(body.get("path") or "")
            if not os.path.exists(full):
                raise FileNotFoundError(body.get("path"))
            trash = os.path.join(WORKSPACE, ".trash", time.strftime("%Y%m%d"))
            os.makedirs(trash, exist_ok=True)
            dest = unique_path(trash, os.path.basename(full))
            shutil.move(full, dest)
            return self._send_json({"ok": True, "trashed": rel_path(dest)})

        if route == "shutdown":
            threading.Timer(0.4, self.server.shutdown).start()  # type: ignore
            return self._send_json({"ok": True, "message": "server stopping"})

        return self._error("unknown endpoint", 404)

    # -- workspace static files -------------------------------------------
    def serve_workspace_file(self, rel):
        full = safe_join(posixpath.normpath(rel))
        if not os.path.isfile(full):
            raise FileNotFoundError(rel)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        size = os.path.getsize(full)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with open(full, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile)


def decode_data_url(value: str) -> bytes:
    if not value:
        raise ValueError("no data provided")
    if value.startswith("data:"):
        head, _, payload = value.partition(",")
        if ";base64" not in head:
            raise ValueError("only base64 data URLs are supported")
        value = payload
    return base64.b64decode(value)


class ThreadingHTTPServerV6(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    verbose = False
    allowed_hosts = frozenset()


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def find_free_port(host: str, preferred: int, attempts: int = 20) -> int:
    for offset in range(attempts):
        port = preferred + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise SystemExit(f"No free port found in range {preferred}-{preferred + attempts}")


def main(argv=None):
    global WORKSPACE

    parser = argparse.ArgumentParser(description=f"{APP_NAME} launcher")
    parser.add_argument("--port", type=int, default=7870,
                        help="port to listen on (default: 7870)")
    parser.add_argument("--host", default="127.0.0.1",
                        help="interface to bind (default: 127.0.0.1, local only)")
    parser.add_argument("--workspace", default=WORKSPACE,
                        help="workspace folder holding assets/templates/projects")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open a browser window on start")
    parser.add_argument("--verbose", action="store_true", help="log every request")
    args = parser.parse_args(argv)

    WORKSPACE = os.path.abspath(os.path.expanduser(args.workspace))
    ensure_workspace(WORKSPACE)

    if not os.path.isfile(os.path.join(WEB_DIR, "index.html")):
        raise SystemExit(f"web/index.html not found under {WEB_DIR}")

    port = find_free_port(args.host, args.port)
    httpd = ThreadingHTTPServerV6((args.host, port), ForgeHandler)
    httpd.verbose = args.verbose
    # Binding somewhere other than loopback is a deliberate choice to serve the
    # network, so the caller decides which names reach it; the default refuses
    # everything but this machine.
    bound = args.host.strip().lower()
    httpd.allowed_hosts = (frozenset(LOOPBACK_HOSTS | {bound})
                           if bound in LOOPBACK_HOSTS else frozenset())
    url = f"http://{args.host}:{port}/"

    print(f"\n  {APP_NAME} {APP_VERSION}")
    print(f"  workspace : {WORKSPACE}")
    print(f"  running   : {url}")
    print("  offline   : no network access required\n")
    print("  Press Ctrl+C to stop.\n")

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Shutting down.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
