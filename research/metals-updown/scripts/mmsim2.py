import json, math, collections, bisect
exec(open('mmsim.py').read().split("def fv(")[0])   # reuse loaders (T,res,C,F)
H={(j['asset'],j['ts']):sorted((x['t'],x['p']) for x in j['hist']) for j in json.load(open('hist.json'))}
res_by={(a,t0):up for (a,t0,up) in res.values()}
def mkt(a,t0,t,lag):
    h=H.get((a,t0)); 
    if not h: return None
    ts=[x[0] for x in h]; i=bisect.bisect_right(ts,t-lag)-1
    return h[i][1] if i>=0 and t-lag-h[i][0]<=90 else None
def sim(a,h,stop,lag,Q=20,maxpos=60, allwin=False):
    per=[];no=0;fl=0
    for (aa,t0),f in F.items():
        if aa!=a: continue
        up=res_by[(a,t0)]; pos=cash=reb=0.0
        for t,buys_up,xu,sz in sorted(f):
            tau=t0+900-t
            if tau<=stop or tau>900: continue
            fv=mkt(a,t0,t,lag)
            if fv is None or not (0.05<fv<0.95): continue
            bid=math.floor((fv-h)*100)/100; ask=math.ceil((fv+h)*100)/100
            if buys_up and xu>=ask+0.0099 and pos>-maxpos:
                n=min(sz,Q/ask,maxpos+pos); pos-=n; cash+=n*ask; reb+=REB*n*FEE*ask*(1-ask); no+=n*ask; fl+=1
            elif (not buys_up) and xu<=bid-0.0099 and pos<maxpos and bid>0:
                n=min(sz,Q/bid,maxpos-pos); pos+=n; cash-=n*bid; reb+=REB*n*FEE*bid*(1-bid); no+=n*bid; fl+=1
        if cash or pos: per.append(cash+pos*(1 if up else 0)+reb)
    return fl,no,sum(per)
print("Control: FV = Polymarket's own last price-history print, lagged by `lag` seconds")
for a in ['XAU','XAG']:
    for lag in [0,30,60]:
        for h in [0.02,0.05]:
            fl,no,p=sim(a,h,60,lag)
            print(f" {a} lag {lag:2d}s h=±{h:.2f}: fills {fl:4d} notional ${no:6,.0f} P&L ${p:+6,.0f} ({p/max(no,1):+.1%})")
