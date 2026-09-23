#!/usr/bin/env bash
#
# Try something on ONE phone, without moving a rung that other people's phones are on.
#
# WHY THIS EXISTS. Everything in this system is keyed to a RUNG, and a rung is shared. levels.js
# turns (tag, rung) into what the browser may do; policy.js turns it into one Headwind
# configuration. So "put the new companion build on a phone and see whether it survives the night"
# could only be asked of every phone on that rung at once — which, on a fleet of real people's
# handsets, means it never got asked at all.
#
# A device_overrides row (migrations/0022) answers for one device and names only the fields it
# changes. This script is the front door to it, so the loop is three commands rather than a
# hand-written curl with a JSON body nobody remembers the shape of.
#
# THE TWO HALVES, because they behave differently:
#   --policy    the APP half. Names another policy, whose Headwind configuration this phone alone is
#               put on at the scheduler's next run. This is how a new app rule, or a new build of
#               the companion, reaches one handset. The policy must already exist AND carry a
#               headwind_configuration_id — make the configuration in the panel first, then the
#               policy in /admin, or the scheduler reports the device as failed every run.
#   the flags   the WEB half — images, streaming, in-app pictures, the browser mode. The proxy reads
#               them on every request, so they take effect in about a minute with no sync at all.
#
# WHAT IT DOES NOT CHANGE. The phone's rung and tag stay as they are, and so do the shiur windows:
# those are written against `tag:yeshiva`, so a phone under test is still locked for seder. A
# schedule keyed to the phone's ORIGINAL policy stops covering it while --policy is in force, which
# is the one thing to hold in mind if you ever write a per-policy schedule.
#
# ALWAYS CLEAR UP. An override is a test, and a test nobody remembers is just an undocumented
# exception on somebody's phone. `clear` puts it back on its rung, and `status` lists every phone
# currently off its rung — run that when you think you have finished.
#
# Config:
#   OPERATOR_KEY        the admin bearer token. Required.
#   SHMIRA_WORKER_URL   defaults to the production Worker below.
#
# Usage:
#   ./scripts/test-on-phone.sh devices
#   ./scripts/test-on-phone.sh status
#   ./scripts/test-on-phone.sh set dev_1a2b --policy yeshiva_rung_3_test --note "companion 0.1.2"
#   ./scripts/test-on-phone.sh set dev_1a2b --images on --note "why are pictures showing"
#   ./scripts/test-on-phone.sh clear dev_1a2b

set -euo pipefail

WORKER="${SHMIRA_WORKER_URL:-https://phone-url-filter.daniel08-madar.workers.dev}"
KEY="${OPERATOR_KEY:-}"

die() { echo "error: $*" >&2; exit 1; }

usage() { sed -n '2,41p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; }

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$WORKER$path" \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "$WORKER$path" -H "Authorization: Bearer $KEY"
  fi
}

cmd="${1:-}"; shift || true
[[ -n "$cmd" ]] || { usage; exit 1; }
[[ "$cmd" == "help" || "$cmd" == "-h" || "$cmd" == "--help" ]] && { usage; exit 0; }
[[ -n "$KEY" ]] || die "OPERATOR_KEY is not set. export OPERATOR_KEY=... and try again."

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT

case "$cmd" in
  devices)
    api GET /api/admin/state > "$TMP"
    python3 - "$TMP" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
ov = {o["device_id"] for o in (s.get("overrides") or [])}
print("%-18s %-20s %-10s %-5s %s" % ("id", "label", "tag", "rung", "policy"))
for d in s.get("devices", []):
    mark = " *" if d["id"] in ov else ""
    print("%-18s %-20s %-10s %-5s %s%s" % (
        d["id"], str(d.get("label"))[:20], d.get("tag"), d.get("level"), d.get("policy_id"), mark))
if ov:
    print("\n* = has a per-device override in force; see `status`.")
PY
    ;;

  status)
    api GET /api/admin/state > "$TMP"
    python3 - "$TMP" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
