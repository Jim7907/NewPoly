import json, collections
T=json.load(open('trades.json')); A=json.load(open('alltrades.json'))
res={}
for sid,a in [('12967','XAU'),('12968','XAG')]:
    for l in open(f'closed_{sid}.jsonl'):
        e=json.loads(l); m=e['markets'][0]; op=json.loads(m['outcomePrices']); res[m['conditionId']]=(a,int(e['slug'].rsplit('-',1)[1]),1 if op[0]=='1' else 0)
# maker rows = rows in A not in T (match on tx hash + wallet + token + size + price)
tk=collections.Counter((r['transaction_hash'],r['proxy_wallet'],r['token_id'],r['size'],r['price'],r['side']) for r in T)
mk=[]
for r in A:
    k=(r['transaction_hash'],r['proxy_wallet'],r['token_id'],r['size'],r['price'],r['side'])
    if tk[k]>0: tk[k]-=1
    else: mk.append(r)
print('maker rows',len(mk))
FEE=0.07
W=collections.defaultdict(lambda:collections.defaultdict(lambda:[0,0.0,0.0]))
for r in mk:
    if r['condition_id'] not in res: continue
    a,ts,up=res[r['condition_id']]; win=1 if (r['outcome_index']==0)==(up==1) else 0
    p,s=r['price'],r['size']; g= s*(win-p) if r['side']=='BUY' else s*(p-win)
    w=W[a][r['proxy_wallet']+'|'+(r['name'] or '')[:18]]; w[0]+=1; w[1]+=s*p; w[2]+=g
for a in W:
    tot=sum(v[1] for v in W[a].values())
    print(f"\n{a}: {len(W[a])} maker wallets, maker notional ${tot:,.0f}")
    for k,v in sorted(W[a].items(),key=lambda kv:-kv[1][1])[:8]:
        print(f"  {k.split('|')[1] or k[:10]:18s} {k[:10]} share {v[1]/tot:5.1%} fills {v[0]:5d} notional ${v[1]:8,.0f} gross P&L ${v[2]:+7,.0f} ({v[2]/v[1]:+.1%})")
# profitable takers' behaviour
print("\nProfitable takers: when/what they trade")
for name in ['ply-pm2','POH-POXUY','0xa697d0b3FFf7D285a0F9']:
    rs=[r for r in T if (r['name'] or '')==name or (r['name'] or '').startswith(name)]
    taus=[res[r['condition_id']][1]+900-r['timestamp'] for r in rs if r['condition_id'] in res]
    ps=[r['price'] for r in rs]; assets=collections.Counter(res[r['condition_id']][0] for r in rs if r['condition_id'] in res)
    sides=collections.Counter(r['side'] for r in rs)
    taus.sort(); ps.sort()
    print(f"  {name}: n={len(rs)} assets {dict(assets)} sides {dict(sides)} tau median {taus[len(taus)//2]}s p10 {taus[len(taus)//10]}s p90 {taus[9*len(taus)//10]}s ; price median {ps[len(ps)//2]:.2f} p10 {ps[len(ps)//10]:.2f} p90 {ps[9*len(ps)//10]:.2f}")
