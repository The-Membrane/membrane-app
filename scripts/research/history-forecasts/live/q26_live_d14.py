#!/usr/bin/env python3
"""Q26 live log -- D14: borrower-alert shadow log on Aave V3 (seven chains, hourly, counts only, nothing shown).

membrane-board design/HISTORY_TOUCH_LIVE.md block D14 (owner approval 2026-10-25 on OWNER? Q26-L1, verbatim choice
"Yes: Aave V3 all chains (Recommended)"); design/q26-borrower-alert-live-2026-10-25.md; RULING Q26-R27 (60fb0e6) and
REVIEW Q26-R27 (c59f67f). The job is a SHADOW: no alert is sent, nothing is shown to users, public files and logs hold
counts only. It moves to Membrane positions when a Membrane Cdp is deployed on a public chain (a later block).

Each hourly run (q26_live_d14.py run):
  chains    Aave V3 core Pools on Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche and BNB Chain. Keyless public
            JSON-RPC endpoints only (no key, no sign-up, no paid data). A chain whose endpoints fail inside its time
            budget is logged STALE for the hour; its state is left unchanged and the other chains continue.
  logs      eth_getLogs from the last processed block (bounded block spans, retries): Pool Borrow (borrower
            discovery), Supply, Withdraw, Repay, LiquidationCall, collateral flag and e-mode events, and aToken
            BalanceTransfer (position actions). Events of a liquidated account inside a liquidation transaction are
            part of the liquidation, not an action.
  accounts  getUserAccountData for every known borrower (Multicall3, 1,000 per call) at one block per chain. Accounts
            with debt >= MIN_DEBT_USD and health factor <= HF_SCREEN (oracle distance <= 15%), and accounts with an
            open or disarmed episode, get a detail read: e-mode, the user configuration bitmap and the current
            aToken / debt-token balances of their reserves. The detail rebuilds the R11.1-v5 quantities (r111v5_labels:
            LT-weighted collateral cLT with the e-mode LT of r10_mechanics.Day.eff, debt units, oracle prices) and the
            distance k* (all non-stable assets move together, stables fixed). A rebuilt health factor that differs
            from Aave's by more than HF_TOL marks the account unresolved for the hour (counted, not banded).
  arms      ORACLE arm (the Aave event): d = -k* against the Aave oracle (Chainlink through the Pool's price oracle),
            recomputed at each check; touch = health factor < 1 at a check. III arm (the Membrane-style event): the
            R11.1-v5 label-B subset (one non-stable collateral with input III, no non-stable debt); line frozen at the
            episode start L = G(c) (1 + k*(c)), G = the 1 h geometric-mean TWAP of Binance 1 m closes (d13_twap);
            d = 1 - L / G(c); touch = an III hour low <= L. Act now: III arm, the last Binance 1 m close <= L; oracle
            arm, the oracle at or through the line (health factor < 1).
  episodes  RULING Q26-R27 per position and arm: an episode opens at the first check with 0 < d <= 10%; "at risk"
            would fire at the first check in the episode with d <= 3%; one alert per episode. Ends: touch, exit
            (d > 10%), act, liquidation, closed (debt below MIN_DEBT_USD). After a touch the position is disarmed until
            it moves > 10% away, acts or is liquidated (the ruling's re-arm rule). A stale chain or a null III value
            pauses the position (no transition), never ends its episode.
  outputs   PRIVATE (membrane-datasets forecasts/q26-borrower-alert/private/): borrower address lists, cursors,
            episode state keyed by an internal hash of chain + address, the would-fire / outcome event log and the
            snapshot membership. Never published. PUBLIC-SAFE (forecasts/q26-borrower-alert/aave-v3/): hourly count
            lines per chain x asset x distance band, would-fire and outcome counts, a hash-chained daily snapshot file
            and ledger. No address, hash or position id appears in a public-safe file or in the job log (tested).

The bootstrap (q26_live_d14.py bootstrap, run once in a cloud session) lists borrowers from Pool Borrow logs since the
Pool deployment. It reads account discovery logs only: no outcome, no liquidation statistic (BNB Chain L1-B and the
CF1/CF2 sets stay unread).
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import gzip  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import sys  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.parse  # noqa: E402
import urllib.request  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import d13_twap as TW  # noqa: E402

HOUR, DAY = 3600, 86400
SCHEMA = "q26-borrower-alert/d14/1"
PREREG = {"repo": "triccs/membrane-board", "path": "design/HISTORY_TOUCH_LIVE.md", "block": "D14",
          "approval": "owner 2026-10-25 on OWNER? Q26-L1: 'Yes: Aave V3 all chains (Recommended)'",
          "rules": "RULING Q26-R27 (60fb0e6), REVIEW Q26-R27 (c59f67f)"}
ROOT_REL = "forecasts/q26-borrower-alert"
PUB_SUB = "aave-v3"
PRIV_SUB = "private"
ZERO_SHA = "0" * 64
UA = "curl/8.5.0"

# --- rule constants (RULING Q26-R27; r27_atrisk.py) -------------------------------------------------------------------
X_BAND = 0.10                 # episode band: d <= 10 %
D_AT_RISK = 0.03              # "at risk" threshold (RULING Q26-R27: 3 %)
BANDS = ((0.0, 0.01), (0.01, 0.02), (0.02, 0.035), (0.035, 0.05), (0.05, 0.10001))   # r27_atrisk.DBK
BAND_NAMES = ("0-1%", "1-2%", "2-3.5%", "3.5-5%", "5-10%")                           # r27_atrisk.DBN
REASONS = ("touch", "exit", "act", "liq", "closed")
SNAP_HORIZONS_H = (6, 12, 24, 168)
# --- account constants (r111v5_labels.py) -----------------------------------------------------------------------------
MIN_DEBT_USD = 100.0          # r111v5_labels.MIN_DEBT
STABLE_SYMS = {"DAI", "USDC", "USDT0", "USDT", "miMATIC", "EURS", "jEUR", "EURA", "agEUR", "USDC.e", "GHO", "LUSD",
               "FRAX"}        # r111v5_labels.STABLE_SYMS (live extensions below are listed separately)
STABLE_SYMS_LIVE = {"DAI.e", "USDt", "USDT.e", "USDbC", "PYUSD", "USDe", "sUSDe", "USDS", "sDAI", "crvUSD", "RLUSD",
                    "FDUSD", "EURC", "USD1", "USDtb", "eUSDe", "syrupUSDT", "syrupUSDC", "USDG", "BUSD", "mUSD",
                    "lisUSD", "frxUSD", "sfrxUSD", "USDf", "sUSDS", "fxUSD", "GHO.e", "mUSDC", "USDC.ARB"}
HF_SCREEN = 1.0 / (1.0 - 0.15)   # 1 - 1/HF <= 15 % <=> oracle distance lower bound <= 15 % (k* >= 1 - 1/HF)
HF_TOL = 0.01                 # rebuilt HF vs Aave HF, relative
# --- input III (live/d13_twap.py) -------------------------------------------------------------------------------------
BINANCE_API = "https://data-api.binance.vision/api/v3/klines"
III_SYMBOL = {"WETH": "ETHUSDT", "WETH.e": "ETHUSDT", "WBTC": "BTCUSDT", "WBTC.e": "BTCUSDT", "BTCB": "BTCUSDT",
              "BTC.b": "BTCUSDT", "cbBTC": "BTCUSDT", "WBNB": "BNBUSDT", "WAVAX": "AVAXUSDT", "LINK": "LINKUSDT",
              "LINK.e": "LINKUSDT", "AAVE": "AAVEUSDT", "AAVE.e": "AAVEUSDT", "UNI": "UNIUSDT"}
KLINE_CLOCK_MARGIN_MS = 5000

# --- chains -----------------------------------------------------------------------------------------------------------
# log: (url, max block span per eth_getLogs); call: eth_call endpoints (Multicall3 aggregate3). Keyless only.
CHAINS = {
    "ethereum": {"pool": "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", "start": 16_291_127, "confirm": 3,
                 "log": [("https://mainnet.gateway.tenderly.co", 50_000), ("https://rpc.mevblocker.io", 50_000),
                         ("https://ethereum-rpc.publicnode.com", 2_000)],
                 "call": ["https://ethereum-rpc.publicnode.com", "https://mainnet.gateway.tenderly.co",
                          "https://eth.drpc.org", "https://rpc.mevblocker.io"]},
    "arbitrum": {"pool": "0x794a61358d6845594f94dc1db02a252b5b4814ad", "start": 7_740_000, "confirm": 20,
                 "log": [("https://arbitrum.gateway.tenderly.co", 500_000), ("https://arb1.arbitrum.io/rpc", 50_000)],
                 # publicnode first: the 2026-10-25 20:13Z runner run went stale on eth_call HTTP errors with the
                 # three endpoints below; every chain that passed on the runner had publicnode first.
                 "call": ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.gateway.tenderly.co",
                          "https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"]},
    "base": {"pool": "0xa238dd80c259a72e81d7e4664a9801593f98d1c5", "start": 2_350_000, "confirm": 10,
             "log": [("https://base-rpc.publicnode.com", 50_000), ("https://base.gateway.tenderly.co", 1_000),
                     ("https://gateway.tenderly.co/public/base", 1_000)],
             "call": ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org",
                      "https://base.gateway.tenderly.co"]},
    "optimism": {"pool": "0x794a61358d6845594f94dc1db02a252b5b4814ad", "start": 4_360_000, "confirm": 10,
                 "log": [("https://optimism.gateway.tenderly.co", 200_000), ("https://optimism-rpc.publicnode.com", 10_000),
                         ("https://mainnet.optimism.io", 10_000)],
                 "call": ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io",
                          "https://optimism.gateway.tenderly.co", "https://optimism.drpc.org"]},
    "polygon": {"pool": "0x794a61358d6845594f94dc1db02a252b5b4814ad", "start": 25_826_028, "confirm": 10, "batch": 250,
                "log": [("https://polygon.gateway.tenderly.co", 100_000), ("https://polygon-bor-rpc.publicnode.com", 10_000)],
                "call": ["https://polygon-bor-rpc.publicnode.com", "https://polygon.gateway.tenderly.co",
                         "https://polygon.drpc.org"]},
    "avalanche": {"pool": "0x794a61358d6845594f94dc1db02a252b5b4814ad", "start": 11_970_506, "confirm": 10,
                  "log": [("https://avalanche.gateway.tenderly.co", 100_000),
                          ("https://avalanche-c-chain-rpc.publicnode.com", 50_000)],
                  "call": ["https://avalanche-c-chain-rpc.publicnode.com", "https://api.avax.network/ext/bc/C/rpc",
                           "https://avalanche.gateway.tenderly.co", "https://avalanche.drpc.org"]},
    "bnb": {"pool": "0x6807dc923806fe8fd134338eabca509979a7e0cb", "start": 33_500_000, "confirm": 15,
            # Keyless BNB logs: publicnode serves only about the last 10k blocks; bloXroute keeps a rolling window of
            # about 7M blocks (probed 2026-10-25). Older history needs a key, so discovery starts at log_depth.
            "log": [("https://bsc.rpc.blxrbdn.com", 5_000), ("https://bsc-rpc.publicnode.com", 5_000),
                    ("https://bsc.publicnode.com", 5_000)], "log_depth": 6_000_000,
            "call": ["https://bsc-rpc.publicnode.com", "https://bsc.publicnode.com", "https://bsc-dataseed.bnbchain.org",
                     "https://bsc.drpc.org"]},
}
CHAIN_ORDER = ("ethereum", "arbitrum", "base", "optimism", "polygon", "avalanche", "bnb")
MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"
ACCT_BATCH = 1000
DETAIL_BATCH = 300
CHAIN_BUDGET_S = 1200         # per chain per run; past it the chain is STALE for the hour
FULL_SCAN_S = 23 * HOUR       # every known borrower is re-read at least once a day (safety net for the active set)
BACKFILL_INTERVAL_S = 0.3     # seconds between backfill requests
BACKFILL_BUDGET_S = 420       # per chain per run, for a chain whose borrower discovery is still partial
MAX_LOG_BLOCKS = {"ethereum": 20_000, "arbitrum": 2_000_000, "base": 200_000, "optimism": 200_000,
                  "polygon": 200_000, "avalanche": 200_000, "bnb": 300_000}   # catch-up cap per run (blocks)

# function selectors and event topics (keccak; checked against r111v3_rpc in the tests)
SEL = {"getUserAccountData": "bf92857c", "getUserConfiguration": "4417a583", "getUserEMode": "eddf1b79",
       "balanceOf": "70a08231", "getReservesList": "d1946dbc", "getReserveData": "35ea6a75",
       "getAssetPrice": "b3596f07", "ADDRESSES_PROVIDER": "0542975c", "getPriceOracle": "fca513a8",
       "decimals": "313ce567", "symbol": "95d89b41", "aggregate3": "82ad56cb",
       "getEModeCategoryCollateralConfig": "b286f467", "getEModeCategoryCollateralBitmap": "b0771dba",
       "getEModeCategoryData": "6c6f6ae1"}
SIGS = {"getUserAccountData": "getUserAccountData(address)", "getUserConfiguration": "getUserConfiguration(address)",
        "getUserEMode": "getUserEMode(address)", "balanceOf": "balanceOf(address)",
        "getReservesList": "getReservesList()", "getReserveData": "getReserveData(address)",
        "getAssetPrice": "getAssetPrice(address)", "ADDRESSES_PROVIDER": "ADDRESSES_PROVIDER()",
        "getPriceOracle": "getPriceOracle()", "decimals": "decimals()", "symbol": "symbol()",
        "aggregate3": "aggregate3((address,bool,bytes)[])",
        "getEModeCategoryCollateralConfig": "getEModeCategoryCollateralConfig(uint8)",
        "getEModeCategoryCollateralBitmap": "getEModeCategoryCollateralBitmap(uint8)",
        "getEModeCategoryData": "getEModeCategoryData(uint8)"}
TOPIC = {"Borrow": "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0",
         "Supply": "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61",
         "Withdraw": "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7",
         "Repay": "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051",
         "LiquidationCall": "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286",
         "CollOn": "0x00058a56ea94653cdf4f152d227ace22d4c00ad99e2a43f58cb7d9e3feb295f2",
         "CollOff": "0x44c58d81365b66dd4b1a7f36c25aa97b8c71c361ee4937adc1a00000227db5dd",
         "EMode": "0xd728da875fc88944cbf17638bcbe4af0eedaef63becd1d1c57cc097eb4608d84",
         "BalanceTransfer": "0x4beccb90f994c31aced7a23b5611020728a23d8ec5cddd1a3e9d97b96fda8666"}
EVENT_SIGS = {"Borrow": "Borrow(address,address,address,uint256,uint8,uint256,uint16)",
              "Supply": "Supply(address,address,address,uint256,uint16)",
              "Withdraw": "Withdraw(address,address,address,uint256)",
              "Repay": "Repay(address,address,address,uint256,bool)",
              "LiquidationCall": "LiquidationCall(address,address,address,uint256,uint256,address,bool)",
              "CollOn": "ReserveUsedAsCollateralEnabled(address,address)",
              "CollOff": "ReserveUsedAsCollateralDisabled(address,address)",
              "EMode": "UserEModeSet(address,uint8)",
              "BalanceTransfer": "BalanceTransfer(address,address,uint256,uint256)"}
# indexed topic position of the account in each Pool event
USER_TOPIC = {"Borrow": 2, "Supply": 2, "Withdraw": 2, "Repay": 2, "LiquidationCall": 3, "CollOn": 2, "CollOff": 2,
              "EMode": 1}
POOL_TOPICS = [TOPIC[k] for k in USER_TOPIC]
EMODE_IDS = range(1, 256)    # uint8 category ids (r111v3_acquire read 1..40; Ethereum core now uses > 40)
ADDR_RE = re.compile(r"0x[0-9a-fA-F]{40}")


class Stale(Exception):
    """A chain's endpoints failed inside its budget: the chain is stale for this run."""


