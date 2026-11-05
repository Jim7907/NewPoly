import json, collections, statistics as st
T=json.load(open('trades.json'))
res={}; vol={}
for sid,a in [('12967','XAU'),('12968','XAG')]:
    for l in open(f'closed_{sid}.jsonl'):
        e=json.loads(l); m=e['markets'][0]; op=json.loads(m['outcomePrices'])
        res[m['conditionId']]=(a,int(e['slug'].rsplit('-',1)[1]),1 if op[0]=='1' else 0); vol[m['conditionId']]=float(m.get('volume') or 0)
# coverage check
notional=collections.Counter()
for r in T: notional[r['condition_id']]+=r['size']*r['price']
tv=sum(vol.values()); tn=sum(notional.values()); print(f"coverage: fills notional ${tn:,.0f} vs gamma volume ${tv:,.0f}")
FEE=0.07
def pnl(r):
    a,ts,up=res[r['condition_id']]; win = 1 if (r['outcome_index']==0)==(up==1) else 0
    p,s=r['price'],r['size']; fee=s*FEE*p*(1-p)
    gross = s*(win-p) if r['side']=='BUY' else s*(p-win)
    return gross, fee, a, ts
agg=collections.defaultdict(lambda:[0,0.0,0.0,0.0])  # n, notional, taker gross, fee
for r in T:
    if r['condition_id'] not in res: continue
    g,f,a,ts=pnl(r); tau=ts+900-r['timestamp']
    tb='pre-open' if tau>900 else ('0-60s' if tau<=60 else '60-180s' if tau<=180 else '180-420s' if tau<=420 else '420-900s')
    p=r['price']; pb='<0.15/>0.85' if (p<0.15 or p>0.85) else '0.15-0.85'
    for k in [(a,'ALL','ALL'),(a,tb,'ALL'),(a,'ALL',pb),(a,tb,pb)]:
        s=agg[k]; s[0]+=1; s[1]+=r['size']*p; s[2]+=g; s[3]+=f
print(f"{'asset':5s} {'tau':10s} {'price':12s} {'fills':>6s} {'notional':>9s} {'taker gross':>11s} {'fees':>7s} {'taker net':>9s} {'maker net(+20%reb)':>18s} {'maker net/notional':>8s}")
for k in sorted(agg):
    n,no,g,f=agg[k]
    if n<30: continue
    mk=-g+0.2*f
    print(f"{k[0]:5s} {k[1]:10s} {k[2]:12s} {n:6d} {no:9,.0f} {g:+11,.0f} {f:7,.0f} {g-f:+9,.0f} {mk:+18,.0f} {mk/no:+8.1%}")
# wallets
W=collections.defaultdict(lambda:[0,0.0,0.0,0.0,set(),''])
for r in T:
    if r['condition_id'] not in res: continue
    g,f,a,ts=pnl(r); w=W[r['proxy_wallet']]; w[0]+=1; w[1]+=r['size']*r['price']; w[2]+=g; w[3]+=f; w[4].add(r['condition_id']); w[5]=r['name'] or r['proxy_wallet'][:10]
print("\nTop 15 taker wallets by notional:")
for k,w in sorted(W.items(),key=lambda kv:-kv[1][1])[:15]:
    print(f"  {w[5][:22]:22s} {k[:10]} fills {w[0]:5d} windows {len(w[4]):4d} notional ${w[1]:8,.0f} net ${w[2]-w[3]:+8,.0f} ({(w[2]-w[3])/w[1]:+.1%})")
print("wallets total",len(W), " profitable takers (net>0, ≥20 fills):", sum(1 for w in W.values() if w[0]>=20 and w[2]-w[3]>0), "/", sum(1 for w in W.values() if w[0]>=20))
