"""Keyless JSON-RPC client for Q39 (membrane-board design/Q39_CASCADE_PREREG.md C.2).

Endpoint rotation per chain, pacing, retry, Multicall3 batching and eth_getLogs range splitting.
Free public endpoints only (the same inventory as membrane-app scripts/oct10-coverage/rpc.ts, probed
again 2026-10-18). No key, no secret. Addresses passed here are opaque keys; nothing is written to disk.
"""
from __future__ import annotations

import itertools
import json
import threading
import time
import urllib.error
import urllib.request

from Crypto.Hash import keccak

UA = "curl/8.5.0"
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
MAX_LOG_RANGE = {"base": 1000}   # Tenderly public Base: "maximum 1000 blocks" (probed 2026-10-18)

# (url, min seconds between request starts, serves logs, serves archive state)
ENDPOINTS = {
    "ethereum": [
        ("https://mainnet.gateway.tenderly.co", 0.06, True, True),
        ("https://gateway.tenderly.co/public/mainnet", 0.08, True, True),
        ("https://rpc.mevblocker.io", 0.10, True, True),
        ("https://eth.drpc.org", 0.08, False, True),
        ("https://eth-mainnet.public.blastapi.io", 0.10, False, True),
    ],
    "arbitrum": [
        ("https://arbitrum.gateway.tenderly.co", 0.06, True, True),
        ("https://gateway.tenderly.co/public/arbitrum", 0.08, True, True),
        ("https://arbitrum-one.public.blastapi.io", 0.10, False, True),
        ("https://arb1.arbitrum.io/rpc", 0.15, True, False),
    ],
    "optimism": [
        ("https://optimism.gateway.tenderly.co", 0.06, True, True),
        ("https://gateway.tenderly.co/public/optimism", 0.08, True, True),
        ("https://optimism.drpc.org", 0.15, False, True),
        ("https://mainnet.optimism.io", 0.15, True, True),
    ],
    "base": [
        ("https://base.gateway.tenderly.co", 0.06, True, True),
        ("https://gateway.tenderly.co/public/base", 0.08, True, True),
        ("https://base-mainnet.public.blastapi.io", 0.10, False, True),
        ("https://base.drpc.org", 0.10, False, True),
    ],
}


def keccak_hex(s: str | bytes) -> str:
    h = keccak.new(digest_bits=256)
    h.update(s.encode() if isinstance(s, str) else s)
    return "0x" + h.hexdigest()


def selector(sig: str) -> str:
    return keccak_hex(sig)[:10]


def topic(sig: str) -> str:
    return keccak_hex(sig)


class RpcError(Exception):
    pass


class _Endpoint:
    def __init__(self, url, gap, logs, state):
        self.url, self.gap, self.logs, self.state = url, gap, logs, state
        self.lock = threading.Lock()
        self.next_t = 0.0
        self.fails = 0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            t = max(now, self.next_t)
            self.next_t = t + self.gap * (1 + min(self.fails, 8))
        if t > now:
            time.sleep(t - now)


