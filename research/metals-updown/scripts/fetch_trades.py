import json, urllib.request, urllib.parse, ssl, time, concurrent.futures as cf
ctx=ssl.create_default_context()
def get(u):
    for i in range(5):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'research-script/1.0'}),timeout=30,context=ctx))
        except Exception as e: err=e; time.sleep(1+2*i)
    raise err
cids=[]
for sid,a in [('12967','XAU'),('12968','XAG')]:
    for l in open(f'closed_{sid}.jsonl'):
        e=json.loads(l); cids.append(e['markets'][0]['conditionId'])
def work(batch):
    rows=[]; cur=None
    while True:
        q={'condition':','.join(batch),'limit':500,'taker_only':'true'}
        if cur: q['cursor']=cur
        d=get('https://data-api.polymarket.com/v2/trades?'+urllib.parse.urlencode(q))
        rows+=d.get('data',[]); cur=(d.get('pagination') or {}).get('next_cursor') or d.get('next_cursor')
        if not cur or not d.get('data'): break
    return rows
batches=[cids[i:i+20] for i in range(0,len(cids),20)]
with cf.ThreadPoolExecutor(4) as ex: res=list(ex.map(work,batches))
allr=[r for b in res for r in b]
keep=['proxy_wallet','side','token_id','condition_id','size','price','timestamp','slug','outcome','outcome_index','name','transaction_hash']
json.dump([{k:r.get(k) for k in keep} for r in allr],open('trades.json','w'))
print(len(allr),'taker fills')
