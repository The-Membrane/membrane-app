"""Daily Aave V3 Ethereum WETH (and WBTC) interest-rate strategy parameters + reserve totals at the daily anchor blocks.
Reads getReserveData -> interestRateStrategyAddress, then the strategy's params (legacy v1 no-arg getters or v2
getInterestRateData(asset)), and aToken/variableDebt totals for utilization. Keyless archive eth_call. Output strategy_daily.jsonl."""
import json,time,urllib.request,os,csv
RPCS=["https://eth.drpc.org","https://ethereum-rpc.publicnode.com","https://rpc.mevblocker.io"]
POOL="0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"; MC="0xcA11bde05977b3631167028862bE2a173976CA11"
ASSETS={"WETH":"c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","WBTC":"2260fac5e5542a773aa44fbcfedf7c193bc2c599"}
def ea(a): return a.lower().replace("0x","").rjust(64,"0")
def agg3(calls):
    head="0x82ad56cb"+hex(32)[2:].rjust(64,"0")+hex(len(calls))[2:].rjust(64,"0"); offs=[];body=""; base=32*len(calls)
    for tgt,data in calls:
        offs.append(base+len(body)//2); d=data[2:]; dl=len(d)//2
        body+=ea(tgt)+"1".rjust(64,"0")+hex(96)[2:].rjust(64,"0")+hex(dl)[2:].rjust(64,"0")+d+"0"*((64-len(d)%64)%64)
    return head+"".join(hex(o)[2:].rjust(64,"0") for o in offs)+body
def dec(res):
    res=res[2:]; w=lambda i:int(res[i*64:(i+1)*64],16); n=w(1); out=[]
    for i in range(n):
        o=w(2+i)//32+2; ok=w(o); boff=o+w(o+1)//32; blen=w(boff); out.append((ok,res[(boff+1)*64:(boff+1)*64+blen*2]))
    return out
def rpc(method,params,tries=6):
    err=None
    for k in range(tries):
        u=RPCS[k%len(RPCS)]
        try:
            p=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
            r=json.loads(urllib.request.urlopen(urllib.request.Request(u,p,{"content-type":"application/json","user-agent":"membrane-research"}),timeout=60).read())
            if "result" in r and r["result"]: return r["result"]
            err=r
        except Exception as e: err=e
        time.sleep(1.5*(k+1))
    raise RuntimeError(str(err)[:300])
def mc(calls,b): return dec(rpc("eth_call",[{"to":MC,"data":agg3(calls)},hex(b)]))
# selectors
S={"getReserveData":"0x35ea6a75","totalSupply":"0x18160ddd","OPTIMAL_USAGE_RATIO":"0x54c365c6","getBaseVariableBorrowRate":"0x34762ca5","getVariableRateSlope1":"0x0b3429a2","getVariableRateSlope2":"0xf4202409","getOptimalUsageRatio":"0xa8602e86","getInterestRateData":"0x131e889c","getBaseVariableBorrowRate2":"0xacf5a4a4"}
def words(h): return [int(h[i*64:(i+1)*64],16) for i in range(len(h)//64)]
def read(b):
    out={"b":b,"a":{}}
    r1=mc([(POOL,S["getReserveData"]+ea(a)) for a in ASSETS.values()],b)
    for (nm,a),(ok,h) in zip(ASSETS.items(),r1):
        if not ok or len(h)<15*64: continue
        w=words(h); strat="0x"+hex(w[11])[2:].rjust(40,"0"); atok="0x"+hex(w[8])[2:].rjust(40,"0"); vdebt="0x"+hex(w[10])[2:].rjust(40,"0")
        calls=[(atok,S["totalSupply"]),(vdebt,S["totalSupply"]),(strat,S["getOptimalUsageRatio"]),(strat,S["getBaseVariableBorrowRate"]),(strat,S["getVariableRateSlope1"]),(strat,S["getVariableRateSlope2"]),(strat,S["getInterestRateData"]+ea(a)),(strat,S["OPTIMAL_USAGE_RATIO"])]
        r2=mc(calls,b)
        g=lambda i: int(r2[i][1],16) if r2[i][0] and r2[i][1] else None
        rec={"strategy":strat,"aSupply":g(0),"vDebt":g(1),"rate":w[4],"li":w[1],"vbi":w[3],"ts":w[6]}
        if r2[6][0] and len(r2[6][1])>=4*64:
            v=words(r2[6][1]); rec["abi"]="v2"; rec["optimal"]=v[0]; rec["base"]=v[1]; rec["slope1"]=v[2]; rec["slope2"]=v[3]   # bps-scaled in v3.2 (ray in return? decoded raw)
        else:
            rec["abi"]="v1"; rec["optimal"]=g(2) if g(2) is not None else g(7); rec["base"]=g(3); rec["slope1"]=g(4); rec["slope2"]=g(5)
        out["a"][nm]=rec
    return out
def anchors():
    A=[]
    with open("/home/user/membrane-datasets/depositor-balances/blocks.csv") as f:
        for r in csv.DictReader(f):
            if r["snapshot"]!="asof": A.append((int(r["T"]),int(r["block"])))
    # before 2023-02-01: Jan 27-31 2023, approx 7200 blocks/day back from the first anchor
    t0,b0=A[0]
    for k in range(1,6): A.insert(0,(t0-86400*k,b0-7170*k))
    # after the last anchor: interpolate to head
    head=int(rpc("eth_blockNumber",[]),16); hts=int(rpc("eth_getBlockByNumber",[hex(head),False])["timestamp"],16)
    tl,bl=A[-1]; t=tl+86400
    while t<hts: A.append((t,bl+int((head-bl)*(t-tl)/(hts-tl)))); t+=86400
    return A
if __name__=="__main__":
    outp="strategy_daily.jsonl"; done=set()
    if os.path.exists(outp): done={json.loads(l)["T"] for l in open(outp)}
    A=anchors(); print("anchors",len(A),"done",len(done),flush=True); n=0
    with open(outp,"a") as f:
        for T,b in A:
            if T in done: continue
            try: row=read(b); row["T"]=T; f.write(json.dumps(row,separators=(",",":"))+"\n")
            except Exception as e: f.write(json.dumps({"T":T,"b":b,"err":str(e)[:200]})+"\n")
            n+=1
            if n%100==0: f.flush(); print(n,flush=True)
    print("finished",n,flush=True)
