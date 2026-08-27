#!/usr/bin/env bash
#
# Generates the filtering root CA — the certificate the proxy uses to inspect HTTPS.
#
# RUN THIS ON THE PROXY SERVER, NOT ON A LAPTOP AND NOT IN A CONTAINER YOU WILL THROW AWAY.
# The private key it produces must never be copied anywhere. Anyone holding it can impersonate any
# website — banks included — to every phone that trusts this CA. It is the single most sensitive
# artefact in the whole system; the filter breaking is an inconvenience, this key leaking is not.
#
# This is a self-signed root. That is not a shortcut: no public certificate authority may issue a
# CA capable of intercepting traffic, so every filter in this market (NetFree, Rimon, Netspark,
# Etrog) ships its own root and has users install it. There is no other way to do this.
#
# Usage:  sudo ./make-ca.sh [output-dir]
set -euo pipefail

OUT_DIR="${1:-/etc/squid/ssl}"
CN="${CA_COMMON_NAME:-Shmira Filter CA}"
ORG="${CA_ORG:-Shmira}"

# Ten years. When this expires EVERY enrolled phone stops working at once and each one needs the new
# certificate installed by hand — there is no remote fix for an expired root. Long life is not
# laziness here, it is the difference between one bad afternoon in 2036 and one every other year.
DAYS="${CA_DAYS:-3650}"

if [[ -e "$OUT_DIR/filter-ca.key" ]]; then
  echo "Refusing to overwrite $OUT_DIR/filter-ca.key" >&2
  echo "A new CA invalidates every phone already enrolled. Move the old one aside deliberately." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

# basicConstraints CA:TRUE and keyCertSign are what make this usable as a signing CA; Android
# rejects a certificate offered as a CA without them. subjectKeyIdentifier is required for the
# chain to validate cleanly on modern Android.
openssl req -x509 -newkey rsa:4096 -sha256 -nodes \
  -days "$DAYS" \
  -keyout "$OUT_DIR/filter-ca.key" \
  -out "$OUT_DIR/filter-ca.crt" \
  -subj "/CN=${CN}/O=${ORG}" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash"

# The key is readable only by the proxy. Squid drops privileges to its own user, so this is the
# account that needs it — nothing else on the box does.
chmod 600 "$OUT_DIR/filter-ca.key"
chmod 644 "$OUT_DIR/filter-ca.crt"
chown -R proxy:proxy "$OUT_DIR" 2>/dev/null || \
  echo "note: user 'proxy' not present yet — re-run chown after installing squid" >&2

# DER form, for Android's certificate installer. PEM works on most Android versions but DER is
# accepted everywhere, so ship this one to phones.
openssl x509 -in "$OUT_DIR/filter-ca.crt" -outform DER -out "$OUT_DIR/filter-ca.der"
chmod 644 "$OUT_DIR/filter-ca.der"

echo
echo "Root CA written to $OUT_DIR"
openssl x509 -in "$OUT_DIR/filter-ca.crt" -noout -subject -dates -fingerprint -sha256
echo
echo "Record that SHA-256 fingerprint in DEPLOYMENT.md — it is how you verify later that a phone"
echo "is trusting YOUR certificate and not something else that got installed."
echo
echo "Next:"
echo "  1. Back up filter-ca.crt (public, safe to copy). Do NOT back up filter-ca.key off this box."
echo "  2. Serve filter-ca.der over HTTPS for phone enrolment."
echo "  3. Initialise squid's certificate cache:"
echo "       /usr/lib/squid/security_file_certgen -c -s /var/spool/squid/ssl_db -M 20MB"
