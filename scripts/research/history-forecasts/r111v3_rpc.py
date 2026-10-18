"""Small keyless JSON-RPC client for Q26 R11.1-v3 (membrane-board design/Q26_ROUND11_PREREG.md D-R11.1e).

Batch eth_call / eth_getLogs with endpoint rotation, pacing and range splitting. Free public endpoints only.
Addresses passed through this module stay in the caller's scratch work directory; nothing here writes files.
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request

UA = "curl/8.5.0"
ENDPOINTS = {
    "ethereum": ["https://mainnet.gateway.tenderly.co", "https://gateway.tenderly.co/public/mainnet"],
    "arbitrum": ["https://arbitrum.gateway.tenderly.co", "https://gateway.tenderly.co/public/arbitrum",
                 "https://arb1.arbitrum.io/rpc"],
}
# archive eth_call: arb1.arbitrum.io holds no archive state (D-R11.9a inventory note)
CALL_ENDPOINTS = {
    "ethereum": ["https://mainnet.gateway.tenderly.co", "https://eth.drpc.org", "https://rpc.mevblocker.io"],
    "arbitrum": ["https://arbitrum.gateway.tenderly.co", "https://gateway.tenderly.co/public/arbitrum"],
}
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"


class RpcError(Exception):
    pass


class TooMany(Exception):
    def __init__(self, hint=None):
        super().__init__("too many results")
        self.hint = hint


class Client:
    def __init__(self, chain, interval=0.12, calls=False):
        self.urls = list((CALL_ENDPOINTS if calls else ENDPOINTS)[chain])
        self.interval = interval
        self.lock = threading.Lock()
        self.last = 0.0
        self.i = 0
        self.stats = {"requests": 0, "errors": 0, "splits": 0, "logs": 0}

    def _pace(self):
        with self.lock:
            now = time.monotonic()
            wait = self.last + self.interval - now
            self.last = max(now, self.last + self.interval)
        if wait > 0:
            time.sleep(wait)

    def _post(self, url, payload, timeout=120):
        req = urllib.request.Request(url, data=payload, headers={"content-type": "application/json", "user-agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())

    def request(self, method, params, tries=10):
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        err = None
        for k in range(tries):
            with self.lock:
                self.i += 1
                url = self.urls[self.i % len(self.urls)]
            self._pace()
            try:
                body = self._post(url, payload)
                with self.lock:
                    self.stats["requests"] += 1
                if "error" in body:
                    e = body["error"]
                    msg = (str(e.get("message", "")) + " " + str(e.get("data", ""))).lower()
                    if ("more than" in msg or "too many" in msg or "timed out" in msg
                            or ("limit" in msg and "log" in msg) or ("range" in msg and "block" in msg)):
                        m = re.search(r"\[(0x[0-9a-f]+),\s*(0x[0-9a-f]+)\]", msg)
                        raise TooMany((int(m.group(1), 16), int(m.group(2), 16)) if m else None)
                    raise RpcError(msg[:300])
                return body["result"]
            except TooMany:
                raise
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError, RpcError,
                    json.JSONDecodeError, OSError) as e:
                err = e
                with self.lock:
                    self.stats["errors"] += 1
                time.sleep(min(2 + 2 * k, 20))
        raise RpcError(f"{method} failed after {tries}: {err}")

    def batch(self, reqs, tries=10):
        payload = json.dumps([{"jsonrpc": "2.0", "id": i, "method": m, "params": p}
                              for i, (m, p) in enumerate(reqs)]).encode()
        err = None
        for k in range(tries):
            with self.lock:
                self.i += 1
                url = self.urls[self.i % len(self.urls)]
            self._pace()
            try:
                body = self._post(url, payload)
                with self.lock:
                    self.stats["requests"] += 1
                if not isinstance(body, list):
                    raise RpcError(str(body)[:300])
                body = sorted(body, key=lambda x: x["id"])
                if len(body) != len(reqs) or any("error" in x for x in body):
                    raise RpcError(str([x.get("error") for x in body if "error" in x][:2])[:300])
                return [x["result"] for x in body]
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError, RpcError,
                    json.JSONDecodeError, OSError, KeyError) as e:
                err = e
                with self.lock:
                    self.stats["errors"] += 1
                time.sleep(min(2 + 2 * k, 20))
        raise RpcError(f"batch failed after {tries}: {err}")

    def logs(self, address, topics, lo, hi):
        """All logs in [lo, hi], splitting on result caps. Returns the raw log dicts in chain order."""
        out = []
        stack = [(lo, hi)]
        while stack:
            a, b = stack.pop()
            flt = {"fromBlock": hex(a), "toBlock": hex(b), "topics": topics}
            if address is not None:
                flt["address"] = address
            try:
                res = self.request("eth_getLogs", [flt])
            except TooMany as t:
                with self.lock:
                    self.stats["splits"] += 1
                if b <= a:
                    raise RpcError(f"cannot split single block {a}")
                if t.hint and t.hint[0] == a and a <= t.hint[1] < b:
                    m = t.hint[1]
                else:
                    m = (a + b) // 2
                stack.append((m + 1, b))
                stack.append((a, m))
                continue
            with self.lock:
                self.stats["logs"] += len(res)
            out.extend(res)
        out.sort(key=lambda x: (int(x["blockNumber"], 16), int(x["logIndex"], 16)))
        return out


# ---------------------------------------------------------------------------------------------
# ABI helpers (keccak from b_acquire)
# ---------------------------------------------------------------------------------------------

def _keccak():
    import os
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import b_acquire as B
    return B.keccak256


def sel(sig):
    return _keccak()(sig.encode())[:4]


def topic(sig):
    return "0x" + _keccak()(sig.encode()).hex()


def enc_addr(a):
    return bytes(12) + bytes.fromhex(a[2:].lower())


def enc_u(n):
    return int(n).to_bytes(32, "big")


def aggregate3_data(calls):
    head = sel("aggregate3((address,bool,bytes)[])")
    n = len(calls)
    parts = []
    for tgt, data in calls:
        pad = data + bytes((32 - len(data) % 32) % 32)
        parts.append(enc_addr(tgt) + enc_u(1) + enc_u(96) + enc_u(len(data)) + pad)
    offs = []
    pos = 32 * n
    for p in parts:
        offs.append(pos)
        pos += len(p)
    body = enc_u(32) + enc_u(n) + b"".join(enc_u(o) for o in offs) + b"".join(parts)
    return "0x" + (head + body).hex()


def aggregate3_decode(raw):
    raw = bytes.fromhex(raw[2:])
    w = lambda p: int.from_bytes(raw[p:p + 32], "big")
    base = w(0)
    m = w(base)
    out = []
    for i in range(m):
        o = base + 32 + w(base + 32 + 32 * i)
        ok = bool(w(o))
        bo = o + w(o + 32)
        ln = w(bo)
        out.append((ok, raw[bo + 32:bo + 32 + ln]))
    return out


def aggregate3(client, calls, block):
    """calls = [(target, calldata bytes)] -> [(ok, bytes)] via Multicall3.aggregate3 (allowFailure)."""
    head = sel("aggregate3((address,bool,bytes)[])")
    n = len(calls)
    parts = []
    for tgt, data in calls:
        pad = data + bytes((32 - len(data) % 32) % 32)
        parts.append(enc_addr(tgt) + enc_u(1) + enc_u(96) + enc_u(len(data)) + pad)
    offs = []
    pos = 32 * n
    for p in parts:
        offs.append(pos)
        pos += len(p)
    body = enc_u(32) + enc_u(n) + b"".join(enc_u(o) for o in offs) + b"".join(parts)
    raw = client.request("eth_call", [{"to": MULTICALL3, "data": "0x" + (head + body).hex()}, hex(block)])
    raw = bytes.fromhex(raw[2:])
    w = lambda p: int.from_bytes(raw[p:p + 32], "big")
    base = w(0)
    m = w(base)
    out = []
    for i in range(m):
        o = base + 32 + w(base + 32 + 32 * i)
        ok = bool(w(o))
        bo = o + w(o + 32)
        ln = w(bo)
        out.append((ok, raw[bo + 32:bo + 32 + ln]))
    return out


def word(ret, i=0):
    if ret is None or len(ret) < 32 * (i + 1):
        return None
    return int.from_bytes(ret[32 * i:32 * (i + 1)], "big")


def as_addr(v):
    return None if v is None else "0x" + format(v & ((1 << 160) - 1), "040x")
