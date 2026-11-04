"""Hourly Aave V3 Ethereum pair-loop state: WETH/WBTC reserve data (indexes, rates), LST reserve liquidityIndex,
oracle prices (ratio = capped exchange-rate oracle), per hourly block. Keyless archive eth_call via Multicall3.
Output: hourly.jsonl (one line per hour, resumable). Aggregates only, no addresses."""
import json,time,urllib.request,os,sys,csv,gzip
RPCS=["https://eth.drpc.org","https://ethereum-rpc.publicnode.com","https://rpc.mevblocker.io"]
POOL="0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"; ORACLE="0x54586bE62E3c3580375aE3723C145253060Ca0C2"; MC="0xcA11bde05977b3631167028862bE2a173976CA11"
ASSETS={"WETH":"c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","WBTC":"2260fac5e5542a773aa44fbcfedf7c193bc2c599",
 "wstETH":"7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0","weETH":"cd5fe23c85820f7b72d0926fc9b05b43e359b7ee","rsETH":"a1290d69c65a6fe4df752f95823fae25cb99e5a7",
 "osETH":"f1c9acdc66974dfb6decb12aa385b9cd01190e38","cbETH":"be9895146f7af43049ca1c1ae358b0541ea49704","rETH":"ae78736cd615f374d3085123a210448e74fc6393",
 "ETHx":"a35b1b31ce002fbf2058d22f30f95d405200a15b","LBTC":"8236a87084f8b84306f72007f36f2618a5634494","cbBTC":"cbb7c0000ab88b473b1f5afd9ef808440eed33bf","eBTC":"657e8c867d8b37dcc18fa4caead9c45eb088c642","tBTC":"18084fba666a33d37592fa2633fd49a74dd93a88"}
def ea(a): return a.lower().replace("0x","").rjust(64,"0")
def agg3(calls):
    head="0x82ad56cb"+hex(32)[2:].rjust(64,"0")+hex(len(calls))[2:].rjust(64,"0"); offs=[];body=""; base=32*len(calls)
    for tgt,data in calls:
        offs.append(base+len(body)//2); d=data[2:]; dl=len(d)//2
        body+=ea(tgt)+"1".rjust(64,"0")+hex(96)[2:].rjust(64,"0")+hex(dl)[2:].rjust(64,"0")+d+"0"*((64-len(d)%64)%64)
    return head+"".join(hex(o)[2:].rjust(64,"0") for o in offs)+body
CALLS=[(MC,"0x0f28c97d")]+[(POOL,"0x35ea6a75"+ea(a)) for a in ASSETS.values()]+[(ORACLE,"0xb3596f07"+ea(a)) for a in ASSETS.values()]
DATA=agg3(CALLS)
def dec(res):
    res=res[2:]; w=lambda i:int(res[i*64:(i+1)*64],16); n=w(1); out=[]
    for i in range(n):
        o=w(2+i)//32+2; ok=w(o); boff=o+w(o+1)//32; blen=w(boff); out.append((ok,res[(boff+1)*64:(boff+1)*64+blen*2]))
    return out
def rpc(method,params,tries=6):
    err=None
    for k in range(tries):
        u=RPCS[k%len(RPCS)] if k>0 else RPCS[0]
        try:
            p=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
            r=json.loads(urllib.request.urlopen(urllib.request.Request(u,p,{"content-type":"application/json","user-agent":"membrane-research"}),timeout=60).read())
            if "result" in r and r["result"]: return r["result"]
            err=r
        except Exception as e: err=e
        time.sleep(1.5*(k+1))
    raise RuntimeError(str(err)[:300])
def block_ts(b): return int(rpc("eth_getBlockByNumber",[hex(b),False])["timestamp"],16)
def read(b):
    out=dec(rpc("eth_call",[{"to":MC,"data":DATA},hex(b)])); names=list(ASSETS)
    row={"b":b,"ts":int(out[0][1],16),"r":{},"px":{}}
    for i,nm in enumerate(names):
        ok,h=out[1+i]
        if ok and len(h)>=15*64:
            w=[int(h[j*64:(j+1)*64],16) for j in range(15)]
            row["r"][nm]={"li":w[1],"lr":w[2],"vbi":w[3],"vbr":w[4],"lu":w[6]}
        ok,h=out[1+len(names)+i]
        if ok and len(h)>=64: row["px"][nm]=int(h,16)
    return row
# ---- hourly block grid: venue-stress blocks where present, else interpolate between daily anchors
def grid():
    vs=json.load(open("/home/user/membrane-datasets/venue-stress/history.json"))["timeline"]
    known={t:b for t,b in zip(vs["t"],vs["b"]) if b}
    anchors={}
    with open("/home/user/membrane-datasets/depositor-balances/blocks.csv") as f:
        for r in csv.DictReader(f):
            if r["snapshot"]!="asof": anchors[int(r["T"])]=int(r["block"])
    head=int(rpc("eth_blockNumber",[]),16); hts=block_ts(head); anchors[hts]=head
    t0=1674777600  # 2023-01-27 00:00Z (Aave V3 Ethereum launch day)
    ks=sorted(anchors)
    out=[]
    t=t0
    while t<=hts-3600:
        if t in known: out.append((t,known[t]))
        else:
            # linear interpolation between surrounding anchors (12 s slots)
            lo=max([k for k in ks if k<=t],default=None); hi=min([k for k in ks if k>t],default=None)
            if lo is None: b=anchors[hi]-int((hi-t)/12.05)
            elif hi is None: b=anchors[lo]+int((t-lo)/12.05)
            else: b=anchors[lo]+int((anchors[hi]-anchors[lo])*(t-lo)/(hi-lo))
            out.append((t,b))
        t+=3600
    return out
if __name__=="__main__":
    g=grid(); outp="hourly.jsonl"; done=set()
    if os.path.exists(outp):
        for l in open(outp): done.add(json.loads(l)["t"])
    print("grid",len(g),"done",len(done),flush=True)
    n=0;t0=time.time()
    with open(outp,"a") as f:
        for t,b in g:
            if t in done: continue
            for k in range(3):
                try:
                    row=read(b); row["t"]=t; row["dt"]=row["ts"]-t; f.write(json.dumps(row,separators=(",",":"))+"\n"); break
                except Exception as e:
                    if k==2: f.write(json.dumps({"t":t,"b":b,"err":str(e)[:200]})+"\n")
                    time.sleep(3)
            n+=1
            if n%500==0: f.flush(); print(n,round(time.time()-t0),flush=True)
    print("finished",n,round(time.time()-t0),flush=True)
