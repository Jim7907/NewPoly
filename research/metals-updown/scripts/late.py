import json, collections
T=json.load(open('trades.json'))
res={}; closed={}
for sid,a in [('12967','XAU'),('12968','XAG')]:
    for l in open(f'closed_{sid}.jsonl'):
        e=json.loads(l); m=e['markets'][0]; op=json.loads(m['outcomePrices']); md=e.get('eventMetadata') or {}
        res[m['conditionId']]=(a,int(e['slug'].rsplit('-',1)[1]),1 if op[0]=='1' else 0, md.get('priceToBeat'), md.get('finalPrice'))
FEE=0.07
buck=collections.defaultdict(lambda:[0,0.0,0.0,0.0,0,set()])
for r in T:
    if r['condition_id'] not in res: continue
    a,ts,up,o,f=res[r['condition_id']]; tau=ts+900-r['timestamp']
    if tau>60: continue
    win=1 if (r['outcome_index']==0)==(up==1) else 0
    p,s=r['price'],r['size']; fee=s*FEE*p*(1-p)
    g= s*(win-p) if r['side']=='BUY' else s*(p-win)
    tb = 'after close' if tau<=0 else ('last 0-10s' if tau<=10 else 'last 10-30s' if tau<=30 else 'last 30-60s')
    # "buying the eventual winner" view
    bw = (r['side']=='BUY' and win==1) or (r['side']=='SELL' and win==0)
    k=(a,tb, 'took winner' if bw else 'took loser'); b=buck[k]; b[0]+=1; b[1]+=s*p; b[2]+=g-fee; b[3]+=p; b[5].add(r['condition_id'])
for k in sorted(buck):
    n,no,net,sp,_,ws=buck[k]
    print(f"{k[0]} {k[1]:12s} {k[2]:12s} fills {n:5d} windows {len(ws):4d} notional ${no:8,.0f} avg px {sp/n:.3f} taker net ${net:+7,.0f} ({net/no:+.1%})")
# how close are post-close/last-10s windows? |final-open| in bps
import statistics as st
for a in ['XAU','XAG']:
    mv=[abs(f/o-1)*1e4 for (aa,ts,up,o,f) in res.values() if aa==a and o]
    print(a,'share of windows with |move|<1bp',sum(m<1 for m in mv)/len(mv),' <2bp',sum(m<2 for m in mv)/len(mv), '<3bp', sum(m<3 for m in mv)/len(mv))