labels = {d["id"]: d.get("label") for d in s.get("devices", [])}
rows = s.get("overrides") or []
if not rows:
    print("No phone is currently off its rung. Nothing to clean up.")
    raise SystemExit(0)
print("%d phone(s) under test:\n" % len(rows))
for o in rows:
    dev = o["device_id"]
    print("  %s (%s)" % (dev, labels.get(dev, "?")))
    for k, v in o.items():
        if k in ("device_id", "note", "set_at") or v is None:
            continue
        print("      %s = %s" % (k, v))
    if o.get("note"):
        print("      note: %s" % o["note"])
    print()
print("Clear one with:  ./scripts/test-on-phone.sh clear <device_id>")
PY
    ;;

  set)
    dev="${1:-}"; shift || true
    [[ -n "$dev" ]] || die "usage: set <device_id> [--policy ID] [--images on|off] [--streaming on|off] [--app-media on|off] [--block-social on|off] [--web-mode none|web|blocklist] [--note TEXT]"
    policy=""; images=""; streaming=""; appmedia=""; social=""; webmode=""; note=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --policy)       policy="${2:-}"; shift 2 ;;
        --images)       images="${2:-}"; shift 2 ;;
        --streaming)    streaming="${2:-}"; shift 2 ;;
        --app-media)    appmedia="${2:-}"; shift 2 ;;
        --block-social) social="${2:-}"; shift 2 ;;
        --web-mode)     webmode="${2:-}"; shift 2 ;;
        --note)         note="${2:-}"; shift 2 ;;
        *) die "unknown option: $1" ;;
      esac
    done

    # Assembled by python from the environment so a --note with quotes in it cannot break the JSON.
    body="$(DEV="$dev" POLICY="$policy" IMAGES="$images" STREAMING="$streaming" \
            APPMEDIA="$appmedia" SOCIAL="$social" WEBMODE="$webmode" NOTE="$note" \
            python3 <<'PY'
import json, os, sys
def sw(name):
    v = os.environ.get(name, "").strip().lower()
    if v == "":
        return None
    if v in ("on", "true", "yes", "1"):
        return True
    if v in ("off", "false", "no", "0"):
        return False
    sys.exit("error: --%s must be on or off, not %r" % (name.lower(), v))
body = {"device_id": os.environ["DEV"]}
for key, env in (("images", "IMAGES"), ("streaming", "STREAMING"),
                 ("app_media", "APPMEDIA"), ("block_social", "SOCIAL")):
    v = sw(env)
    if v is not None:
        body[key] = v
for key, env in (("policy_id", "POLICY"), ("web_mode", "WEBMODE"), ("note", "NOTE")):
    v = os.environ.get(env, "").strip()
    if v:
        body[key] = v
if len(body) == 1:
    sys.exit("error: nothing to set. Name at least one field, or use `clear`.")
print(json.dumps(body))
PY
)"

    # The endpoint REPLACES the row, so a field left out stops being overridden. Said out loud,
    # because "images yesterday, streaming today" silently drops the images override otherwise.
    echo "Sending: $body"
    echo "(this replaces the phone's whole override row — fields you do not name stop being overridden)"
    api POST /api/admin/device-overrides "$body" > "$TMP"
    python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), indent=2))' "$TMP"
    echo
    echo "Web flags apply in about a minute. A --policy change waits for the scheduler's next run,"
    echo "then the phone's next Headwind sync (a reboot forces it)."
    ;;

  clear)
    dev="${1:-}"
    [[ -n "$dev" ]] || die "usage: clear <device_id>"
    api POST /api/admin/device-overrides "{\"device_id\":\"$dev\",\"clear\":true}" > "$TMP"
    python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), indent=2))' "$TMP"
    echo
    echo "Back on its rung. A --policy override is undone at the scheduler's next run."
    ;;

  *)
    usage
    exit 1
    ;;
esac
