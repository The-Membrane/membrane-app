import json, sys, time, urllib.request
URLS = ["https://rpc.mevblocker.io", "https://eth-mainnet.public.blastapi.io"]
N = [0]
POOL = "0xDC24316b9AE028F1497c275EB9192a3Ea0f67022"
DATA = "0x5e0d443f" + "%064x" % 1 + "%064x" % 0 + "%064x" % (10**18)
START, END, STEP = 11_600_000, 26_250_000, 300   # ~2021-01-07 .. ~2026-10-27, ~1 h
def rpc(reqs, tries=5):
    for k in range(8):
        try:
            body = json.dumps(reqs).encode()
            N[0] += 1
            r = urllib.request.urlopen(urllib.request.Request(URLS[N[0] % 2], body, {"content-type": "application/json", "user-agent": "q26"}), timeout=90)
            d = json.loads(r.read())
            if not isinstance(d, list):
                raise ValueError(str(d)[:80])
            time.sleep(0.15)
            return {x["id"]: x for x in d}
        except Exception as e:
            time.sleep(2 ** k)
    raise SystemExit("rpc failed")
blocks = list(range(START, END, STEP))
out = open(sys.argv[1], "w")
for i in range(0, len(blocks), 50):
    chunk = blocks[i:i + 50]
    reqs = [{"jsonrpc": "2.0", "id": j, "method": "eth_call", "params": [{"to": POOL, "data": DATA}, hex(b)]} for j, b in enumerate(chunk)]
    reqs += [{"jsonrpc": "2.0", "id": 1000 + j, "method": "eth_getBlockByNumber", "params": [hex(b), False]} for j, b in enumerate(chunk) if j == 0]
    res = rpc(reqs)
    ts = {chunk[j - 1000]: int(x["result"]["timestamp"], 16) for j, x in res.items() if j >= 1000 and x.get("result")}
    for j, b in enumerate(chunk):
        x = res.get(j, {})
        v = int(x["result"], 16) / 1e18 if x.get("result") and len(x["result"]) > 2 else None
        out.write(json.dumps([b, ts.get(b), v]) + "\n")
    out.flush()
