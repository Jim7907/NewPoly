import json, urllib.request, concurrent.futures as cf, os, time, ssl
ctx=ssl.create_default_context()
def get(u):
    for i in range(4):
        try:
            r=urllib.request.Request(u,headers={'User-Agent':'research-script/1.0','Accept':'application/json'})
            return json.load(urllib.request.urlopen(r,timeout=20,context=ctx))
        except Exception as e:
            err=e; time.sleep(1+2*i)
    return {'error':str(err)}
jobs=[]
for sid,a in [('12967','XAU'),('12968','XAG')]:
    for l in open(f'closed_{sid}.jsonl'):
        e=json.loads(l); m=e['markets'][0]; ts=int(e['slug'].rsplit('-',1)[1])
        up=json.loads(m['clobTokenIds'])[0]; op=json.loads(m['outcomePrices'])
        jobs.append(dict(asset=a,ts=ts,up=up,res=1 if op[0]=='1' else 0,vol=float(m.get('volume') or 0)))
def work(j):
    d=get(f"https://clob.polymarket.com/prices-history?market={j['up']}&startTs={j['ts']-300}&endTs={j['ts']+900}&fidelity=1")
    j['hist']=d.get('history',[]); j['err']=d.get('error'); return j
with cf.ThreadPoolExecutor(8) as ex: out=list(ex.map(work,jobs))
json.dump(out,open('hist.json','w')); print(len(out),'errs',sum(1 for j in out if j['err']),'empty',sum(1 for j in out if not j['hist']))
