# VPS agent — a temporary HTTPS hands-on-the-server channel

A Claude Code web session runs in a sandbox whose only outbound path is an HTTPS
proxy that reaches **port 443 and nothing else** — no `ssh`, no port 22, no odd
ports. To let such a session operate `mdm.getshmira.com` (Squid + Headwind), we
run a tiny command endpoint on the box and reach it over a **Cloudflare tunnel**,
because a Cloudflare-proxied hostname is the one thing the sandbox can reach on 443.

This is a **remote shell on a production box**. Treat it as temporary: stand it up
for a working session, tear it down after (see the bottom of this file).

Everything below runs in your `ssh root@mdm.getshmira.com` window (Linux), not the
Windows prompt.

---

## 1. Put the agent on the box

Copy `vps-agent.py` to the server (or paste it — it has no domain lines to corrupt).
Suggested path:

```bash
sudo mkdir -p /opt/vps-agent
sudo tee /opt/vps-agent/vps-agent.py >/dev/null   # then paste the file, Ctrl-D
sudo chmod 755 /opt/vps-agent/vps-agent.py
```

## 2. Make a token (do NOT paste it into chat)

```bash
openssl rand -hex 32 | sudo tee /opt/vps-agent/token >/dev/null
sudo chmod 600 /opt/vps-agent/token
```

You will hand this token to the session over a private channel, not in the
transcript. The session sends it as `Authorization: Bearer <token>`.

## 3. Run the agent (localhost only)

As a throwaway foreground process while testing:

```bash
sudo AGENT_TOKEN="$(cat /opt/vps-agent/token)" AGENT_LOG=1 \
     python3 /opt/vps-agent/vps-agent.py
```

Or as a systemd unit so it survives your ssh window closing:

```bash
sudo tee /etc/systemd/system/vps-agent.service >/dev/null <<'UNIT'
[Unit]
Description=Temporary Claude VPS command agent (localhost only)
After=network.target

[Service]
# Token is read from the file so it never appears in `ps` or the unit text.
Environment=AGENT_LOG=1
ExecStart=/usr/bin/env bash -c 'AGENT_TOKEN="$(cat /opt/vps-agent/token)" exec python3 /opt/vps-agent/vps-agent.py'
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now vps-agent
sudo systemctl status vps-agent --no-pager
```

The agent now listens on `127.0.0.1:9000`. It is not reachable from anywhere yet —
that is deliberate. The tunnel in step 4 is the only thing that will reach it.

## 4. Expose it on 443 via a Cloudflare tunnel

`getshmira.com` is already on Cloudflare, so this needs no open inbound port and no
second IP. Install `cloudflared` and log in once:

```bash
# Debian/Ubuntu
curl -fsSL https://pkg.cloudflare.com/cloudflared.gpg \
  | sudo tee /usr/share/keyrings/cloudflare.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

cloudflared tunnel login          # opens a URL; pick the getshmira.com zone
cloudflared tunnel create vps-agent
```

Route a hostname to the tunnel and point it at the local agent:

```bash
cloudflared tunnel route dns vps-agent agent.getshmira.com

sudo tee /etc/cloudflared/config.yml >/dev/null <<'YAML'
tunnel: vps-agent
credentials-file: /root/.cloudflared/vps-agent.json
ingress:
  - hostname: agent.getshmira.com
    service: http://127.0.0.1:9000
  - service: http_status:404
YAML

sudo cloudflared service install
sudo systemctl restart cloudflared
```

`https://agent.getshmira.com/health` is now reachable from the sandbox. Optionally
put a Cloudflare Access policy in front of `agent.getshmira.com` for a second gate;
the bearer token is the primary one.

## 5. Tell the session it's up

Give the session the hostname (`agent.getshmira.com`) and the token privately. It
will verify with:

```
GET https://agent.getshmira.com/health   Authorization: Bearer <token>
-> {"ok": true, "host": "..."}
```

and then run commands with:

```
POST https://agent.getshmira.com/exec
{"cmd": "systemctl is-active squid", "timeout": 30}
-> {"code": 0, "stdout": "active\n", "stderr": "", "timed_out": false}
```

---

## Teardown (do this when the session is finished)

```bash
sudo systemctl disable --now vps-agent cloudflared
sudo rm -f /etc/systemd/system/vps-agent.service /etc/cloudflared/config.yml
sudo rm -rf /opt/vps-agent
cloudflared tunnel delete vps-agent            # and remove the agent.getshmira.com DNS record
sudo systemctl daemon-reload
```

Rotate the token if it was ever exposed. The agent keeps nothing; deleting the
files is a complete removal.
