#!/usr/bin/env python3
"""A tiny, bearer-token HTTPS command endpoint for the MDM/proxy box.

Why this exists: a Claude Code web session runs in a sandbox whose only outbound
transport is an HTTPS proxy that reaches port 443 and nothing else — no ssh, no
odd ports. To let such a session operate the server, we expose a minimal command
endpoint and reach it over a Cloudflare tunnel (see README.md). The agent itself
binds to localhost ONLY; the tunnel is what carries 443 traffic to it, so nothing
new is opened on the public firewall.

Security model, read before trusting this:
  - This is a remote shell on a production box. The bearer token is the only gate.
    Generate it with `openssl rand -hex 32`, keep it out of chat, and delete this
    service when the session that needs it is done (README has the teardown).
  - The token is compared with hmac.compare_digest (constant time).
  - Requests and responses are NOT logged to disk by default (the proxy already
    treats logs as a liability). Set AGENT_LOG=1 to echo a one-line audit to
    stdout/journal while debugging.
  - Bind address is fixed to 127.0.0.1. Do not change it to 0.0.0.0 — the whole
    point is that only the local tunnel can talk to it.

Protocol:
  POST /exec   {"cmd": "<shell string>", "timeout": <seconds, optional>}
               -> {"code": int, "stdout": str, "stderr": str, "timed_out": bool}
  GET  /health -> {"ok": true, "host": "<hostname>"}   (also needs the token)

Config via environment:
  AGENT_TOKEN     required. The bearer token. No default — refuses to start without it.
  AGENT_PORT      default 9000. Localhost port the tunnel forwards to.
  AGENT_TIMEOUT   default 120. Max seconds any one command may run.
  AGENT_LOG       "1" to print a one-line audit per request. Default off.
"""

import hmac
import json
import os
import socket
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("AGENT_TOKEN", "")
PORT = int(os.environ.get("AGENT_PORT", "9000"))
DEFAULT_TIMEOUT = int(os.environ.get("AGENT_TIMEOUT", "120"))
MAX_TIMEOUT = 600
LOG = os.environ.get("AGENT_LOG") == "1"
HOSTNAME = socket.gethostname()

if not TOKEN or len(TOKEN) < 16:
    sys.stderr.write("AGENT_TOKEN missing or too short (need >=16 chars). Refusing to start.\n")
    sys.exit(1)


def audit(line):
    if LOG:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


class Handler(BaseHTTPRequestHandler):
    # Silence the default stderr access log; we do our own optional one-liner.
    def log_message(self, *args):
        return

    def _authed(self):
        header = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix):
            return False
        return hmac.compare_digest(header[len(prefix):], TOKEN)

    def _send(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._authed():
            self._send({"error": "unauthorized"}, 401)
            return
        if self.path.rstrip("/") == "/health":
            self._send({"ok": True, "host": HOSTNAME})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        if not self._authed():
            self._send({"error": "unauthorized"}, 401)
            return
        if self.path.rstrip("/") != "/exec":
            self._send({"error": "not found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            req = json.loads(raw or b"{}")
        except (ValueError, TypeError):
            self._send({"error": "bad json"}, 400)
            return

        cmd = req.get("cmd")
        if not isinstance(cmd, str) or not cmd.strip():
            self._send({"error": "missing cmd"}, 400)
            return
        timeout = req.get("timeout", DEFAULT_TIMEOUT)
        try:
            timeout = max(1, min(MAX_TIMEOUT, int(timeout)))
        except (ValueError, TypeError):
            timeout = DEFAULT_TIMEOUT

        audit("exec: " + cmd.replace("\n", "\\n")[:400])
        timed_out = False
        try:
            proc = subprocess.run(
                ["/bin/bash", "-lc", cmd],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            code, out, err = proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired as e:
            timed_out = True
            code = 124
            out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
            err = e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or "")
        self._send({"code": code, "stdout": out, "stderr": err, "timed_out": timed_out})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    audit("vps-agent listening on 127.0.0.1:%d (host %s)" % (PORT, HOSTNAME))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
