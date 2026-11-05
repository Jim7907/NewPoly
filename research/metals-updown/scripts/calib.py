import json, collections
H=json.load(open('hist.json'))
FEE=0.07
def px_at(h, t):
    best=None
    for x in h:
        if x['t']<=t: best=x
        else: break
    return best
print("Buying the FAVORITE at the Polymarket last/mid price at T-τ; fee = 0.07*(1-q) of stake")
for asset in ['XAU','XAG','ALL']:
    print(f"\n######## {asset}")
    for tau in [600,300,180,120,60,30]:
        b=collections.defaultdict(lambda:[0,0,0.0,0.0])
        for j in H:
            if asset!='ALL' and j['asset']!=asset: continue
            end=j['ts']+900; x=px_at(sorted(j['hist'],key=lambda r:r['t']), end-tau)
            if not x or end-tau-x['t']>120: continue   # need a fresh print within 2 min
            p=x['p']; fav_up=p>=0.5; q=p if fav_up else 1-p
            win = (j['res']==1)==fav_up
            if q<0.55: key='0.50-0.55'
            else:
                lo=min(int(q*20)/20,0.95); key=f'{lo:.2f}-{lo+0.05:.2f}'
            s=b[key]; s[0]+=1; s[1]+=win; s[2]+=q; s[3]+= (win/q - 1) - FEE*(1-q)
        print(f" τ={tau:3d}s  bucket      n   avgq   WR    edge(WR-q)  EV/$ after fee")
        tot=[0,0,0.0,0.0]
        for k in sorted(b):
            n,w,sq,ev=b[k]; tot=[tot[0]+n,tot[1]+w,tot[2]+sq,tot[3]+ev]
            print(f"          {k}  {n:4d}  {sq/n:.3f}  {w/n:.3f}  {w/n-sq/n:+.3f}      {ev/n:+.3f}")
        hi=[v for k,v in b.items() if k>='0.80']
        n=sum(v[0] for v in hi)
        if n: print(f"          >=0.80 pooled n={n} WR={sum(v[1] for v in hi)/n:.3f} q={sum(v[2] for v in hi)/n:.3f} EV/$={sum(v[3] for v in hi)/n:+.4f}")
