import json, urllib.request, urllib.parse, ssl, time, concurrent.futures as cf
ctx=ssl.create_default_context()
def get(u):
    for i in range(5):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'research-script/1.0'}),timeout=30,context=ctx))
        except Exception as e: err=e; time.sleep(1+2*i)
    raise err
cids=[json.loads(l)['markets'][0]['conditionId'] for sid in ('12967','12968') for l in open(f'closed_{sid}.jsonl')]
def work(batch):
    rows=[]; cur=None
    while True:
        q={'condition':','.join(batch),'limit':500,'taker_only':'false'}
        if cur: q['cursor']=cur
        d=get('https://data-api.polymarket.com/v2/trades?'+urllib.parse.urlencode(q))
        rows+=d.get('data',[]); cur=(d.get('pagination') or {}).get('next_cursor')
        if not cur or not d.get('data'): break
    return rows
with cf.ThreadPoolExecutor(4) as ex: res=list(ex.map(work,[cids[i:i+20] for i in range(0,len(cids),20)]))
keep=['proxy_wallet','side','token_id','condition_id','size','price','timestamp','outcome_index','name','transaction_hash']
allr=[{k:r.get(k) for k in keep} for b in res for r in b]
json.dump(allr,open('alltrades.json','w')); print(len(allr),'rows (maker+taker)')
