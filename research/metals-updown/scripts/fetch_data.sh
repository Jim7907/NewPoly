#!/usr/bin/env bash
# Pull resolved gold/silver 15m windows (Gamma) + Hyperliquid xyz:GOLD/xyz:SILVER 1m candles.
# Run from an empty data directory; then run fetch_hist.py, calib.py, lead2.py there.
set -euo pipefail
for sid in 12967 12968; do            # 12967 = gold-up-or-down-15m, 12968 = silver-up-or-down-15m
  : > closed_$sid.jsonl; off=0
  while :; do
    curl -sS "https://gamma-api.polymarket.com/events?series_id=$sid&closed=true&limit=100&offset=$off&order=endDate&ascending=true" > page.json
    n=$(python3 -c "
import json;d=json.load(open('page.json'))
with open('closed_$sid.jsonl','a') as f:
  [f.write(json.dumps(e)+'\n') for e in d]
print(len(d))")
    off=$((off+100)); [ "$n" -lt 100 ] && break
  done
done
python3 - <<'PY'
import json, urllib.request, time
start=1792695600*1000; end=int(time.time()*1000)   # HL only serves the most recent ~5000 candles
for coin in ['xyz:GOLD','xyz:SILVER']:
    rows={}; s=start
    while s<end:
        e=min(s+4900*60000,end)
        body=json.dumps({"type":"candleSnapshot","req":{"coin":coin,"interval":"1m","startTime":s,"endTime":e}}).encode()
        d=json.load(urllib.request.urlopen(urllib.request.Request('https://api.hyperliquid.xyz/info',data=body,headers={'content-type':'application/json'}),timeout=30))
        for c in d: rows[c['t']]=(float(c['o']),float(c['c']),float(c['h']),float(c['l']))
        s=e+60000; time.sleep(0.3)
    json.dump(rows,open(f"hl_{coin.split(':')[1]}.json",'w'))
PY