class Client:
    def __init__(self, chain: str):
        self.chain = chain
        self.eps = [_Endpoint(*e) for e in ENDPOINTS[chain]]
        self._rr = itertools.count()
        self.n_requests = 0

    def _pick(self, need_logs: bool, need_state: bool, exclude: set):
        cands = [e for e in self.eps if (e.logs or not need_logs) and (e.state or not need_state) and e.url not in exclude]
        if not cands:
            return None
        cands.sort(key=lambda e: e.fails)
        best = [e for e in cands if e.fails == cands[0].fails]
        return best[next(self._rr) % len(best)]

    def _post(self, ep: _Endpoint, payload, timeout=90):
        ep.wait()
        req = urllib.request.Request(ep.url, data=json.dumps(payload).encode(),
                                     headers={"content-type": "application/json", "user-agent": UA})
        self.n_requests += 1
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())

    def call(self, method: str, params: list, need_logs=False, need_state=False, retries=8):
        """One JSON-RPC request with rotation. Raises RpcError with the last message."""
        exclude, last = set(), None
        for attempt in range(retries):
            ep = self._pick(need_logs, need_state, exclude)
            if ep is None:
                exclude.clear()
                time.sleep(2 * (attempt + 1))
                continue
            try:
                out = self._post(ep, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
                ep.fails += 1
                exclude.add(ep.url)
                last = f"{ep.url}: {e}"
                continue
            if "error" in out:
                msg = str(out["error"].get("message", out["error"]))
                last = f"{ep.url}: {msg}"
                if _is_range_error(msg) and method == "eth_getLogs":
                    raise RangeTooLarge(msg)
                if "execution reverted" in msg or "revert" in msg.lower():
                    raise Reverted(msg)
                ep.fails += 1
                exclude.add(ep.url)
                continue
            if out.get("result") is None and method == "eth_getBlockByNumber":
                ep.fails += 1
                exclude.add(ep.url)
                last = f"{ep.url}: null block"
                continue
            if ep.fails:
                ep.fails -= 1
            return out["result"]
        raise RpcError(f"{method} failed after {retries}: {last}")

    # ---------------------------------------------------------------- helpers
    def _logs_capped(self, address, topics, a, b):
        last = None
        for attempt in range(6):
            try:
                return self.call("eth_getLogs", [{"address": address, "topics": topics, "fromBlock": hex(a),
                                                  "toBlock": hex(b)}], need_logs=True, retries=6)
            except (RangeTooLarge, RpcError) as e:
                last = e
                time.sleep(1 + attempt)
        raise RpcError(f"capped getLogs {a}-{b}: {last}")

    def block_number(self) -> int:
        return int(self.call("eth_blockNumber", []), 16)

    def block_ts(self, n: int) -> int:
        b = self.call("eth_getBlockByNumber", [hex(n), False])
        return int(b["timestamp"], 16)

    def eth_call(self, to: str, data: str, block: int | str = "latest") -> str:
        blk = hex(block) if isinstance(block, int) else block
        return self.call("eth_call", [{"to": to, "data": data}, blk], need_state=True)

    def multicall(self, calls: list[tuple[str, str]], block: int, chunk=150) -> list[bytes | None]:
        """Multicall3.tryAggregate(false, calls). Returns raw return bytes or None per call."""
        out: list[bytes | None] = []
        for i in range(0, len(calls), chunk):
            part = calls[i:i + chunk]
            data = _encode_try_aggregate(part)
            try:
                res = self.eth_call(MULTICALL3, data, block)
            except (RpcError, Reverted) as e:
                if len(part) == 1:
                    out.append(None)
                    continue
                half = max(1, len(part) // 2)
                out.extend(self.multicall(part[:half], block, half))
                out.extend(self.multicall(part[half:], block, half))
                continue
            out.extend(_decode_try_aggregate(res))
        return out

    def get_logs(self, address, topics, frm: int, to: int, step=200_000, min_step=20):
        """All logs in [frm, to], splitting a range on any error down to min_step blocks. On a chain with a
        hard per-request cap the range is cut into capped sub-ranges fetched by a small thread pool."""
        cap = MAX_LOG_RANGE.get(self.chain)
        if cap and to - frm + 1 > cap:
            from concurrent.futures import ThreadPoolExecutor
            parts = [(a, min(to, a + cap - 1)) for a in range(frm, to + 1, cap)]
            with ThreadPoolExecutor(6) as ex:
                res = list(ex.map(lambda ab: self._logs_capped(address, topics, ab[0], ab[1]), parts))
            return [lg for r in res for lg in r]
        if cap:
            return self._logs_capped(address, topics, frm, to)
        logs, a = [], frm
        cur = step
        while a <= to:
            b = min(to, a + cur - 1)
            try:
                res = self.call("eth_getLogs", [{"address": address, "topics": topics,
                                                  "fromBlock": hex(a), "toBlock": hex(b)}], need_logs=True, retries=4)
            except (RangeTooLarge, RpcError) as e:
                if cur <= min_step:
                    tries = getattr(self, "_min_tries", 0) + 1
                    self._min_tries = tries
                    if tries > 8:
                        raise RpcError(f"getLogs {a}-{b} failed at min step: {e}")
                    time.sleep(5 * tries)
                    continue
                cur = max(min_step, cur // 4)
                continue
            self._min_tries = 0
            logs.extend(res)
            a = b + 1
            if len(res) < 2000 and cur < step:
                cur = min(step, cur * 2)
        return logs


class RangeTooLarge(Exception):
    pass


class Reverted(Exception):
    pass


def _is_range_error(msg: str) -> bool:
    m = msg.lower()
    return any(k in m for k in ("range", "too many", "limit", "exceed", "query returned more", "response size",
                                "10000", "block range"))


# ------------------------------------------------------------------- ABI (minimal, static types)
def enc_addr(a: str) -> str:
    return a.lower().replace("0x", "").rjust(64, "0")


def enc_uint(x: int) -> str:
    return hex(x)[2:].rjust(64, "0")


def words(hexdata: str | bytes) -> list[int]:
    b = bytes.fromhex(hexdata[2:]) if isinstance(hexdata, str) else hexdata
    return [int.from_bytes(b[i:i + 32], "big") for i in range(0, len(b), 32)]


def to_addr(w: int) -> str:
    return "0x" + hex(w)[2:].rjust(40, "0")[-40:]


def signed(w: int) -> int:
    return w - (1 << 256) if w >= 1 << 255 else w


def _encode_try_aggregate(calls):
    # tryAggregate(bool requireSuccess, (address target, bytes callData)[] calls)
    sel = selector("tryAggregate(bool,(address,bytes)[])")[2:]
    head = enc_uint(0) + enc_uint(64)
    n = len(calls)
    arr = enc_uint(n)
    elems, offs = [], []
    cur = 32 * n
    for to, data in calls:
        d = data[2:]
        ln = len(d) // 2
        pad = d + "0" * ((64 - len(d) % 64) % 64)
        e = enc_addr(to) + enc_uint(64) + enc_uint(ln) + pad
        offs.append(cur)
        elems.append(e)
        cur += len(e) // 2
    arr += "".join(enc_uint(o) for o in offs) + "".join(elems)
    return "0x" + sel + head + arr


def _decode_try_aggregate(res: str):
    b = bytes.fromhex(res[2:])
    w = lambda o: int.from_bytes(b[o:o + 32], "big")
    base = w(0)
    n = w(base)
    out = []
    for i in range(n):
        eo = base + 32 + w(base + 32 + 32 * i)
        ok = w(eo)
        do = eo + w(eo + 32)
        ln = w(do)
        data = b[do + 32: do + 32 + ln]
        out.append(data if ok and ln > 0 else None)
    return out