# =====================================================================================================================
# small utilities
# =====================================================================================================================
def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(ts))


def day_of(ts):
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def dumps(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def gz(obj):
    return gzip.compress(dumps(obj), compresslevel=9, mtime=0)


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def write_exclusive(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "xb") as f:
        f.write(data)


def append_line(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "ab") as f:
        f.write(dumps(obj) + b"\n")


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, "rb") as f:
        raw = f.read()
    if path.endswith(".gz"):
        raw = gzip.decompress(raw)
    return json.loads(raw)


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    with open(path, "rb") as f:
        return [json.loads(x) for x in f.read().splitlines() if x.strip()]


def pos_key(chain, addr):
    """Internal position key (PRIVATE; never written to a public-safe file or a log)."""
    return hashlib.sha256(f"{chain}:{addr.lower()}".encode()).hexdigest()[:20]


def assert_public(url):
    """Keyless rule: https, no credentials, no query string, no key-like path segment."""
    p = urllib.parse.urlparse(url)
    if p.scheme != "https" or p.username or p.password or p.query or p.fragment:
        raise SystemExit(f"STOP: endpoint is not a plain public https URL: {p.netloc}")
    for seg in p.path.split("/"):
        if len(seg) >= 24 and re.fullmatch(r"[0-9A-Za-z_\-]+", seg) and re.search(r"\d", seg) \
                and re.search(r"[A-Za-z]", seg):
            raise SystemExit(f"STOP: endpoint path looks like it carries a key: {p.netloc}")


def band_of(d):
    """Index of the R27 distance band holding d (lo <= d < hi), or None (d <= 0 or d > 10 %)."""
    if d is None or not (d > 0.0):
        return None
    for i, (lo, hi) in enumerate(BANDS):
        if lo <= d < hi:
            return i
    return None


def is_stable(sym):
    """r111v5 STABLE_SYMS, the live list, and any symbol naming USD or EUR (USD stables, their PT and staked forms;
    r111v5 already counts EUR stables as fixed)."""
    u = (sym or "").upper()
    return sym in STABLE_SYMS or sym in STABLE_SYMS_LIVE or "USD" in u or "EUR" in u


