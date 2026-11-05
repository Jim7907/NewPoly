import json, urllib.request, ssl, time, sys
ctx=ssl.create_default_context()
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'research-script/1.0'}),timeout=15,context=ctx))
now=int(time.time()); t0=now//900*900; end=t0+900
toks={}
for a in ['xau','xag','btc']:
    e=get(f'https://gamma-api.polymarket.com/events/slug/{a}-updown-15m-{t0}'); m=e['markets'][0]
    toks[a]=json.loads(m['clobTokenIds'])
print('window',t0,'closes in',end-now,'s')
while time.time()<end+5:
    row=[f"T-{int(end-time.time()):4d}s"]
    for a,(up,dn) in toks.items():
        try:
            b=get(f'https://clob.polymarket.com/book?token_id={up}')
            bids=sorted(((float(l['price']),float(l['size'])) for l in b.get('bids',[])),reverse=True)
            asks=sorted((float(l['price']),float(l['size'])) for l in b.get('asks',[]))
            bb=bids[0] if bids else (0,0); ba=asks[0] if asks else (1,0)
            dA=sum(p*s for p,s in asks if p<=ba[0]+0.03); dB=sum(p*s for p,s in bids if p>=bb[0]-0.03)
            row.append(f"{a.upper()} {bb[0]:.3f}/{ba[0]:.3f} sprd {100*(ba[0]-bb[0]):4.1f}c depth±3c ${dB:6.0f}/${dA:6.0f}")
        except Exception as x: row.append(f"{a} err {x}")
    print(' | '.join(row), flush=True)
    time.sleep(30)
