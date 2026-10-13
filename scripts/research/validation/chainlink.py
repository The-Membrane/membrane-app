#!/usr/bin/env python3
"""Minimal read-only Chainlink client over public Ethereum JSON-RPC (stdlib urllib only).

Used by the T5 live issuer (m1_issue.py) and scorer (m1_score.py), prereg T5.1 / T5.3.

  latest_round_data()          -> Round   (proxy latestRoundData)
  get_round_data(round_id)     -> Round | None   (proxy getRoundData; None = no data / reverted)
  answer_at(ts)                -> Round   the answer in force at ts = the round with the largest
                                          updatedAt <= ts. Galloping + binary search over aggregator
                                          round ids inside the phase (roundId = phaseId<<64 | aggRoundId);
                                          when aggRoundId 1 is already after ts it steps to the
                                          previous phase (phaseAggregators(p-1) -> its latest round).
  rounds_between(t_a, t_b)     -> [Round] the round in force at t_a, then every round with
                                          updatedAt in (t_a, t_b] (read in JSON-RPC batches).

Public RPCs only, from a fixed list with fallback. No keyed URL is accepted. RPC URLs are never
returned in results, stats or error messages (they are scrubbed to "<rpc#i>"), so callers cannot
write them into output files. Every eth_call counts against a call budget.
"""
import http.client
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import NamedTuple

from t5_common import USER_AGENT

PUBLIC_RPCS = (
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org",
    "https://cloudflare-eth.com",
    "https://eth-mainnet.public.blastapi.io",
    "https://mainnet.gateway.tenderly.co",
)

FEEDS = {  # Chainlink proxies, Ethereum mainnet, 8 decimals
    "ETH": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",  # ETH / USD
    "BTC": "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",  # BTC / USD
}
DECIMALS = 8

SEL_LATEST_ROUND_DATA = "feaf968c"   # latestRoundData()
SEL_GET_ROUND_DATA = "9a6fc8f5"      # getRoundData(uint80)
SEL_PHASE_AGGREGATORS = "c1597304"   # phaseAggregators(uint16)
AGG_MASK = (1 << 64) - 1


class RpcError(Exception):
    pass


class BudgetExceeded(RpcError):
    pass


class _Reverted:
    """Marker: the call executed and reverted (a deterministic answer, not a provider failure)."""


REVERTED = _Reverted()


class _BadResponse(Exception):
    pass


def _assert_public(url):
    p = urllib.parse.urlparse(url)
    if p.scheme != "https" or p.username or p.password or p.query or p.fragment:
        raise ValueError("RPC URL must be a plain public https endpoint (no key, query or userinfo)")
    for seg in p.path.split("/"):
        if len(seg) > 16:
            raise ValueError("RPC URL path looks like it carries a key; public endpoints only")


def urllib_post(url, body, timeout):
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