# =====================================================================================================================
# keyless JSON-RPC
# =====================================================================================================================
def _post(url, payload, timeout):
    req = urllib.request.Request(url, data=payload, headers={"content-type": "application/json", "user-agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


class RangeError(Exception):
    pass


class TooBig(Exception):
    """An eth_call answer or gas need exceeded an endpoint cap: the caller splits the batch."""


class Rpc:
    """Endpoint rotation, bounded retries, a per-run deadline. post(url, payload_bytes, timeout) -> parsed JSON."""

    def __init__(self, chain, cfg, deadline=None, post=None, tries=16, sleep=time.sleep, timeout=45, interval=0.0):
        self.chain = chain
        self.log_eps = [(u, s) for u, s in cfg["log"]]
        self.call_eps = list(cfg["call"])
        for u in [u for u, _ in self.log_eps] + self.call_eps:
            assert_public(u)
        self.deadline = deadline
        self.post = post or _post
        self.tries = tries
        self.sleep = sleep
        self.timeout = timeout
        self.i = 0
        self.lock = threading.Lock()
        self.stats = {"requests": 0, "errors": 0, "logs": 0, "splits": 0}
        self.interval = interval
        self._last = 0.0

    def _pace(self):
        if self.interval <= 0:
            return
        with self.lock:
            now = time.monotonic()
            wait = self._last + self.interval - now
            self._last = max(now, self._last + self.interval)
        if wait > 0:
            self.sleep(wait)

    def _check_deadline(self):
        if self.deadline is not None and time.time() > self.deadline:
            raise Stale("time budget")

    def _one(self, url, method, params):
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        self._pace()
        body = self.post(url, payload, self.timeout)
        with self.lock:
            self.stats["requests"] += 1
        if not isinstance(body, dict):
            raise ValueError("bad response")
        if "error" in body:
            e = body["error"] or {}
            msg = (str(e.get("message", "")) + " " + str(e.get("data", ""))).lower()
            if any(s in msg for s in ("range", "limit", "too many", "more than", "too large", "exceed", "timed out",
                                      "timeout", "response size", "out of gas")):
                raise RangeError(msg[:120])
            raise ValueError(msg[:120])
        return body["result"]

    def call(self, method, params, urls=None):
        urls = urls or self.call_eps
        err = None
        for k in range(self.tries):
            self._check_deadline()
            with self.lock:
                self.i += 1
                url = urls[self.i % len(urls)]
            try:
                return self._one(url, method, params)
            except RangeError as e:
                if method == "eth_call":
                    raise TooBig(str(e)) from None
                err = e
            except urllib.error.HTTPError as e:
                err = e
                # 400 and 413 on a large Multicall: split (bounded at 8 calls). "out of gas" (an endpoint's eth_call
                # gas cap) splits through RangeError above; 2026-10-26 Arbitrum and Avalanche were stale on it.
                if e.code in (400, 413) and method == "eth_call":
                    raise TooBig(str(e.code)) from None
                if e.code == 429:
                    with self.lock:
                        self.stats["errors"] += 1
                    self.sleep(min(3.0 * (k + 1), 20.0))     # rate limited: wait longer, then rotate
                    continue
            except (urllib.error.URLError, OSError, TimeoutError, ValueError, KeyError) as e:
                err = e
            with self.lock:
                self.stats["errors"] += 1
            self.sleep(min(1.0 * 2 ** min(k, 4), 10.0))
        code = getattr(err, "code", None)
        raise Stale(f"{method}: {type(err).__name__}" + (f" {code}" if isinstance(code, int) else ""))

    def head(self):
        return int(self.call("eth_blockNumber", []), 16)

    def logs(self, address, topics, lo, hi):
        """All logs in [lo, hi]. Spans follow each endpoint's cap; a range error halves the span (bounded)."""
        out = []
        b = lo
        ep = 0
        span = self.log_eps[0][1]
        fails = 0
        while b <= hi:
            self._check_deadline()
            url, cap = self.log_eps[ep % len(self.log_eps)]
            s = min(span, cap)
            e = min(hi, b + s - 1)
            flt = {"fromBlock": hex(b), "toBlock": hex(e), "topics": topics}
            if address is not None:
                flt["address"] = address
            try:
                res = self._one(url, "eth_getLogs", [flt])
                if not isinstance(res, list):
                    raise ValueError("logs: not a list")
                out.extend(res)
                with self.lock:
                    self.stats["logs"] += len(res)
                b = e + 1
                fails = 0
                span = min(span * 2, self.log_eps[0][1])
            except RangeError:
                with self.lock:
                    self.stats["splits"] += 1
                if s <= 1:
                    raise Stale("logs: single block too large")
                span = max(1, s // 4)
            except (urllib.error.URLError, OSError, TimeoutError, ValueError, KeyError) as ex:
                with self.lock:
                    self.stats["errors"] += 1
                fails += 1
                ep += 1
                if isinstance(ex, urllib.error.HTTPError) and ex.code in (400, 403, 413):
                    span = max(1, s // 4)
                if fails > 4 * self.tries:
                    code = getattr(ex, "code", None)
                    raise Stale(f"logs: {type(ex).__name__}" + (f" {code}" if isinstance(code, int) else ""))
                self.sleep(min(0.5 * 2 ** min(fails, 5), 10.0))
        out.sort(key=lambda x: (int(x["blockNumber"], 16), int(x["logIndex"], 16)))
        return out

    def aggregate3(self, calls, block):
        """calls: [(target, calldata bytes)] -> [(ok, bytes)] at block (int)."""
        data = aggregate3_data(calls)
        try:
            raw = self.call("eth_call", [{"to": MULTICALL3, "data": data}, hex(block)])
        except TooBig:
            if len(calls) <= 8:
                raise Stale("aggregate3: too big") from None
            with self.lock:
                self.stats["splits"] += 1
            h = len(calls) // 2
            return self.aggregate3(calls[:h], block) + self.aggregate3(calls[h:], block)
        out = aggregate3_decode(raw)
        if len(out) != len(calls):
            raise Stale("aggregate3: length")
        return out


def enc_addr(a):
    return bytes(12) + bytes.fromhex(a[2:].lower())


def enc_u(n):
    return int(n).to_bytes(32, "big")


def sel(name):
    return bytes.fromhex(SEL[name])


def aggregate3_data(calls):
    n = len(calls)
    parts = []
    for tgt, data in calls:
        pad = data + bytes((32 - len(data) % 32) % 32)
        parts.append(enc_addr(tgt) + enc_u(1) + enc_u(96) + enc_u(len(data)) + pad)
    offs, pos = [], 32 * n
    for p in parts:
        offs.append(pos)
        pos += len(p)
    body = enc_u(32) + enc_u(n) + b"".join(enc_u(o) for o in offs) + b"".join(parts)
    return "0x" + (sel("aggregate3") + body).hex()


def aggregate3_decode(raw):
    raw = bytes.fromhex(raw[2:])
    w = lambda p: int.from_bytes(raw[p:p + 32], "big")  # noqa: E731
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


def topic_addr(t):
    return "0x" + t[-40:].lower()


# =====================================================================================================================
# Aave reads
# =====================================================================================================================
def decode_conf(c):
    """r10_mechanics.decode_conf (ReserveConfiguration bit layout)."""
    return {"lt": (c >> 16) & 0xFFFF, "lb": (c >> 32) & 0xFFFF, "dec": (c >> 48) & 0xFF, "fee": (c >> 152) & 0xFFFF,
            "emode_cat": (c >> 168) & 0xFF}


def decode_symbol(b):
    try:
        if len(b) >= 96:
            return b[64:64 + word(b, 1)].decode("utf-8", "replace")
        return b.rstrip(b"\0").decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return "?"


def read_market(rpc, cfg, block, cache=None):
    """Reserves (config, id, tokens, decimals, symbol), oracle prices (base 1e8) and e-mode categories at block."""
    pool = cfg["pool"]
    r = rpc.aggregate3([(pool, sel("getReservesList")), (pool, sel("ADDRESSES_PROVIDER"))], block)
    lst = r[0][1]
    n = word(lst, 1)
    assets = [as_addr(word(lst, 2 + i)) for i in range(n)]
    provider = as_addr(word(r[1][1]))
    oracle = as_addr(word(rpc.aggregate3([(provider, sel("getPriceOracle"))], block)[0][1]))
    calls = []
    for a in assets:
        calls += [(pool, sel("getReserveData") + enc_addr(a)), (oracle, sel("getAssetPrice") + enc_addr(a))]
    need_meta = [a for a in assets if not (cache and a in cache)]
    for a in need_meta:
        calls += [(a, sel("decimals")), (a, sel("symbol"))]
    res = rpc.aggregate3(calls, block)
    meta = dict(cache or {})
    for j, a in enumerate(need_meta):
        q = 2 * n + 2 * j
        meta[a] = {"dec": word(res[q][1]), "symbol": decode_symbol(res[q + 1][1])}
    R = {}
    for j, a in enumerate(assets):
        rd = res[2 * j][1]
        conf = word(rd, 0)
        R[a] = {"config": conf, "id": word(rd, 7), "aToken": as_addr(word(rd, 8)), "sDebt": as_addr(word(rd, 9)),
                "vDebt": as_addr(word(rd, 10)), "price": word(res[2 * j + 1][1]) if res[2 * j + 1][0] else None,
                "dec": meta[a]["dec"], "symbol": meta[a]["symbol"]}
    return {"block": block, "oracle": oracle, "assets": assets, "reserves": R, "emode": read_emode(rpc, pool, block),
            "meta": meta}


def read_emode(rpc, pool, block):
    """r111v3_acquire.emode_read: v3.2+ collateral config and bitmap, else the legacy category data."""
    calls = []
    for c in EMODE_IDS:
        calls += [(pool, sel("getEModeCategoryCollateralConfig") + enc_u(c)),
                  (pool, sel("getEModeCategoryCollateralBitmap") + enc_u(c)),
                  (pool, sel("getEModeCategoryData") + enc_u(c))]
    res = []
    for q in range(0, len(calls), 255):
        res += rpc.aggregate3(calls[q:q + 255], block)
    out = {}
    for j, c in enumerate(EMODE_IDS):
        r1, r2, r3 = res[3 * j], res[3 * j + 1], res[3 * j + 2]
        if r1[0] and len(r1[1]) == 96 and r2[0]:
            w = [word(r1[1], i) for i in range(3)]
            if w[1] > 0:
                out[str(c)] = {"layout": "v32", "ltv": w[0], "lt": w[1], "lb": w[2], "bitmap": word(r2[1])}
        elif r3[0] and len(r3[1]) >= 160:
            w = [word(r3[1], i) for i in range(5)]
            if w and w[0] == 32:
                w = w[1:]
            if len(w) >= 4 and w[1] > 0:
                out[str(c)] = {"layout": "legacy", "ltv": w[0], "lt": w[1], "lb": w[2], "bitmap": None}
    return out


def eff_lt(market, emode):
    """Effective LT per asset for a user e-mode id (r10_mechanics.Day._eff_compute)."""
    out = {}
    e = market["emode"].get(str(int(emode))) if emode else None
    for a, r in market["reserves"].items():
        c = decode_conf(int(r["config"]))
        lt = c["lt"] / 1e4
        if e:
            inside = ((e["bitmap"] >> int(r["id"])) & 1) if e["layout"] == "v32" else (c["emode_cat"] == int(emode))
            if inside:
                lt = e["lt"] / 1e4
        out[a] = lt
    return out


def scan_accounts(rpc, pool, addrs, block, batch=ACCT_BATCH, workers=2):
    """getUserAccountData for addrs -> list of (collateralBase, debtBase, avgLT bps, hf 1e18) or None (failed call)."""
    chunks = [addrs[i:i + batch] for i in range(0, len(addrs), batch)]

    def one(ch):
        res = rpc.aggregate3([(pool, sel("getUserAccountData") + enc_addr(a)) for a in ch], block)
        return [(word(b, 0), word(b, 1), word(b, 3), word(b, 5)) if ok and len(b) >= 192 else None for ok, b in res]

    out = []
    with ThreadPoolExecutor(workers) as ex:
        for r in ex.map(one, chunks):
            out.extend(r)
    return out


def read_details(rpc, market, pool, addrs, block, batch=DETAIL_BATCH):
    batch = min(batch, 120)
    """Per account: e-mode id and balances {asset: (collateral raw, debt raw, collateral flag)} from the user
    configuration bitmap (bit 2 i borrowing, bit 2 i + 1 collateral of reserve id i)."""
    by_id = {int(r["id"]): a for a, r in market["reserves"].items()}
    out = {}
    for i in range(0, len(addrs), batch):
        ch = addrs[i:i + batch]
        calls = []
        for a in ch:
            calls += [(pool, sel("getUserConfiguration") + enc_addr(a)), (pool, sel("getUserEMode") + enc_addr(a))]
        res = rpc.aggregate3(calls, block)
        need = []
        cfgs = {}
        for j, a in enumerate(ch):
            okc, bc = res[2 * j]
            oke, be = res[2 * j + 1]
            if not okc:
                continue
            bm = word(bc) or 0
            em = word(be) if oke else 0
            cfgs[a] = (bm, em or 0)
            k = 0
            while bm >> (2 * k):
                rid_a = by_id.get(k)
                if rid_a is not None:
                    r = market["reserves"][rid_a]
                    if (bm >> (2 * k + 1)) & 1:
                        need.append((a, rid_a, "c", r["aToken"]))
                    if (bm >> (2 * k)) & 1:
                        need.append((a, rid_a, "v", r["vDebt"]))
                        if r["sDebt"] and int(r["sDebt"], 16):
                            need.append((a, rid_a, "s", r["sDebt"]))
                k += 1
        bal = {}
        for q in range(0, len(need), 400):
            part = need[q:q + 400]
            rr = rpc.aggregate3([(tok, sel("balanceOf") + enc_addr(a)) for a, _, _, tok in part], block)
            for (a, asset, kind, _), (ok, b) in zip(part, rr):
                v = word(b) if ok else 0
                d = bal.setdefault(a, {}).setdefault(asset, [0, 0])
                if kind == "c":
                    d[0] += v or 0
                else:
                    d[1] += v or 0
        for a, (bm, em) in cfgs.items():
            out[a] = {"emode": em, "bal": bal.get(a, {})}
    return out


def position_metrics(market, det):
    """R11.1-v5 quantities for one account (r111v5_labels.cmd_labels): cLT, debt units, prices -> hf, k*, label-B."""
    lt = eff_lt(market, det["emode"])
    Cst = Cv = Dst = Dv = 0.0
    coll_usd = debt_usd = 0.0
    vol_c, vol_d, stab_c = {}, {}, 0.0
    missing_price = False
    for a, (craw, draw) in det["bal"].items():
        r = market["reserves"][a]
        if r["price"] is None or not r["price"]:
            if craw or draw:
                missing_price = True
            continue
        px = r["price"] / 1e8
        unit = 10.0 ** int(r["dec"])
        st = is_stable(r["symbol"])
        if craw and lt[a] > 0:
            v = craw / unit * lt[a] * px                 # cLT x price (collateral flag set by construction)
            coll_usd += v
            if st:
                Cst += v
                stab_c += v
            else:
                Cv += v
                vol_c[r["symbol"]] = vol_c.get(r["symbol"], 0.0) + v
        if draw:
            v = draw / unit * px
            debt_usd += v
            if st:
                Dst += v
            else:
                Dv += v
                vol_d[r["symbol"]] = vol_d.get(r["symbol"], 0.0) + v
    hf = coll_usd / debt_usd if debt_usd > 0 else math.inf
    kstar = kstar_value(Cst, Cv, Dst, Dv)
    asset = max(vol_c, key=vol_c.get) if vol_c else "stable-only"
    single = None
    if len(vol_c) == 1 and not vol_d:
        single = next(iter(vol_c))
    return {"hf": hf, "kstar": kstar, "debt_usd": debt_usd, "asset": asset, "single": single,
            "missing_price": missing_price, "n_vol": len(vol_c)}


def kstar_value(Cst, Cv, Dst, Dv):
    """r111v5_labels k*: kstar = (Dst + Dv - Cst - Cv) / (Cv - Dv) when Cv - Dv > 0, else None (no downside line).
    Negative k* = the fractional move of every non-stable price that brings HF to 1."""
    if not (Cv - Dv > 0):
        return None
    return (Dst + Dv - Cst - Cv) / (Cv - Dv)


# =====================================================================================================================
# input III (hourly)
# =====================================================================================================================
def fetch_m1(sym, start_ms, now_ms, http_get=None):
    """Closed 1 m klines of sym from start_ms (inclusive) up to now -> {open_ms: close float}."""
    get = http_get or (lambda u: urllib.request.urlopen(urllib.request.Request(u, headers={"user-agent": UA}),
                                                         timeout=30).read())
    out = {}
    t = start_ms
    for _ in range(4):
        url = f"{BINANCE_API}?symbol={sym}&interval=1m&startTime={t}&limit=1000"
        data = None
        for k in range(4):
            try:
                data = json.loads(get(url))
                break
            except (urllib.error.URLError, OSError, TimeoutError, ValueError):
                time.sleep(1 + 2 * k)
        if not isinstance(data, list):
            raise ValueError(f"binance {sym}: no data")
        batch = 0
        for k in data:
            o, c = int(k[0]), int(k[6])
            if c + KLINE_CLOCK_MARGIN_MS >= now_ms or o % 60000:
                continue
            out[o] = float(k[4])
            batch += 1
        if len(data) < 1000:
            break
        t = int(data[-1][0]) + 60000
    return out


def iii_bars(m1, h0, h1):
    """III hour bars for hours opening h0 .. h1 - 1 h (seconds), from 1 m closes starting 59 minutes before h0 so the
    first hour's TWAP windows are full. -> {hour_open: (low, high, close)} with None for null values."""
    t0 = h0 - HOUR
    n = (h1 - t0) // 60
    closes = [m1.get((t0 + 60 * j) * 1000) for j in range(n)]
    lo, hi, cl = TW.bars_from_closes(closes)
    out = {}
    for j in range(1, len(cl)):
        out[t0 + HOUR * j] = (lo[j], hi[j], cl[j])
    return out


# =====================================================================================================================
# episode state machine (pure; unit-tested)
# =====================================================================================================================
def step_episode(st, c, d, touched, acted, liquidated, closed, line=None, spot_through=False):
    """One check of one position and arm. st: None (armed) or dict (status 'open' or 'disarmed'). c: check time. d:
    distance at c (None = unknown: pause). touched: a touch since the previous check (III: an hour low <= L; oracle:
    HF < 1 at c). acted / liquidated: an action / liquidation since the previous check. closed: debt below the minimum.
    line: the line to freeze if an episode opens here (III arm). Returns (new state, events list)."""
    ev = []
    if st is not None and st["status"] == "open":
        reason = None
        if liquidated:
            reason = "liq"
        elif acted:
            reason = "act"
        elif closed:
            reason = "closed"
        elif touched:
            reason = "touch"
        if reason:
            ev.append(("end", reason, st))
            if reason == "touch":
                if not st.get("actnow"):
                    ev.append(("actnow", st))
                return {"status": "disarmed", "since": c}, ev
            return None, ev
        if d is None:
            return st, ev
        if d > X_BAND:
            ev.append(("end", "exit", st))
            return None, ev
        if spot_through and not st.get("actnow"):
            st = dict(st, actnow=c)
            ev.append(("actnow", st))
        if d <= D_AT_RISK and not st.get("alert"):
            st = dict(st, alert=c, d_alert=d)
            ev.append(("atrisk", st))
        return st, ev
    if st is not None and st["status"] == "disarmed":
        if liquidated or acted or closed:
            return None, ev
        if d is not None and d > X_BAND:
            return None, ev
        return st, ev
    # armed
    if closed or d is None or touched:
        return None, ev
    if 0.0 < d <= X_BAND:
        st = {"status": "open", "start": c, "d_start": d}
        if line is not None:
            st["L"] = line
        ev.append(("open", st))
        if spot_through:
            st = dict(st, actnow=c)
            ev.append(("actnow", st))
        if d <= D_AT_RISK:
            st = dict(st, alert=c, d_alert=d)
            ev.append(("atrisk", st))
    return st, ev


# =====================================================================================================================
# private store
# =====================================================================================================================
def priv_dir(root, chain):
    return os.path.join(root, ROOT_REL, PRIV_SUB, chain)


def pub_dir(root):
    return os.path.join(root, ROOT_REL, PUB_SUB)


def load_addresses(root, chain):
    """Borrower addresses in discovery order: the bootstrap file, then the monthly append files."""
    d = priv_dir(root, chain)
    out = []
    bp = os.path.join(d, "addresses-bootstrap.txt.gz")
    if os.path.exists(bp):
        with open(bp, "rb") as f:
            out = gzip.decompress(f.read()).decode().split()
    ad = os.path.join(d, "addresses")
    if os.path.isdir(ad):
        for n in sorted(os.listdir(ad)):
            if n.endswith(".txt"):
                with open(os.path.join(ad, n)) as f:
                    out += f.read().split()
    return out


def append_addresses(root, chain, addrs, ts):
    if not addrs:
        return
    p = os.path.join(priv_dir(root, chain), "addresses", time.strftime("%Y-%m", time.gmtime(ts)) + ".txt")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a") as f:
        f.write("".join(a + "\n" for a in addrs))


def load_state(root, chain):
    """Episode state lines: {key, arm, ...}. Plain sorted JSON lines (small hourly git deltas)."""
    p = os.path.join(priv_dir(root, chain), "state.jsonl")
    out = {}
    for r in read_jsonl(p):
        out[(r.pop("key"), r.pop("arm"))] = r
    return out


def read_active(d):
    p = os.path.join(d, "active.txt")
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return [int(x) for x in f.read().split()]


def write_active(d, idx):
    write_atomic(os.path.join(d, "active.txt"), "".join(f"{i}\n" for i in sorted(idx)).encode())


def save_state(root, chain, state):
    lines = [dumps(dict(v, key=k, arm=arm)) for (k, arm), v in sorted(state.items())]
    write_atomic(os.path.join(priv_dir(root, chain), "state.jsonl"), b"".join(x + b"\n" for x in lines))


# =====================================================================================================================
# bootstrap (one-time, cloud session)
# =====================================================================================================================
def bootstrap(a):
    chain = a.chain
    cfg = CHAINS[chain]
    rpc = Rpc(chain, cfg, tries=8, timeout=60, interval=float(a.interval))
    work = os.path.join(a.work, chain)
    os.makedirs(work, exist_ok=True)
    head_p = os.path.join(work, "head.json")
    if os.path.exists(head_p):
        head = read_json(head_p)["end"]
    else:
        head = rpc.head() - cfg["confirm"]
        write_atomic(head_p, dumps({"end": head, "at": int(time.time())}))
    span = int(a.span or cfg["log"][0][1])
    starts = list(range(cfg["start"], head + 1, span))
    t0 = time.time()
    lock = threading.Lock()
    done = [0]

    def one(s):
        p = os.path.join(work, f"part-{s:012d}.txt.gz")
        if os.path.exists(p):
            return
        lg = rpc.logs(cfg["pool"], [TOPIC["Borrow"]], s, min(s + span - 1, head))
        seen, order = set(), []
        for x in lg:
            u = topic_addr(x["topics"][2])
            if u not in seen:
                seen.add(u)
                order.append(u)
        write_atomic(p, gzip.compress(("\n".join(order) + "\n").encode() if order else b"", mtime=0))
        with lock:
            done[0] += 1
            if done[0] % 50 == 0:
                print(f"{chain}: {done[0]} of {len(starts)} chunks, {time.time() - t0:.0f}s", flush=True)

    with ThreadPoolExecutor(int(a.workers)) as ex:
        list(ex.map(one, starts))
    seen, order = set(), []
    for s in starts:
        with open(os.path.join(work, f"part-{s:012d}.txt.gz"), "rb") as f:
            for u in gzip.decompress(f.read()).decode().split():
                if u not in seen:
                    seen.add(u)
                    order.append(u)
    blob = gzip.compress(("\n".join(order) + "\n").encode(), compresslevel=9, mtime=0)
    d = priv_dir(a.out, chain)
    os.makedirs(d, exist_ok=True)
    write_atomic(os.path.join(d, "addresses-bootstrap.txt.gz"), blob)
    meta = {"schema": SCHEMA, "chain": chain, "pool": cfg["pool"], "fromBlock": cfg["start"], "toBlock": head,
            "borrowers": len(order), "sha256": sha256_bytes(blob), "builtAt": int(time.time()),
            "what": "unique Borrow onBehalfOf accounts in first-seen order (account discovery only, no outcome)"}
    write_atomic(os.path.join(d, "bootstrap.json"), dumps(meta))
    write_atomic(os.path.join(d, "cursor.json"), dumps({"block": head, "at": int(time.time())}))
    print(f"d14 bootstrap {chain}: {len(order)} borrowers, blocks {cfg['start']}..{head}, "
          f"{time.time() - t0:.0f}s, rpc {rpc.stats}", flush=True)


# =====================================================================================================================
# hourly run
# =====================================================================================================================
def safe_sym(sym, rid):
    """Token symbols go into public-safe counts; anything that is not a short plain symbol becomes 'reserve<id>'."""
    if not isinstance(sym, str) or not re.fullmatch(r"[A-Za-z0-9.\-_+]{1,32}", sym) or ADDR_RE.search(sym):
        return f"reserve{rid}"
    return sym


def parse_logs(pool_logs, bt_logs):
    """-> (borrow accounts in order, acted accounts, liquidated accounts, liquidation count). Events of the liquidated
    account inside a liquidation transaction belong to the liquidation."""
    liq_tx = {}
    for x in pool_logs:
        if x["topics"] and x["topics"][0] == TOPIC["LiquidationCall"]:
            liq_tx.setdefault(x["transactionHash"], set()).add(topic_addr(x["topics"][3]))
    borrows, acted, liq = [], set(), set()
    n_liq = 0
    name = {v: k for k, v in TOPIC.items()}
    for x in pool_logs:
        k = name.get(x["topics"][0]) if x["topics"] else None
        if k not in USER_TOPIC or len(x["topics"]) <= USER_TOPIC[k]:
            continue
        u = topic_addr(x["topics"][USER_TOPIC[k]])
        if k == "LiquidationCall":
            liq.add(u)
            n_liq += 1
            continue
        if k == "Borrow":
            borrows.append(u)
        if u in liq_tx.get(x["transactionHash"], ()):
            continue
        acted.add(u)
    for x in bt_logs:
        if len(x["topics"]) < 3 or x["topics"][0] != TOPIC["BalanceTransfer"]:
            continue
        for t in (x["topics"][1], x["topics"][2]):
            u = topic_addr(t)
            if u not in liq_tx.get(x["transactionHash"], ()):
                acted.add(u)
    return borrows, acted, liq, n_liq


def chain_pass(root, chain, cfg, deadline, watch_keys, rpc=None, log=print):
    """Logs, account scan and detail reads of one chain. Returns a result dict (private: holds keys, never logged)."""
    t0 = time.time()
    rpc = rpc or Rpc(chain, cfg, deadline=deadline)
    d = priv_dir(root, chain)
    cur = read_json(os.path.join(d, "cursor.json"))
    if cur is None:
        return {"status": "pending", "why": "no bootstrap"}
    head = rpc.head() - cfg["confirm"]
    lo = int(cur["block"]) + 1
    hi = min(head, lo + MAX_LOG_BLOCKS[chain] - 1)
    if hi < lo:
        hi = lo - 1
    market = read_market(rpc, cfg, hi)
    pool_logs = rpc.logs(cfg["pool"], [POOL_TOPICS], lo, hi) if hi >= lo else []
    atoks = sorted({r["aToken"] for r in market["reserves"].values() if r["aToken"]})
    bt_logs = rpc.logs(atoks, [TOPIC["BalanceTransfer"]], lo, hi) if hi >= lo else []
    borrows, acted, liq, n_liq = parse_logs(pool_logs, bt_logs)
    addrs = load_addresses(root, chain)
    index = {a: i for i, a in enumerate(addrs)}
    new = []
    for u in borrows:
        if u not in index:
            index[u] = len(addrs)
            addrs.append(u)
            new.append(u)
    # Debt arises only through Borrow, so an account with no debt at its last scan is skipped until it borrows again
    # (Borrow logs) or until the daily full rescan (FULL_SCAN_S after the last one).
    active = read_active(d)
    full = active is None or (time.time() - float(cur.get("lastFull", 0)) >= FULL_SCAN_S)
    if full:
        scan_idx = list(range(len(addrs)))
    else:
        extra = {index[u] for u in borrows if u in index}
        scan_idx = sorted(set(active) | extra)
    scan_addrs = [addrs[i] for i in scan_idx]
    acct = scan_accounts(rpc, cfg["pool"], scan_addrs, hi, batch=cfg.get("batch", ACCT_BATCH))
    blk = rpc.call("eth_getBlockByNumber", [hex(hi), False])
    bts = int(blk["timestamp"], 16)
    failed = sum(1 for r in acct if r is None)
    new_active = [i for i, r in zip(scan_idx, acct) if r is None or (r[1] or 0) > 0]
    pos = {}
    screen = []
    for a, r in zip(scan_addrs, acct):
        if r is None:
            continue
        coll, debt, lt_bps, hf = r
        if debt is None or debt / 1e8 < MIN_DEBT_USD:
            continue
        k = pos_key(chain, a)
        pos[k] = {"debt_base": debt / 1e8, "hf_aave": hf / 1e18}
        if hf / 1e18 <= HF_SCREEN or k in watch_keys:
            screen.append((a, k))
    det = read_details(rpc, market, cfg["pool"], [a for a, _ in screen], hi) if screen else {}
    unresolved = 0
    for a, k in screen:
        m = det.get(a)
        if m is None:
            pos[k]["unresolved"] = True
            unresolved += 1
            continue
        pm = position_metrics(market, m)
        hfa = pos[k]["hf_aave"]
        ok = (not pm["missing_price"]) and math.isfinite(pm["hf"]) and abs(pm["hf"] / hfa - 1.0) <= HF_TOL
        rid = {r["symbol"]: r["id"] for r in market["reserves"].values()}
        pos[k].update({"d": (None if pm["kstar"] is None else -pm["kstar"]), "kstar": pm["kstar"],
                       "asset": safe_sym(pm["asset"], rid.get(pm["asset"], "x")) if pm["asset"] != "stable-only"
                       else "stable-only",
                       "single": pm["single"], "hf": pm["hf"], "debt_usd": pm["debt_usd"], "detail": True})
        if not ok:
            pos[k]["unresolved"] = True
            unresolved += 1
    keyed = lambda s: {pos_key(chain, u) for u in s if u in index}  # noqa: E731
    bf = backfill_step(rpc, chain, cfg, d, index, addrs, new, deadline, head=head)
    return {"status": "ok", "backfill": bf, "active": new_active, "fullScan": full, "scanned": len(scan_idx), "block": hi, "head": head, "blockTs": bts, "lo": lo, "lagBlocks": head - hi,
            "positions": pos, "acted": keyed(acted), "liq": keyed(liq), "nLiq": n_liq, "newAddrs": new,
            "borrowers": len(addrs), "failedCalls": failed, "screened": len(screen), "unresolved": unresolved,
            "logs": len(pool_logs) + len(bt_logs), "sec": round(time.time() - t0, 1), "rpc": dict(rpc.stats)}


def backfill_step(rpc, chain, cfg, d, index, addrs, new, deadline, budget=None, head=None):
    """Borrower discovery still partial (backfill.json next <= end): scan Borrow logs forward from next inside the
    budget. New accounts are appended (scanned from the next run). Never makes the chain stale. -> public summary.
    A chain with cfg log_depth has no keyless logs older than head - log_depth: that range is recorded as unreachable
    (disclosed in the summary), never silently treated as scanned."""
    bp = os.path.join(d, "backfill.json")
    bf = read_json(bp)
    if not bf or bf["next"] > bf["end"]:
        return None if not bf else {"complete": True, **({"unreachableBlocks": unreachable(bf)} if bf and
                                                            bf.get("unreachable") else {})}
    depth = cfg.get("log_depth")
    if depth and head is not None and bf["next"] < head - depth:
        floor = min(head - depth, bf["end"] + 1)
        bf.setdefault("unreachable", []).append([bf["next"], floor - 1])
        bf["next"] = floor
    budget = BACKFILL_BUDGET_S if budget is None else budget
    stop = min(deadline or math.inf, time.time() + budget)
    old_deadline, old_interval = rpc.deadline, rpc.interval
    rpc.deadline = stop
    rpc.interval = max(rpc.interval, BACKFILL_INTERVAL_S)     # paced: the backfill must not crowd shared endpoints
    span = int(bf.get("chunk", 50_000))
    found = 0
    try:
        while bf["next"] <= bf["end"] and time.time() < stop:
            e = min(bf["end"], bf["next"] + span - 1)
            lg = rpc.logs(cfg["pool"], [TOPIC["Borrow"]], bf["next"], e)
            for x in lg:
                u = topic_addr(x["topics"][2])
                if u not in index:
                    index[u] = len(addrs)
                    addrs.append(u)
                    new.append(u)
                    found += 1
            bf["next"] = e + 1
    except Stale:
        pass
    finally:
        rpc.deadline, rpc.interval = old_deadline, old_interval
    bf["updatedAt"] = int(time.time())
    write_atomic(bp, dumps(bf))
    total = max(bf["end"] - bf["start"] + 1, 1)
    out = {"complete": bf["next"] > bf["end"], "found": found,
           "doneShare": round(min(1.0, (bf["next"] - bf["start"]) / total), 4)}
    if bf.get("unreachable"):
        out["unreachableBlocks"] = unreachable(bf)
    return out


def unreachable(bf):
    return sum(b - a + 1 for a, b in bf.get("unreachable", []))


def init_chain(a):
    """Start a chain whose bootstrap could not finish in the session: forward logging from the head now, and an
    in-job backfill of borrower discovery from the Pool deployment (or from a seed: the contiguous local bootstrap
    parts, their accounts kept)."""
    chain = a.chain
    cfg = CHAINS[chain]
    d = priv_dir(a.out, chain)
    if os.path.exists(os.path.join(d, "cursor.json")):
        raise SystemExit(f"STOP: {chain} already initialised")
    rpc = Rpc(chain, cfg, tries=8, timeout=60)
    head = rpc.head() - cfg["confirm"]
    start, seen, order = cfg["start"], set(), []
    span = int(a.span or 50_000)
    if a.seed:
        hp = read_json(os.path.join(a.seed, "head.json"))
        s = cfg["start"]
        while True:
            p = os.path.join(a.seed, f"part-{s:012d}.txt.gz")
            if not os.path.exists(p) or s > hp["end"]:
                break
            with open(p, "rb") as f:
                for u in gzip.decompress(f.read()).decode().split():
                    if u not in seen:
                        seen.add(u)
                        order.append(u)
            s += int(a.seed_span)
        start = s
    blob = gzip.compress(("\n".join(order) + "\n").encode() if order else b"", compresslevel=9, mtime=0)
    os.makedirs(d, exist_ok=True)
    write_atomic(os.path.join(d, "addresses-bootstrap.txt.gz"), blob)
    meta = {"schema": SCHEMA, "chain": chain, "pool": cfg["pool"], "fromBlock": cfg["start"],
            "toBlock": start - 1, "borrowers": len(order), "sha256": sha256_bytes(blob), "builtAt": int(time.time()),
            "partial": True, "backfill": {"start": start, "end": head},
            "what": "unique Borrow onBehalfOf accounts (account discovery only, no outcome); the rest of the history "
                    "is scanned by the hourly job (backfill.json)"}
    write_atomic(os.path.join(d, "bootstrap.json"), dumps(meta))
    write_atomic(os.path.join(d, "backfill.json"), dumps({"start": start, "next": start, "end": head, "chunk": span}))
    write_atomic(os.path.join(d, "cursor.json"), dumps({"block": head, "at": int(time.time())}))
    print(f"d14 init {chain}: {len(order)} seeded borrowers, backfill {start}..{head}")


def empty_counts():
    return {"n": [0] * len(BANDS), "debt": [0.0] * len(BANDS)}


def run_hour(a, log=print, now=None, http_get=None, rpc_factory=None, chains=None):
    """One hourly run. Writes the private state and the public-safe counts under a.out."""
    now = int(now or time.time())
    c = now - now % HOUR
    root = a.out
    pdir = pub_dir(root)
    runs_p = os.path.join(root, ROOT_REL, PRIV_SUB, "runs.jsonl")
    runs = read_jsonl(runs_p)
    if runs and runs[-1]["c"] >= c:
        log(f"d14 run: none (hour {iso(c)} already checked)")
        return 0
    chains = chains or CHAIN_ORDER
    states = {ch: load_state(root, ch) for ch in chains}
    snap_p = os.path.join(root, ROOT_REL, PRIV_SUB, "snap-pending.jsonl")
    snap = read_jsonl(snap_p)
    watch = {ch: {k for (k, _) in states[ch]} | {r["key"] for r in snap if r["chain"] == ch} for ch in chains}
    deadline = time.time() + CHAIN_BUDGET_S
    res = {}

    def one(ch):
        try:
            rpc = rpc_factory(ch, deadline) if rpc_factory else None
            return ch, chain_pass(root, ch, CHAINS[ch], deadline, watch[ch], rpc=rpc, log=log)
        except Stale as e:
            return ch, {"status": "stale", "why": str(e)[:60]}
        except Exception as e:  # noqa: BLE001  -- a chain never crashes the job
            return ch, {"status": "stale", "why": f"error {type(e).__name__}"}

    with ThreadPoolExecutor(len(chains)) as ex:
        for ch, r in ex.map(one, chains):
            res[ch] = r
    # --- input III -----------------------------------------------------------------------------------------------
    syms = set()
    for ch in chains:
        r = res[ch]
        if r["status"] == "ok":
            for p in r["positions"].values():
                if p.get("single") in III_SYMBOL and p.get("d") is not None and p["d"] <= X_BAND + 0.05:
                    syms.add(III_SYMBOL[p["single"]])
        for (k, arm), st in states[ch].items():
            if arm == "iii":
                syms.add(st["sym"])
    for r in snap:
        if r["arm"] == "iii":
            syms.add(r["sym"])
    lcs = [st.get("lc", c - HOUR) for ch in chains for st in states[ch].values()] + [r.get("lc", c - HOUR) for r in snap]
    h_from = max(min(lcs + [c - HOUR]), c - 24 * HOUR)
    iii = {}
    iii_fail = []
    for s in sorted(syms):
        try:
            m1 = fetch_m1(s, (h_from - HOUR) * 1000, now * 1000, http_get=http_get)
            bars = iii_bars(m1, h_from, c)
            last = max(m1) if m1 else None
            iii[s] = {"bars": bars, "G": bars.get(c - HOUR, (None, None, None))[2],
                      "spot": (m1[last] if last is not None and last >= (now - 300) * 1000 else None)}
        except (OSError, ValueError, TimeoutError) as e:  # noqa: PERF203
            iii_fail.append(s)
            iii[s] = None
            log(f"d14 iii: {s} failed ({type(e).__name__})")

    def iii_touched(sym, L, since):
        g = iii.get(sym)
        if g is None:
            return None
        lows = [g["bars"].get(h, (None,))[0] for h in range(max(since, h_from), c, HOUR)]
        if any(x is None for x in lows):
            return None if not any(x is not None and x <= L for x in lows) else True
        return any(x <= L for x in lows)

    # --- episodes ------------------------------------------------------------------------------------------------
    pub = {"schema": SCHEMA, "c": c, "runAt": now, "chains": {}}
    priv_events = []
    for ch in chains:
        r = res[ch]
        line = {"status": r["status"]}
        if r["status"] == "ok":
            line["coldStart"] = not any(x["chains"].get(ch) == "ok" for x in runs)
        if r["status"] != "ok":
            line["why"] = r.get("why", "")
            pub["chains"][ch] = line
            continue
        P = r["positions"]
        st_old = states[ch]
        st_new = {}
        bands = {"oracle": {}, "iii": {}}
        through = {"oracle": 0, "iii": 0}
        evc = {"oracle": {}, "iii": {}}

        def bump(arm, asset, what, n=1):
            dct = evc[arm].setdefault(asset, {})
            dct[what] = dct.get(what, 0) + n

        keys = set(P) | {k for (k, _) in st_old}
        for k in keys:
            p = P.get(k)
            closed = p is None
            acted = k in r["acted"]
            liq = k in r["liq"]
            unresolved = bool(p and p.get("unresolved"))
            # oracle arm
            st = st_old.get((k, "oracle"))
            d_or = None if (p is None or unresolved or not p.get("detail")) else p.get("d")
            if p is not None and not p.get("detail") and st is None:
                d_or = None
            asset = (p or {}).get("asset") or (st or {}).get("asset") or "?"
            if p is not None and p.get("detail") and not unresolved:
                b = band_of(d_or)
                if b is not None:
                    cc = bands["oracle"].setdefault(asset, empty_counts())
                    cc["n"][b] += 1
                    cc["debt"][b] += p["debt_usd"]
                elif d_or is not None and d_or <= 0:
                    through["oracle"] += 1
            if st is not None or (d_or is not None and 0 < d_or <= X_BAND):
                touched = d_or is not None and d_or <= 0
                if unresolved and st is not None and not (closed or acted or liq):
                    new, ev = st, []
                else:
                    new, ev = step_episode(st, c, d_or, touched, acted, liq, closed,
                                           spot_through=touched)
                for e in ev:
                    priv_events.append(event_row(ch, k, "oracle", asset, c, e))
                    bump("oracle", asset, e[0] if e[0] != "end" else "end_" + e[1])
                    if e[0] == "end":
                        bump("oracle", asset, "end_" + e[1] + ("_alerted" if e[2].get("alert") else "_quiet"))
                if new is not None:
                    st_new[(k, "oracle")] = dict(new, asset=asset, lc=c)
            # III arm
            st = st_old.get((k, "iii"))
            single = (p or {}).get("single")
            sym = III_SYMBOL.get(single) if single else None
            if st is not None:
                sym = st["sym"]
            if sym is None:
                continue
            g = iii.get(sym)
            G = g["G"] if g else None
            elig = (p is not None and p.get("detail") and not unresolved and p.get("single") in III_SYMBOL
                    and III_SYMBOL[p["single"]] == sym and p.get("kstar") is not None)
            if st is None and not elig:
                continue
            line_new = None
            d3 = None
            if G is not None:
                if st is not None and st["status"] == "open":
                    d3 = 1.0 - st["L"] / G
                elif elig:
                    line_new = G * (1.0 + p["kstar"])
                    d3 = -p["kstar"]
            if elig and d3 is not None:
                b = band_of(d3)
                a3 = p["single"]
                if b is not None:
                    cc = bands["iii"].setdefault(a3, empty_counts())
                    cc["n"][b] += 1
                    cc["debt"][b] += p["debt_usd"]
                elif d3 <= 0:
                    through["iii"] += 1
            touched = False
            if st is not None and st["status"] == "open":
                tt = iii_touched(sym, st["L"], st.get("lc", c - HOUR))
                if tt is None and not (closed or acted or liq):
                    new = dict(st, lc=c) if G is None else None
                    if new is not None:
                        st_new[(k, "iii")] = new
                        continue
                touched = bool(tt)
            L_cmp = st["L"] if (st is not None and st["status"] == "open") else line_new
            spot = g["spot"] if g else None
            thr = bool(spot is not None and L_cmp is not None and spot <= L_cmp)
            # an open III episode keeps its frozen line even if the composition stops being single-asset without an
            # action log (e.g. a reserve configuration change); its distance still follows the TWAP
            new, ev = step_episode(st, c, d3, touched, acted, liq, closed, line=line_new, spot_through=thr)
            a3 = (p or {}).get("single") or (st or {}).get("asset") or "?"
            for e in ev:
                priv_events.append(event_row(ch, k, "iii", a3, c, e))
                bump("iii", a3, e[0] if e[0] != "end" else "end_" + e[1])
                if e[0] == "end":
                    bump("iii", a3, "end_" + e[1] + ("_alerted" if e[2].get("alert") else "_quiet"))
            if new is not None:
                st_new[(k, "iii")] = dict(new, asset=a3, sym=sym, lc=c)
        # liquidations of positions with no episode state (recall monitor, counts only)
        in_ep = {k for (k, _) in st_old}
        line.update({"block": r["block"], "lagBlocks": r["lagBlocks"], "borrowers": r["borrowers"],
                     "accountsRead": r.get("scanned"), "fullScan": r.get("fullScan"),
                     "newBorrowers": len(r["newAddrs"]), "positions": len(P), "screened": r["screened"],
                     "unresolved": r["unresolved"], "failedCalls": r["failedCalls"], "liquidationCalls": r["nLiq"],
                     "liquidatedNoEpisode": len(r["liq"] - in_ep), "acted": len(r["acted"]),
                     "bands": {arm: {asset: {"n": v["n"], "debtUsd": [round(x) for x in v["debt"]]}
                                     for asset, v in sorted(bands[arm].items())} for arm in bands},
                     "through": through, "events": evc, "openEpisodes": {
                         arm: sum(1 for (kk, aa), v in st_new.items() if aa == arm and v["status"] == "open")
                         for arm in ("oracle", "iii")},
                     "disarmed": {arm: sum(1 for (kk, aa), v in st_new.items() if aa == arm and v["status"] == "disarmed")
                                  for arm in ("oracle", "iii")},
                     "sec": r["sec"]})
        if r.get("backfill") is not None:
            line["discovery"] = r["backfill"]
        pub["chains"][ch] = line
        states[ch] = st_new
        r["_pos"] = P
    pub["iii"] = {"symbols": sorted(syms), "failed": sorted(iii_fail)}
    # --- snapshot forward log (R28 resume condition (a)) ---------------------------------------------------------
    snap = update_snapshots(snap, res, iii, iii_touched, c)
    daily_new = None
    last_daily = read_jsonl(os.path.join(pdir, "ledger.jsonl"))
    today = day_of(c)
    if not last_daily or last_daily[-1]["date"] < today:
        members = []
        for ch in chains:
            r = res[ch]
            if r["status"] != "ok":
                continue
            for k, p in r["_pos"].items():
                if not p.get("detail") or p.get("unresolved"):
                    continue
                b = band_of(p.get("d"))
                if b is not None:
                    members.append({"chain": ch, "key": k, "arm": "oracle", "band": b, "asset": p["asset"],
                                    "t0": c, "lc": c})
                sym = III_SYMBOL.get(p.get("single") or "")
                g = iii.get(sym) if sym else None
                if sym and g and g["G"] is not None and p.get("kstar") is not None:
                    b3 = band_of(-p["kstar"])
                    if b3 is not None:
                        members.append({"chain": ch, "key": k, "arm": "iii", "band": b3, "asset": p["single"],
                                        "sym": sym, "L": g["G"] * (1.0 + p["kstar"]), "t0": c, "lc": c})
        snap = snap + members
        write_exclusive(os.path.join(root, ROOT_REL, PRIV_SUB, "snapshots", today + ".jsonl.gz"),
                        gzip.compress(b"".join(dumps(m) + b"\n" for m in members), mtime=0))
        daily_new = write_daily(root, today, c, pub, members, last_daily)
    resolved, snap = resolve_snapshots(snap, c)
    write_snapshot_outcomes(root, resolved, c)
    # --- write -----------------------------------------------------------------------------------------------------
    for ch in chains:
        if res[ch]["status"] == "ok":
            append_addresses(root, ch, res[ch]["newAddrs"], c)
            save_state(root, ch, states[ch])
            prev = read_json(os.path.join(priv_dir(root, ch), "cursor.json"), {}) or {}
            cur = {"block": res[ch]["block"], "at": now, "lastFull": prev.get("lastFull", 0)}
            if res[ch].get("fullScan"):
                cur["lastFull"] = now
            if res[ch].get("active") is not None:
                write_active(priv_dir(root, ch), res[ch]["active"])
            write_atomic(os.path.join(priv_dir(root, ch), "cursor.json"), dumps(cur))
    write_atomic(snap_p, b"".join(dumps(x) + b"\n" for x in sorted(snap, key=lambda x: (x["chain"], x["key"],
                                                                                        x["arm"], x["t0"]))))
    if priv_events:
        mp = os.path.join(root, ROOT_REL, PRIV_SUB, "events", time.strftime("%Y-%m", time.gmtime(c)) + ".jsonl")
        for e in priv_events:
            append_line(mp, e)
    append_line(os.path.join(pdir, "hourly", today + ".jsonl"), pub)
    append_line(runs_p, {"c": c, "at": now, "chains": {ch: res[ch]["status"] for ch in chains}})
    # --- public log: counts only -------------------------------------------------------------------------------------
    n_ok = sum(1 for ch in chains if res[ch]["status"] == "ok")
    n_stale = sum(1 for ch in chains if res[ch]["status"] == "stale")
    n_pend = sum(1 for ch in chains if res[ch]["status"] == "pending")
    log(f"d14 run: hour {iso(c)}, {n_ok} chains ok, {n_stale} stale, {n_pend} pending")
    for ch in chains:
        L_ = pub["chains"][ch]
        if L_["status"] == "ok":
            ev_o = sum(v.get("atrisk", 0) for v in L_["events"]["oracle"].values())
            ev_i = sum(v.get("atrisk", 0) for v in L_["events"]["iii"].values())
            nb = sum(sum(v["n"]) for v in L_["bands"]["oracle"].values())
            log(f"d14 chain {ch}: ok, {L_['positions']} positions, {nb} within 10%, {L_['unresolved']} unresolved, "
                f"at-risk {ev_o} oracle {ev_i} iii, {L_['liquidationCalls']} liquidations, {L_['sec']:.0f}s")
        else:
            log(f"d14 chain {ch}: {L_['status']}")
    log(f"d14 iii: {len(syms)} symbols, {len(iii_fail)} failed")
    if daily_new:
        log(f"d14 daily: snapshot {today} written, {len(daily_new['members'])} members")
    return 0


def event_row(ch, k, arm, asset, c, e):
    """Private event log row (holds the internal key; never published)."""
    kind = e[0]
    st = e[-1]
    row = {"chain": ch, "key": k, "arm": arm, "asset": asset, "c": c, "kind": kind if kind != "end" else "end"}
    if kind == "end":
        row["reason"] = e[1]
        row["start"] = st.get("start")
        row["alert"] = st.get("alert")
        row["actnow"] = st.get("actnow")
        if e[1] == "touch" and st.get("alert"):
            row["leadH"] = (c - st["alert"]) / HOUR
    elif kind == "atrisk":
        row["d"] = round(st["d_alert"], 6)
    elif kind == "open":
        row["d"] = round(st["d_start"], 6)
    return row


def update_snapshots(snap, res, iii, iii_touched, c):
    """Advance every pending snapshot member: first touch, act and liquidation times (no-action outcome is the first
    touch before any act). Stale chains and null III hours leave the member unchanged for the hour."""
    out = []
    for m in snap:
        r = res.get(m["chain"])
        if r is None or r["status"] != "ok":
            out.append(m)
            continue
        k = m["key"]
        m = dict(m)
        if k in r["liq"] and "liq" not in m:
            m["liq"] = c
        if k in r["acted"] and "act" not in m:
            m["act"] = c
        p = r["positions"].get(k)
        if p is None and "act" not in m and "liq" not in m:
            m["act"] = c                                  # closed below the minimum debt
        if "touch" not in m:
            if m["arm"] == "oracle":
                if p is not None and p.get("detail") and not p.get("unresolved") and p.get("d") is not None \
                        and p["d"] <= 0:
                    m["touch"] = c
            else:
                tt = iii_touched(m["sym"], m["L"], m["lc"])
                if tt:
                    m["touch"] = c
                elif tt is None:
                    m["gapH"] = m.get("gapH", 0) + 1
        m["lc"] = c
        out.append(m)
    return out


def resolve_snapshots(snap, c):
    """Members older than 7 d (+ 1 h) are resolved: -> (resolved rows, still pending)."""
    done, keep = [], []
    for m in snap:
        (done if c >= m["t0"] + 168 * HOUR + HOUR else keep).append(m)
    return done, keep


def write_snapshot_outcomes(root, resolved, c):
    """Private resolved rows; public counts per snapshot date x chain x arm x band (no keys)."""
    if not resolved:
        return
    mp = os.path.join(root, ROOT_REL, PRIV_SUB, "snap-outcomes", time.strftime("%Y-%m", time.gmtime(c)) + ".jsonl")
    agg = {}
    for m in resolved:
        append_line(mp, m)
        key = (day_of(m["t0"]), m["chain"], m["arm"], BAND_NAMES[m["band"]])
        g = agg.setdefault(key, {"n": 0, "actFirst": 0, "liq": 0, "gapH": 0,
                                 **{f"touch{h}h": 0 for h in SNAP_HORIZONS_H},
                                 **{f"touch{h}hNoAct": 0 for h in SNAP_HORIZONS_H}})
        g["n"] += 1
        g["gapH"] += m.get("gapH", 0)
        t = m.get("touch")
        act = m.get("act")
        if act is not None and (t is None or act < t):
            g["actFirst"] += 1
        if m.get("liq") is not None:
            g["liq"] += 1
        for h in SNAP_HORIZONS_H:
            if t is not None and t - m["t0"] <= h * HOUR:
                g[f"touch{h}h"] += 1
                if act is None or act >= t:
                    g[f"touch{h}hNoAct"] += 1
    op = os.path.join(pub_dir(root), "outcomes", time.strftime("%Y-%m", time.gmtime(c)) + ".jsonl")
    for (d, ch, arm, band), g in sorted(agg.items()):
        append_line(op, {"snapshot": d, "chain": ch, "arm": arm, "band": band, "resolvedAt": c, **g})


def write_daily(root, today, c, pub, members, ledger):
    """The day's snapshot (counts at the first check of the UTC day) and the previous day's hourly totals, hash
    chained: daily/<date>.json.gz carries prevSha256; ledger.jsonl names each file's sha256 and the previous line's."""
    pdir = pub_dir(root)
    prev_day = ledger[-1]["date"] if ledger else None
    prev_sha = ledger[-1]["sha256"] if ledger else ZERO_SHA
    totals = {}
    if prev_day:
        for h in read_jsonl(os.path.join(pdir, "hourly", prev_day + ".jsonl")):
            for ch, L_ in h["chains"].items():
                t = totals.setdefault(ch, {"runs": 0, "ok": 0, "stale": 0, "liquidationCalls": 0,
                                           "liquidatedNoEpisode": 0, "events": {"oracle": {}, "iii": {}}})
                t["runs"] += 1
                t["ok" if L_["status"] == "ok" else "stale"] += 1
                if L_["status"] != "ok":
                    continue
                t["liquidationCalls"] += L_["liquidationCalls"]
                t["liquidatedNoEpisode"] += L_["liquidatedNoEpisode"]
                for arm, byasset in L_["events"].items():
                    for asset, ev in byasset.items():
                        tgt = t["events"][arm].setdefault(asset, {})
                        for kk, v in ev.items():
                            tgt[kk] = tgt.get(kk, 0) + v
    snapc = {}
    for m in members:
        g = snapc.setdefault(m["chain"], {}).setdefault(m["arm"], {}).setdefault(m["asset"], [0] * len(BANDS))
        g[m["band"]] += 1
    doc = {"schema": SCHEMA, "prereg": PREREG, "date": today, "snapshotCheck": c, "prevSha256": prev_sha,
           "prevDate": prev_day, "bands": list(BAND_NAMES),
           "snapshot": {"counts": snapc, "chains": {ch: {kk: v for kk, v in L_.items() if kk in (
               "status", "bands", "through", "positions", "borrowers", "openEpisodes", "disarmed")}
               for ch, L_ in pub["chains"].items()}},
           "previousDay": totals}
    raw = gz(doc)
    sha = sha256_bytes(raw)
    write_exclusive(os.path.join(pdir, "daily", today + ".json.gz"), raw)
    prev_line = sha256_bytes(dumps(ledger[-1])) if ledger else ZERO_SHA
    append_line(os.path.join(pdir, "ledger.jsonl"), {"date": today, "sha256": sha, "prevSha256": prev_sha,
                                                     "prevLineSha256": prev_line, "snapshotCheck": c})
    return {"sha256": sha, "members": members}


def verify_ledger(root):
    """Every daily file matches its ledger line and the chains link. Raises SystemExit on a break."""
    pdir = pub_dir(root)
    ledger = read_jsonl(os.path.join(pdir, "ledger.jsonl"))
    prev_sha, prev_line = ZERO_SHA, ZERO_SHA
    for ln in ledger:
        with open(os.path.join(pdir, "daily", ln["date"] + ".json.gz"), "rb") as f:
            raw = f.read()
        doc = json.loads(gzip.decompress(raw))
        if sha256_bytes(raw) != ln["sha256"] or doc["prevSha256"] != prev_sha or ln["prevSha256"] != prev_sha \
                or ln["prevLineSha256"] != prev_line:
            raise SystemExit(f"STOP: d14 ledger chain broken at {ln['date']}")
        prev_sha, prev_line = ln["sha256"], sha256_bytes(dumps(ln))
    return len(ledger)


def scan_public_for_addresses(root):
    """Count 0x + 40 hex patterns in every public-safe file (must be 0)."""
    hits = 0
    for dp, _, fs in os.walk(pub_dir(root)):
        for n in fs:
            p = os.path.join(dp, n)
            with open(p, "rb") as f:
                raw = f.read()
            if n.endswith(".gz"):
                raw = gzip.decompress(raw)
            hits += len(re.findall(rb"0x[0-9a-fA-F]{40}", raw))
    return hits


# =====================================================================================================================
# main
# =====================================================================================================================
def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bootstrap")
    b.add_argument("--chain", required=True, choices=CHAIN_ORDER)
    b.add_argument("--work", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--span", type=int, default=0)
    b.add_argument("--workers", type=int, default=3)
    b.add_argument("--interval", type=float, default=0.0)
    i = sub.add_parser("init-chain")
    i.add_argument("--chain", required=True, choices=CHAIN_ORDER)
    i.add_argument("--out", required=True)
    i.add_argument("--seed", default=None)
    i.add_argument("--seed-span", type=int, default=5000)
    i.add_argument("--span", type=int, default=0)
    r = sub.add_parser("run")
    r.add_argument("--out", required=True, help="membrane-datasets checkout (read and written)")
    r.add_argument("--expect-commit", default=None)
    r.add_argument("--chains", default=",".join(CHAIN_ORDER))
    a = ap.parse_args(argv)
    if a.cmd == "bootstrap":
        bootstrap(a)
    elif a.cmd == "init-chain":
        init_chain(a)
    elif a.cmd == "run":
        if a.expect_commit:
            import subprocess
            got = subprocess.run(["git", "-C", HERE, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
            if got != a.expect_commit:
                raise SystemExit("STOP: code commit differs from the pin")
        chains = tuple(x for x in a.chains.split(",") if x)
        for ch in chains:
            if ch not in CHAINS:
                raise SystemExit(f"STOP: unknown chain {ch}")
        rc = run_hour(a, chains=chains)
        n = verify_ledger(a.out)
        hits = scan_public_for_addresses(a.out)
        print(f"d14 checks: ledger {n} days verified, {hits} address patterns in public files")
        if hits:
            raise SystemExit("STOP: address pattern in a public-safe file")
        sys.exit(rc)


if __name__ == "__main__":
    main()
