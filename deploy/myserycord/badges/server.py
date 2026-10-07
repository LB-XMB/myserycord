#!/usr/bin/env python3
"""Myserycord badges: custom profile badges on top of the official Fluxer images.

One process, Python stdlib only, behind the Caddy edge:
  /myserycord/badges.json      public: badges and who wears them (also read by the desktop app)
  /myserycord/icons/<file>     public: badge images
  /myserycord/badges.js        public: script injected into the web app to draw the badges
  /admin/myserycord/...        badge admin page and its API, gated on the Fluxer admin session
  anything else                HTML pages proxied from app-proxy or admin (X-Myserycord-Upstream),
                               with a <script> tag added before </head>
"""

import base64
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("MYSERYCORD_DATA", "/data")
ICON_DIR = os.path.join(DATA_DIR, "icons")
STATE_FILE = os.path.join(DATA_DIR, "badges.json")
SECRET = os.environ["FLUXER_ADMIN_SECRET_KEY_BASE"].encode()
DOMAIN = os.environ["FLUXER_DOMAIN"]
ORIGIN = f"https://{DOMAIN}"
API = urllib.parse.urlsplit(os.environ.get("FLUXER_API_ENDPOINT", "http://api:8080"))
UPSTREAMS = {"app": ("app-proxy", 8080), "admin": ("admin", 8080)}
INJECT = {
    "app": b'<script src="/myserycord/badges.js" defer></script>',
    "admin": b'<script src="/admin/myserycord/nav.js" defer></script>',
}
# Admins allowed to manage badges: same right as editing user flags in the official panel.
ALLOWED_ACLS = {"*", "WILDCARD", "user:update:flags", "USER_UPDATE_FLAGS"}
SESSION_MAX_AGE = 7 * 24 * 3600
ICON_MAX = 256 * 1024
ICON_TYPES = {"image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg"}
HOP = {"connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-connection", "host"}

lock = threading.Lock()
auth_cache = {}  # access token -> (expires_at, admin user or None)


def b64url_decode(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"badges": {}, "users": {}}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE_FILE)


def public_state():
    state = load_state()
    badges = {
        bid: {"name": b["name"], "description": b.get("description", ""), "icon_url": f"{ORIGIN}/myserycord/icons/{b['icon']}"}
        for bid, b in state["badges"].items()
    }
    users = {uid: [b for b in u["badges"] if b in badges] for uid, u in state["users"].items()}
    return {"badges": badges, "users": {uid: ids for uid, ids in users.items() if ids}}


