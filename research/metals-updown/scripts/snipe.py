import json, math, statistics as st, collections
T=json.load(open('trades.json'))
Phi=lambda z:0.5*(1+math.erf(z/math.sqrt(2)))
res={}
for sid,a in [('12967','XAU'),('12968','XAG')]:
    for l in open(f'closed_{sid}.jsonl'):
        e=json.loads(l); m=e['markets'][0]; op=json.loads(m['outcomePrices']); res[m['conditionId']]=(a,int(e['slug'].rsplit('-',1)[1]),1 if op[0]=='1' else 0)
C={'XAU':{int(k)//1000:v for k,v in json.load(open('hl_GOLD.json')).items()},'XAG':{int(k)//1000:v for k,v in json.load(open('hl_SILVER.json')).items()}}
FEE=0.07; TE=2.1e-4   # HL vs Chainlink 15m tracking error (stdev, fraction)
out=collections.defaultdict(list)
for r in T:
    if r['condition_id'] not in res: continue
    a,t0,up=res[r['condition_id']]; c=C[a]; tend=t0+900; t=r['timestamp']; tau=tend-t
    if tau>60 or t0 not in c: continue
    if tau<=0:
        if tend not in c: continue
        L=math.log(c[tend][0]/c[t0][0]); pU=Phi(L/TE)
    else:
        cs=(t//60)*60-60
        if cs not in c: continue
        rets=[math.log(c[x][1]/c[x][0]) for x in range(cs-3600,cs+1,60) if x in c]
        if len(rets)<30: continue
        sig=st.pstdev(rets); L=math.log(c[cs][1]/c[t0][0]); lag=(t-(cs+60))/60+tau/60   # unseen horizon incl. candle staleness
        pU=Phi(L/math.sqrt(sig**2*lag+TE**2))
    # what the taker acquired
    if r['side']=='BUY': side_up = r['outcome_index']==0; q=r['price']
    else: side_up = r['outcome_index']!=0; q=1-r['price']
    pS = pU if side_up else 1-pU
    win = side_up==(up==1)
    out[(a,'after-close' if tau<=0 else 'last-60s')].append((pS,q,win,r['size']*(r['price'] if r['side']=='BUY' else 1-r['price'])))
for k in sorted(out):
    rows=out[k]
    print(f"\n{k}: {len(rows)} fills")
    for thr in [0.0,0.03,0.05,0.10]:
        sel=[x for x in rows if x[0]-x[1]-FEE*x[1]*(1-x[1])/x[1]*x[1] >= thr and x[1]<0.995]
        if not sel: continue
        no=sum(x[3] for x in sel); pnl=sum(x[3]*((x[2]/x[1])-1) - x[3]*FEE*(1-x[1]) for x in sel)
        print(f"  model edge≥{thr:.2f}: fills {len(sel):4d} notional ${no:7,.0f} WR {st.mean(x[2] for x in sel):.3f} avg q {st.mean(x[1] for x in sel):.3f}  net P&L ${pnl:+7,.0f} ({pnl/no:+.1%})")
