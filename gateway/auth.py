"""Authentication for ohmypi-gateway.

Two credentials, one secret:

* Bearer token (native desktop/mobile clients, scripts):
    Authorization: Bearer <token>
* Session cookie (the web dashboard): POST /auth/login with the token once,
  get an HttpOnly/SameSite=Strict cookie signed with a key derived from the
  token. Rotating the token invalidates every cookie.

Query-string tokens are deliberately NOT accepted: uvicorn and proxies log
URLs, which leaked the token into the journal in v0.1.0.

Client IP: when the TCP peer is loopback (cloudflared), CF-Connecting-IP is
trusted; otherwise the peer address is used. Cloudflare overwrites that
header at the edge, so remote clients cannot spoof it.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict, deque
from pathlib import Path

COOKIE_NAME = "ompgw_session"
COOKIE_TTL = 30 * 24 * 3600
LOOPBACK = {"127.0.0.1", "::1"}

# Failed-auth lockout: FAIL_LIMIT failures inside FAIL_WINDOW locks the IP out
# for LOCKOUT seconds. The token is 256 bits, so this is noise control and
# log hygiene, not the thing standing between an attacker and the box.
FAIL_LIMIT = 10
FAIL_WINDOW = 15 * 60
LOCKOUT = 15 * 60


class TokenStore:
    def __init__(self, path: Path):
        self.path = path
        self.token = self._load()

    def _load(self) -> str:
        if not self.path.exists():
            self.path.write_text(secrets.token_urlsafe(32) + "\n")
        os.chmod(self.path, 0o600)
        return self.path.read_text().strip()

    def check(self, supplied: str | None) -> bool:
        if not supplied:
            return False
        return hmac.compare_digest(supplied.encode(), self.token.encode())

    # -- cookies -------------------------------------------------------------

    def _key(self) -> bytes:
        return hmac.new(self.token.encode(), b"ompgw-cookie-v1", hashlib.sha256).digest()

    def mint_cookie(self) -> str:
        exp = int(time.time()) + COOKIE_TTL
        nonce = secrets.token_urlsafe(12)
        body = f"{exp}.{nonce}"
        sig = hmac.new(self._key(), body.encode(), hashlib.sha256).hexdigest()
        return f"{body}.{sig}"

    def check_cookie(self, value: str | None) -> bool:
        if not value or value.count(".") != 2:
            return False
        exp_s, nonce, sig = value.split(".")
        want = hmac.new(self._key(), f"{exp_s}.{nonce}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, want):
            return False
        try:
            return int(exp_s) > time.time()
        except ValueError:
            return False


class FailureLimiter:
    def __init__(self):
        self.failures: dict[str, deque] = defaultdict(deque)
        self.locked_until: dict[str, float] = {}

    def locked(self, ip: str) -> float:
        """Seconds of lockout remaining (0 = not locked)."""
        until = self.locked_until.get(ip, 0)
        remaining = until - time.time()
        if remaining <= 0:
            self.locked_until.pop(ip, None)
            return 0
        return remaining

    def fail(self, ip: str) -> None:
        now = time.time()
        q = self.failures[ip]
        q.append(now)
        while q and q[0] < now - FAIL_WINDOW:
            q.popleft()
        if len(q) >= FAIL_LIMIT:
            self.locked_until[ip] = now + LOCKOUT
            q.clear()

    def succeed(self, ip: str) -> None:
        self.failures.pop(ip, None)


def client_ip(headers, peer: str | None) -> str:
    peer = peer or "unknown"
    if peer in LOOPBACK:
        return headers.get("cf-connecting-ip") or peer
    return peer


def forwarded_https(headers, peer: str | None) -> bool:
    return (peer in LOOPBACK) and headers.get("x-forwarded-proto", "") == "https"


def bearer(headers) -> str | None:
    auth = headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return headers.get("x-api-key", "").strip() or None


def origin_allowed(origin: str | None, host: str | None, extra: set[str]) -> bool:
    """CSRF / cross-site WebSocket guard for cookie-authenticated requests."""
    if not origin:
        return False
    if origin in extra:
        return True
    if host:
        return origin in (f"https://{host}", f"http://{host}")
    return False