def api_get(path, token):
    conn = http.client.HTTPConnection(API.hostname, API.port or 80, timeout=10)
    try:
        conn.request("GET", path, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        res = conn.getresponse()
        body = res.read()
        return res.status, (json.loads(body) if body else None)
    finally:
        conn.close()


def session_token(cookie_header):
    """Same check as fluxer_admin/src/session.rs: data.signature, HMAC-SHA256, url-safe base64."""
    for part in cookie_header.split(";"):
        name, _, value = part.strip().partition("=")
        if name != "admin_session" or "." not in value:
            continue
        data, _, sig = value.rpartition(".")
        expected = hmac.new(SECRET, data.encode(), hashlib.sha256).digest()
        try:
            if not hmac.compare_digest(b64url_decode(sig), expected):
                return None
            session = json.loads(b64url_decode(data))
        except ValueError:
            return None
        if time.time() - session.get("createdAt", 0) > SESSION_MAX_AGE:
            return None
        return session.get("accessToken")
    return None


def current_admin(cookie_header):
    token = session_token(cookie_header or "")
    if not token:
        return None, None
    now = time.time()
    hit = auth_cache.get(token)
    if hit and hit[0] > now:
        return hit[1], token
    status, body = api_get("/admin/users/@me", token)
    admin = body["user"] if status == 200 else None
    if admin and not ALLOWED_ACLS.intersection(admin.get("acls", [])):
        admin = None
    auth_cache[token] = (now + 60, admin)
    return admin, token


def parse_icon(data_url):
    m = re.fullmatch(r"data:([a-z+/]+);base64,([A-Za-z0-9+/=]+)", data_url or "")
    if not m or m.group(1) not in ICON_TYPES:
        raise ValueError("image PNG, WebP, GIF ou SVG attendue")
    raw = base64.b64decode(m.group(2))
    if len(raw) > ICON_MAX:
        raise ValueError("image trop lourde (256 Ko max)")
    ext = ICON_TYPES[m.group(1)]
    magic = {"png": raw.startswith(b"\x89PNG"), "gif": raw.startswith(b"GIF8"),
             "webp": raw[:4] == b"RIFF" and raw[8:12] == b"WEBP", "svg": b"<svg" in raw[:2048]}
    if not magic[ext]:
        raise ValueError("le contenu ne correspond pas au type d'image")
    return raw, ext


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "myserycord-badges"

    def log_message(self, fmt, *args):
        if os.environ.get("MYSERYCORD_DEBUG"):
            super().log_message(fmt, *args)

    def send(self, status, body=b"", ctype="application/json", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def static(self, name, ctype, headers=None):
        with open(os.path.join(HERE, name), "rb") as f:
            self.send(200, f.read(), ctype, {"Cache-Control": "no-cache", **(headers or {})})

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/myserycord/badges.json":
            return self.send(200, public_state(), headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60"})
        if path == "/myserycord/badges.js":
            return self.static("badges.js", "text/javascript")
        if path.startswith("/myserycord/icons/"):
            return self.icon(path.rsplit("/", 1)[1])
        if path == "/admin/myserycord/nav.js":
            return self.static("nav.js", "text/javascript")
        if path.startswith("/admin/myserycord"):
            return self.admin_get(path)
        upstream = self.headers.get("X-Myserycord-Upstream")
        if upstream in UPSTREAMS:
            return self.proxy(upstream)
        self.send(404, {"error": "not found"})

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith("/admin/myserycord/api/"):
            return self.send(404, {"error": "not found"})
        # CSRF: the cookie is SameSite=Lax; also require a same-origin JSON request.
        origin = self.headers.get("Origin")
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json" or (origin and origin != ORIGIN):
            return self.send(403, {"error": "requête refusée"})
        admin, _ = current_admin(self.headers.get("Cookie"))
        if not admin:
            return self.send(401, {"error": "session admin requise"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            with lock:
                state = load_state()
                result = self.mutate(path.rsplit("/", 1)[1], body, state)
                save_state(state)
        except (ValueError, KeyError) as e:
            return self.send(400, {"error": str(e)})
        print(f"admin {admin['id']} ({admin['username']}) {path} {json.dumps({k: v for k, v in body.items() if k != 'icon'})}", flush=True)
        self.send(200, result)

    def mutate(self, action, body, state):
        badges, users = state["badges"], state["users"]
        if action == "create":
            name = str(body["name"]).strip()[:64]
            if not name:
                raise ValueError("nom requis")
            raw, ext = parse_icon(body.get("icon"))
            bid = secrets.token_hex(6)
            os.makedirs(ICON_DIR, exist_ok=True)
            with open(os.path.join(ICON_DIR, f"{bid}.{ext}"), "wb") as f:
                f.write(raw)
            badges[bid] = {"name": name, "description": str(body.get("description", "")).strip()[:200],
                           "icon": f"{bid}.{ext}", "created_at": int(time.time())}
            return {"id": bid}
        if action == "update":
            badge = badges[body["id"]]
            badge["name"] = str(body.get("name", badge["name"])).strip()[:64] or badge["name"]
            badge["description"] = str(body.get("description", badge.get("description", ""))).strip()[:200]
            if body.get("icon"):
                raw, ext = parse_icon(body["icon"])
                old = badge["icon"]
                badge["icon"] = f"{body['id']}-{int(time.time())}.{ext}"
                with open(os.path.join(ICON_DIR, badge["icon"]), "wb") as f:
                    f.write(raw)
                os.remove(os.path.join(ICON_DIR, old))
            return {"ok": True}
        if action == "delete":
            badge = badges.pop(body["id"])
            for u in users.values():
                if body["id"] in u["badges"]:
                    u["badges"].remove(body["id"])
            try:
                os.remove(os.path.join(ICON_DIR, badge["icon"]))
            except FileNotFoundError:
                pass
            return {"ok": True}
        if action == "assign":
            uid = str(body["user_id"])
            if not uid.isdigit() or body["badge_id"] not in badges:
                raise ValueError("utilisateur ou badge invalide")
            u = users.setdefault(uid, {"badges": [], "username": ""})
            u["username"] = str(body.get("username", u["username"]))[:64]
            if body["badge_id"] not in u["badges"]:
                u["badges"].append(body["badge_id"])
            return {"ok": True}
        if action == "unassign":
            u = users.get(str(body["user_id"]))
            if u and body["badge_id"] in u["badges"]:
                u["badges"].remove(body["badge_id"])
                if not u["badges"]:
                    users.pop(str(body["user_id"]))
            return {"ok": True}
        raise ValueError("action inconnue")

    def admin_get(self, path):
        admin, token = current_admin(self.headers.get("Cookie"))
        if path in ("/admin/myserycord", "/admin/myserycord/"):
            if not admin:
                return self.send(302, "", headers={"Location": "/admin/login"})
            return self.static("admin.html", "text/html; charset=utf-8", {
                "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
                "Cache-Control": "no-store"})
        if path == "/admin/myserycord/admin.js":
            return self.static("admin.js", "text/javascript")
        if not admin:
            return self.send(401, {"error": "session admin requise"})
        if path == "/admin/myserycord/api/state":
            return self.send(200, {**load_state(), "origin": ORIGIN, "me": admin["username"]}, headers={"Cache-Control": "no-store"})
        if path == "/admin/myserycord/api/users":
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("q", [""])[0].strip()
            if not q:
                return self.send(200, [])
            status, body = api_get("/admin/users?" + urllib.parse.urlencode({"resolve": q}), token)
            found = (body or {}).get("users", []) if status == 200 else []
            if not found and not q.isdigit():
                status, body = api_get("/admin/users?" + urllib.parse.urlencode({"q": q, "limit": 10}), token)
                found = (body or {}).get("users", []) if status == 200 else []
            keys = ("id", "username", "discriminator", "global_name", "avatar")
            return self.send(200, [{k: u.get(k) for k in keys} for u in found])
        self.send(404, {"error": "not found"})

    def icon(self, name):
        if not re.fullmatch(r"[0-9a-f]{12}(-\d+)?\.(png|webp|gif|svg)", name):
            return self.send(404, {"error": "not found"})
        try:
            with open(os.path.join(ICON_DIR, name), "rb") as f:
                raw = f.read()
        except FileNotFoundError:
            return self.send(404, {"error": "not found"})
        ctype = {v: k for k, v in ICON_TYPES.items()}[name.rsplit(".", 1)[1]]
        # Opened directly, an uploaded SVG must not run scripts on this origin.
        self.send(200, raw, ctype, {"Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*",
                                    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})

    def proxy(self, upstream):
        host, port = UPSTREAMS[upstream]
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP and k.lower() != "x-myserycord-upstream"}
        headers["Host"] = self.headers.get("Host", DOMAIN)
        headers["Accept-Encoding"] = "identity"
        conn = http.client.HTTPConnection(host, port, timeout=30)
        try:
            conn.request(self.command, self.path, headers=headers)
            res = conn.getresponse()
            body = res.read()
        except OSError:
            return self.send(502, "upstream indisponible", "text/plain")
        finally:
            conn.close()
        ctype = res.getheader("Content-Type", "")
        if res.status == 200 and ctype.startswith("text/html") and b"</head>" in body:
            body = body.replace(b"</head>", INJECT[upstream] + b"</head>", 1)
        self.send_response(res.status)
        for k, v in res.getheaders():
            if k.lower() not in HOP and k.lower() != "content-length":
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


if __name__ == "__main__":
    os.makedirs(ICON_DIR, exist_ok=True)
    print(f"myserycord-badges on :8080 for {ORIGIN}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
