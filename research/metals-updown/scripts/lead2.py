import json, math, statistics as st, random
H={(j['asset'],j['ts']):j for j in json.load(open('hist.json'))}
meta={}
for sid,a in [('12967','XAU'),('12968','XAG')]:
    for l in open(f'closed_{sid}.jsonl'):
        e=json.loads(l); md=e.get('eventMetadata') or {}
        if md.get('priceToBeat'): meta[(a,int(e['slug'].rsplit('-',1)[1]))]=(md['priceToBeat'],md['finalPrice'],float(e['markets'][0].get('volume') or 0))
Phi=lambda z:0.5*(1+math.erf(z/math.sqrt(2)))
FEE=0.07
def run(a,hl,verbose=True):
    C={int(k)//1000:v for k,v in json.load(open(f'hl_{hl}.json')).items()}
    ks=sorted(k for k in meta if k[0]==a and k[1] in C)
    print(f"\n===== {a}  ({len(ks)} windows with HL coverage)")
    # also: what fraction of windows have ANY print in last 5 min
    for tau in [300,180,120,60]:
        trades=[]; seen=0
        for k in ks:
            t0=k[1]; tn=t0+900-tau
            h=sorted(H[k]['hist'],key=lambda r:r['t']) if k in H else []
            x=None
            for r in h:
                if r['t']<=tn: x=r
            if not x or tn-x['t']>60: continue
            tm=x['t']; cstart=(tm//60)*60-60      # last candle fully CLOSED before market print
            if cstart not in C or t0 not in C: continue
            rets=[math.log(C[t][1]/C[t][0]) for t in range(cstart-3600,cstart+1,60) if t in C]
            if len(rets)<30: continue
            sig=st.pstdev(rets); seen+=1
            L=math.log(C[cstart][1]/C[t0][0])         # HL-relative lead (removes HL premium)
            tleft=(t0+900-(cstart+60))/60
            pm=min(max(Phi(L/(sig*math.sqrt(tleft))),0.02),0.98)
            p=x['p']; up=meta[k][1]>=meta[k][0]
            side_up = pm>=p; pmod = pm if side_up else 1-pm; q = p if side_up else 1-p
            if not (0.03<q<0.97): continue
            trades.append((pmod-q,q,up==side_up,pmod, pm, p, up))
        # model calibration on its own
        b=[t for t in trades]
        brier_m=st.mean((t[4]-t[6])**2 for t in b); brier_p=st.mean((t[5]-t[6])**2 for t in b)
        print(f" τ={tau}s n={len(b)} Brier model={brier_m:.4f} market={brier_p:.4f}")
        for thr,minp in [(0.05,0.0),(0.10,0.0),(0.05,0.8),(0.10,0.8),(0.15,0.8)]:
            tt=[t for t in trades if t[0]>=thr and t[3]>=minp]
            if len(tt)<10: continue
            res=[]
            for slip in (0,0.01,0.03):
                ev=[(w/min(q+slip,0.99)-1)-FEE*(1-q-slip) for e,q,w,*_ in tt]; res.append(st.mean(ev))
                if slip==0:
                    random.seed(1); bs=sorted(st.mean(random.choices(ev,k=len(ev))) for _ in range(2000))
            print(f"   edge≥{thr:.2f} pM≥{minp:.1f}: n={len(tt):3d} WR={st.mean(t[2] for t in tt):.3f} q={st.mean(t[1] for t in tt):.3f} pM={st.mean(t[3] for t in tt):.3f}  EV/$ mid {res[0]:+.3f} [{bs[50]:+.3f},{bs[1950]:+.3f}]  +1c {res[1]:+.3f}  +3c {res[2]:+.3f}")
for a,hl in [('XAU','GOLD'),('XAG','SILVER')]: run(a,hl)