class RpcClient:
    """eth_call over a list of public RPCs. Batches are shrunk for providers that reject them;
    single-call failures are retried with exponential backoff, then the next provider is used
    (sticky for the rest of the run)."""

    def __init__(self, urls=PUBLIC_RPCS, post=None, max_calls=1000, retries=2, backoff=1.0,
                 sleep=time.sleep, timeout=30, batch_size=50, log=None):
        for u in urls:
            _assert_public(u)
        self._urls = tuple(urls)
        self._post = post or urllib_post
        self.max_calls = int(max_calls)
        self.retries = int(retries)
        self.backoff = float(backoff)
        self._sleep = sleep
        self.timeout = timeout
        self.batch_size = int(batch_size)
        self._max_batch = [self.batch_size] * len(self._urls)
        self._cur = 0
        self._id = 0
        self._log = log or (lambda *_: None)
        self.eth_calls = 0
        self.http_requests = 0
        self.provider_switches = 0

    def stats(self):
        """Counts only. Never contains a URL."""
        return {"ethCalls": self.eth_calls, "httpRequests": self.http_requests, "budget": self.max_calls,
                "providerSwitches": self.provider_switches, "urlsRecorded": False}

    def _scrub(self, msg):
        msg = str(msg)
        for i, u in enumerate(self._urls):
            msg = msg.replace(u, f"<rpc#{i}>").replace(urllib.parse.urlparse(u).netloc, f"<rpc#{i}>")
        return msg

    # -- transport ----------------------------------------------------------------------------
    def _post_once(self, p, reqs):
        if self.eth_calls + len(reqs) > self.max_calls:
            raise BudgetExceeded(f"RPC call budget {self.max_calls} exhausted")
        self.eth_calls += len(reqs)
        self.http_requests += 1
        body = json.dumps(reqs[0] if len(reqs) == 1 else reqs).encode()
        try:
            raw = self._post(self._urls[p], body, self.timeout)
            resp = json.loads(raw)
        except (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError, ValueError) as e:
            raise _BadResponse(self._scrub(f"{type(e).__name__}: {e}"))
        if isinstance(resp, dict):
            resp = [resp]
        if not isinstance(resp, list) or len(resp) != len(reqs):
            raise _BadResponse("unexpected response shape")
        by_id = {r.get("id"): r for r in resp if isinstance(r, dict)}
        out = []
        for q in reqs:
            r = by_id.get(q["id"])
            if r is None:
                raise _BadResponse("missing id in response")
            if "error" in r:
                err = r["error"] or {}
                text = str(err.get("message", "")).lower()
                if err.get("code") == 3 or "revert" in text:
                    out.append(REVERTED)
                    continue
                raise _BadResponse(self._scrub(f"rpc error {err.get('code')}: {err.get('message')}"))
            res = r.get("result")
            if not isinstance(res, str) or not res.startswith("0x"):
                raise _BadResponse("result is not hex")
            out.append(bytes.fromhex(res[2:]))
        return out

    def _exchange(self, reqs):
        last = "no provider tried"
        while self._cur < len(self._urls):
            p = self._cur
            if len(reqs) > self._max_batch[p]:
                out = []
                step = self._max_batch[p]
                for i in range(0, len(reqs), step):
                    out += self._exchange(reqs[i:i + step])
                return out
            shrunk = False
            for attempt in range(self.retries):
                try:
                    return self._post_once(p, reqs)
                except _BadResponse as e:
                    last = str(e)
                    if len(reqs) > 1:  # provider rejects batches this large: shrink and re-split
                        self._max_batch[p] = max(1, len(reqs) // 4)
                        shrunk = True
                        break
                    self._sleep(self.backoff * (2 ** attempt))
            if shrunk:
                continue
            self._log(f"rpc#{p} failed ({last}); falling back")
            self._cur += 1
            self.provider_switches += 1
        raise RpcError(f"all public RPCs failed; last error: {last}")

    def eth_call_many(self, calls):
        """calls = [(to, data_hex_without_0x)] -> [bytes | REVERTED] in order."""
        reqs = []
        for to, data in calls:
            self._id += 1
            reqs.append({"jsonrpc": "2.0", "id": self._id, "method": "eth_call",
                         "params": [{"to": to, "data": "0x" + data}, "latest"]})
        out = []
        for i in range(0, len(reqs), self.batch_size):
            out += self._exchange(reqs[i:i + self.batch_size])
        return out

    def eth_call(self, to, data):
        return self.eth_call_many([(to, data)])[0]


# ---------------------------------------------------------------------------------------------
# ABI
# ---------------------------------------------------------------------------------------------
def _words(b, n):
    if len(b) < 32 * n:
        raise RpcError(f"short return data ({len(b)} bytes, need {32 * n})")
    return [int.from_bytes(b[32 * i:32 * (i + 1)], "big") for i in range(n)]


def _int256(w):
    return w - (1 << 256) if w >= (1 << 255) else w


class Round(NamedTuple):
    round_id: int
    answer: int
    started_at: int
    updated_at: int
    answered_in_round: int

    @property
    def phase(self):
        return self.round_id >> 64

    @property
    def agg(self):
        return self.round_id & AGG_MASK

    def price(self, decimals=DECIMALS):
        return self.answer / 10 ** decimals

    def to_json(self, decimals=DECIMALS):
        return {"roundId": str(self.round_id), "phaseId": self.phase, "aggregatorRoundId": self.agg,
                "answer": self.answer, "price": self.price(decimals), "updatedAt": self.updated_at}


def decode_round(b):
    w = _words(b, 5)
    return Round(w[0], _int256(w[1]), w[2], w[3], w[4])


def enc_uint(v):
    return format(int(v), "064x")


# ---------------------------------------------------------------------------------------------
# Feed
# ---------------------------------------------------------------------------------------------
class Feed:
    def __init__(self, rpc, address, decimals=DECIMALS, clock=time.time):
        self.rpc = rpc
        self.address = address
        self.decimals = decimals
        self.clock = clock
        self._cache = {}
        self._latest = None
        self._latest_read_at = None

    # -- raw reads ----------------------------------------------------------------------------
    def latest_round_data(self, refresh=False):
        if self._latest is None or refresh:
            b = self.rpc.eth_call(self.address, SEL_LATEST_ROUND_DATA)
            if b is REVERTED:
                raise RpcError("latestRoundData reverted")
            self._latest = decode_round(b)
            self._latest_read_at = int(self.clock())
            self._cache[self._latest.round_id] = self._latest
        return self._latest

    def _decode_or_none(self, rid, b):
        if b is REVERTED:
            return None
        r = decode_round(b)
        if r.updated_at == 0:  # OCR aggregators return zeros for a round that does not exist
            return None
        if r.round_id != rid:
            raise RpcError(f"getRoundData({rid}) returned round {r.round_id}")
        return r

    def get_round_data(self, round_id):
        return self.get_rounds([round_id])[0]

    def get_rounds(self, round_ids):
        missing = [r for r in dict.fromkeys(round_ids) if r not in self._cache]
        if missing:
            res = self.rpc.eth_call_many([(self.address, SEL_GET_ROUND_DATA + enc_uint(r)) for r in missing])
            for rid, b in zip(missing, res):
                self._cache[rid] = self._decode_or_none(rid, b)
        return [self._cache[r] for r in round_ids]

    def phase_latest(self, phase):
        """Latest round of `phase` via phaseAggregators(phase) -> aggregator.latestRoundData(), returned
        in proxy form (phase<<64 | aggRoundId) as read back through the proxy. None if no aggregator."""
        if phase < 1:
            return None
        b = self.rpc.eth_call(self.address, SEL_PHASE_AGGREGATORS + enc_uint(phase))
        if b is REVERTED:
            return None
        agg_addr = int.from_bytes(_words(b, 1)[0].to_bytes(32, "big")[12:], "big")
        if agg_addr == 0:
            return None
        b = self.rpc.eth_call("0x" + format(agg_addr, "040x"), SEL_LATEST_ROUND_DATA)
        if b is REVERTED:
            raise RpcError(f"phase {phase} aggregator latestRoundData reverted")
        agg_round = decode_round(b).round_id & AGG_MASK
        r = self.get_round_data((phase << 64) | agg_round)
        if r is None:
            raise RpcError(f"phase {phase} latest round {agg_round} unreadable through the proxy")
        return r

    # -- searches -----------------------------------------------------------------------------
    def _need(self, rid):
        r = self.get_round_data(rid)
        if r is None:
            raise RpcError(f"round {rid >> 64}/{rid & AGG_MASK} has no data inside the searched range")
        return r

    def _search_phase(self, phase, hi_agg, ts):
        """Largest agg id r in [1, hi_agg) with updatedAt(r) <= ts, given updatedAt(hi_agg) > ts.
        Galloping back from hi_agg (steps 1, 2, 4, ...) to bracket, then binary search.
        None if round 1 of the phase is already after ts."""
        base = phase << 64
        good_hi, step = hi_agg, 1
        while True:
            probe = max(1, good_hi - step)
            if probe >= good_hi:
                return None  # good_hi == 1 and it is after ts
            r = self._need(base | probe)
            if r.updated_at <= ts:
                lo = probe
                break
            good_hi = probe
            if probe == 1:
                return None
            step *= 2
        while good_hi - lo > 1:  # invariant: updatedAt(lo) <= ts < updatedAt(good_hi)
            mid = (lo + good_hi) // 2
            if self._need(base | mid).updated_at <= ts:
                lo = mid
            else:
                good_hi = mid
        return self._need(base | lo)

    def answer_at(self, ts, upper=None):
        """Round in force at ts (largest updatedAt <= ts). `upper` (optional) = a round known to be at or
        after the answer, e.g. answer_at(t') for some t' >= ts; it only narrows the search."""
        ts = int(ts)
        if ts > self.clock():
            raise ValueError("answer_at: ts is in the future")
        latest = self.latest_round_data()
        if self._latest_read_at is not None and self._latest_read_at < ts:
            latest = self.latest_round_data(refresh=True)
        top = upper if upper is not None else latest
        if top.updated_at <= ts:
            return top
        phase = top.phase
        r = self._search_phase(phase, top.agg, ts)
        while r is None:  # phase boundary: round 1 of `phase` is after ts -> previous phase
            phase -= 1
            prev = self.phase_latest(phase)
            if prev is None:
                raise LookupError(f"no Chainlink round at or before {ts} (reached phase {phase})")
            if prev.updated_at <= ts:
                return prev
            r = self._search_phase(phase, prev.agg, ts)
        return r

    def rounds_between(self, t_a, t_b):
        """[round in force at t_a] + every round with updatedAt in (t_a, t_b], in round-id order.
        Spans phase boundaries (the rest of the earlier phase, then the next phase from round 1)."""
        if t_b < t_a:
            raise ValueError("t_b < t_a")
        r_b = self.answer_at(t_b)
        r_a = self.answer_at(t_a, upper=r_b)
        ids = []
        for phase in range(r_a.phase, r_b.phase + 1):
            first = r_a.agg + 1 if phase == r_a.phase else 1
            if phase == r_b.phase:
                last = r_b.agg
            else:
                pl = self.phase_latest(phase)
                last = pl.agg if pl is not None else 0
            ids += [(phase << 64) | i for i in range(first, last + 1)]
        rounds = self.get_rounds(ids)
        for rid, r in zip(ids, rounds):
            if r is None:
                raise RpcError(f"round {rid >> 64}/{rid & AGG_MASK} has no data inside ({t_a}, {t_b}]")
        return [r_a] + [r for r in rounds if t_a < r.updated_at <= t_b]


def window_min(rounds, t_a, t_b):
    """Minimum answer over (t_a, t_b] from a round list: the round in force at t_a (largest updatedAt
    <= t_a) plus every round with updatedAt in (t_a, t_b]. Returns (min Round, rounds used, in-force
    round first) or (None, []) when the list does not reach back to t_a (no in-force round known)."""
    in_force, used = None, []
    for r in sorted(rounds, key=lambda x: (x.updated_at, x.round_id)):
        if r.updated_at <= t_a:
            in_force = r
        elif r.updated_at <= t_b:
            used.append(r)
    if in_force is None:
        return None, []
    used = [in_force] + used
    return min(used, key=lambda x: (x.answer, x.updated_at)), used
