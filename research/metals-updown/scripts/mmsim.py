import json, math, statistics as st, collections, random
T=json.load(open('trades.json'))
Phi=lambda z:0.5*(1+math.erf(z/math.sqrt(2)))
res={}
for sid,a in [('12967','XAU'),('12968','XAG')]:
    for l in open(f'closed_{sid}.jsonl'):
        e=json.loads(l); m=e['markets'][0]; op=json.loads(m['outcomePrices']); res[m['conditionId']]=(a,int(e['slug'].rsplit('-',1)[1]),1 if op[0]=='1' else 0)
C={'XAU':{int(k)//1000:v for k,v in json.load(open('hl_GOLD.json')).items()},'XAG':{int(k)//1000:v for k,v in json.load(open('hl_SILVER.json')).items()}}
FEE=0.07; REB=0.20
# normalise each taker fill to (window, t, taker_buys_up?, up_price, shares)
F=collections.defaultdict(list)
for r in T:
    if r['condition_id'] not in res: continue
    a,t0,up=res[r['condition_id']]
    if t0 not in C[a]: continue
    isup = r['outcome_index']==0
    buys_up = (r['side']=='BUY')==isup
    xu = r['price'] if isup else 1-r['price']
    F[(a,t0)].append((r['timestamp'],buys_up,xu,r['size']))
def fv(a,t0,t):
    c=C[a]; cs=(t//60)*60-60
    if cs not in c: return None
    rets=[math.log(c[x][1]/c[x][0]) for x in range(cs-3600,cs+1,60) if x in c]
    if len(rets)<30: return None
    sig=st.pstdev(rets); L=math.log(c[cs][1]/c[t0][0]); rem=(t0+900-t)/60+ (t-(cs+60))/60
    return Phi(L/(sig*math.sqrt(max(rem,1e-3)))) if sig>0 else None
def sim(a,h,stop,Q,maxpos,minfv=0.05):
    pnl=[];tot_no=0;fills=0;per_win=[]
    for (aa,t0),fl in F.items():
        if aa!=a: continue
        up=res_by[(a,t0)]; pos=0.0; cash=0.0; reb=0.0
        for t,buys_up,xu,sz in sorted(fl):
            tau=t0+900-t
            if tau<=stop or tau>900: continue
            f=fv(a,t0,t)
            if f is None or f<minfv or f>1-minfv: continue
            bid=math.floor((f-h)*100)/100; ask=math.ceil((f+h)*100)/100
            if buys_up and xu>=ask+0.0099 and pos>-maxpos:      # taker lifted through our ask -> we sell Up
                n=min(sz,Q/ask,maxpos+pos); pos-=n; cash+=n*ask; reb+=REB*n*FEE*ask*(1-ask); tot_no+=n*ask; fills+=1
            elif (not buys_up) and xu<=bid-0.0099 and pos<maxpos and bid>0:   # taker hit through our bid -> we buy Up
                n=min(sz,Q/bid,maxpos-pos); pos+=n; cash-=n*bid; reb+=REB*n*FEE*bid*(1-bid); tot_no+=n*bid; fills+=1
        w = cash + pos*(1 if up else 0) + reb
        if cash or pos: per_win.append(w)
    tot=sum(per_win)
    random.seed(0); bs=sorted(sum(random.choices(per_win,k=len(per_win))) for _ in range(2000)) if per_win else [0]*2000
    return fills,tot_no,tot,len(per_win),bs[50],bs[1950]
res_by={(a,t0):up for (a,t0,up) in res.values()}
days=(1793880900-1793573340)/86400*23/24
print(f"HL-covered period ≈ {days:.1f} trading days. Q=$ per quote, maxpos=shares/window")
for a in ['XAU','XAG']:
    print(f"\n{a}")
    for stop in [60,120]:
        for h in [0.01,0.02,0.03,0.05,0.08]:
            for Q,mp in [(20,60)]:
                fl,no,tot,nw,lo,hi=sim(a,h,stop,Q,mp)
                if fl: print(f"  stop≤{stop:3d}s h=±{h:.2f}: fills {fl:4d} in {nw:3d} windows notional ${no:6,.0f}  P&L ${tot:+6,.0f} ({tot/no:+.1%})  95%CI ${lo:+.0f}..${hi:+.0f}  ≈${tot/days:+.0f}/day")
