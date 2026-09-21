#!/bin/bash
label=$1; port=$2; shift 2
cfg=mem-$label.conf
{ echo "port=$port"; echo "listen-address=127.0.0.1"; echo "bind-interfaces"; echo "no-resolv"; echo "no-hosts"; echo "server=127.0.0.1#5398"; echo "cache-size=10000"; echo "local=/readyprobe.test/"; for f in "$@"; do echo "conf-file=$PWD/$f"; done; } > $cfg
t0=$(date +%s.%N)
dnsmasq -C $cfg -k --pid-file=/tmp/claude-0/mem-$label.pid >/dev/null 2>&1 &
pid=$!
n=0; until timeout 1 python3 dq.py readyprobe.test A $port >/dev/null 2>&1; do sleep 0.05; n=$((n+1)); [ $n -gt 1200 ] && { echo "$label: TIMEOUT"; kill $pid; exit 1; }; done
t1=$(date +%s.%N)
python3 dq.py www.example.com A $port >/dev/null; python3 dq.py adeventtracker.spotify.com A $port >/dev/null
rss=$(grep -E 'VmRSS|VmHWM' /proc/$pid/status | tr -s ' ' | tr '\n' ' ')
echo "$label: entries=$(cat /dev/null "$@" | grep -c '^local=') startup=$(python3 -c "print(round($t1-$t0,2))")s $rss"
kill $pid; wait $pid 2>/dev/null
