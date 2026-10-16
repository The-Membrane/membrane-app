#!/usr/bin/env python3
"""Q26 per-deposit live log -- shared code for the issuer (q26_dep_issue.py) and the scorer (q26_dep_score.py).

Implements triccs/membrane-board `design/DEPOSITOR_LIVE.md` (registered at board commit 3dc8c65, file sha256
52d7666a8395a6c0d1e5c9416ced4ec012c94abe9945a8d24a936e95efea4797). Parents: DEPOSITOR_BEHAVIOR_PREREG_B3.md
(B3.7, B3.9, D1), DEPOSITOR_BEHAVIOR_PREREG_B2.md (G.2 decoding, G.3 target, cap, D2 tolerance, G.7 episodes) and
HISTORY_TOUCH_LIVE.md (the pattern copied, with its D1/D2 readings).

Reused unchanged: bg_gradient.py (rows, labels, own-flow features, predict, masked monotone fix), b3_segments.py
(segments, B3 features, cross-venue loader, theta_seg, odds multiplier, RV7, holder code kind), b3_panel_d1.py
(D1 composite fix), g_acquire_events.py (aToken log decoder, ray math), x_acquire_crossvenue.py (cross-venue event
decoder, ERC-4626 silent shares, price calls) and live/q26_live_common.py (public RPC client with fallback,
Chainlink feed reader, append-only gzip stores, JSON writers).

The model is FROZEN (DL.3): nothing is fit. Where the protocol is silent the reading is listed in DECISIONS.
Addresses are public on-chain data. This code attaches no identity, label or name to any address.
"""
import csv
import gc
import gzip
import io
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import http.client
from array import array
from datetime import datetime, timezone
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.dirname(HERE)                       # scripts/research/history-forecasts
TOUCH_DIR = os.path.join(MODEL_DIR, "live")
for _p in (MODEL_DIR, TOUCH_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import numpy as np  # noqa: E402

import q26_live_common as C  # noqa: E402  (touch-log helpers, reused unchanged)
import bg_gradient as G  # noqa: E402
import b3_segments as S  # noqa: E402
import b3_panel_d1 as P1  # noqa: E402
import b_acquire as BA  # noqa: E402
import g_acquire_events as GE  # noqa: E402
import x_acquire_crossvenue as XA  # noqa: E402
import b4_depositor as B4  # noqa: E402  (model B4 features, frailty, shipping; reused unchanged)

# ---------------------------------------------------------------------------------------------
# Registered constants (DEPOSITOR_LIVE.md DL.1-DL.8)
# ---------------------------------------------------------------------------------------------
PREREG = {
    "repo": "triccs/membrane-board", "path": "design/DEPOSITOR_LIVE.md", "commit": "3dc8c65",
    "sha256": "52d7666a8395a6c0d1e5c9416ced4ec012c94abe9945a8d24a936e95efea4797",
    "parents": {"B3": "design/DEPOSITOR_BEHAVIOR_PREREG_B3.md (B3.7, B3.9, D1)",
                "B-gradient": "design/DEPOSITOR_BEHAVIOR_PREREG_B2.md (G.2, G.3, cap, D2, G.7)",
                "touch log": "design/HISTORY_TOUCH_LIVE.md"},
    "model": {"run": "membrane-datasets history-forecasts/b3/run-6b2ff4d7/ (c369ad4; D1 outputs e28c712)",
              "code": "b3_segments.py @ 6b2ff4d7, b3_panel_d1.py @ f0be1056"},
}
LIVE_REL = "forecasts/q26-deposit-live"
TOUCH_ROUNDS_REL = "forecasts/q26-touch-live/rounds/eth-usd.csv.gz"
TOUCH_LIVE_REL = "forecasts/q26-touch-live"
ISSUES_SUB, EVENTS_SUB, XV_SUB, CODES_SUB, UNITS_SUB, SCORES_SUB = (
    "issues", "events", "cross-venue", "codes", "units", "scores")
ISSUE_JSON_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.json$")
ISSUE_CSV_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.csv\.gz$")
ZERO_SHA = "0" * 64
HOUR, DAY = 3600, 86400

RUN_REL = "history-forecasts/b3/run-6b2ff4d7/"
FROZEN_ASOF_BLOCK = 26_186_746                          # last block of depositor-events (95e0e27) = B3 anchor
FROZEN_ASOF_TS = 1_791_932_759
FROZEN_ASOF_B1 = 26_180_400                             # depositor-balances asof (cross-venue asof_b1)
CONFIRMATIONS = 64                                      # DL.2: append logs up to the latest block >= 64 old
CANDIDATE_MIN_RAW = 900_000 * G.MICRO                   # DECISION DL-3: balanceOf read at path >= $900k
ANCHOR_ABS_RAW = 10 * G.MICRO                           # D2: max($10, 0.1% of the larger value)
ANCHOR_REL_DEN = 1000
# Event-store completeness (DL-16): sum of reconstructed scaled balances vs aToken.scaledTotalSupply().
SCALED_SUPPLY_SEL = GE.sel("scaledTotalSupply()")
CHAIN_SCALED_AT_ANCHOR = {"USDC": 2007105859835216, "USDT": 2399999435758952}   # scaledTotalSupply() at 26,186,746
ANCHOR_SCALED_OFFSET = {"USDC": -8664, "USDT": -4222}   # frozen reconstructed sum - chain at the anchor (asserted)
SUPPLY_TOL = 10_000                                      # scaled units per reserve (one $1 log ~ 8.4e5 units)
XV_BASE_LAG = 7 * DAY

# The sha256 of every frozen input the issuer reads (DL.7: the issuer refuses on any difference). Each equals the
# value pinned by its PROVENANCE.md table or run manifest (checked offline by test_q26_dep.py).
FROZEN_INPUTS = {
    "depositor-balances/PROVENANCE.md": "f2cc70a2daa0ced4123f9bccaa3c4803099b6d9f5a7d3a263b0448b86e3c2155",
    "depositor-balances/blocks.csv": "c59020cf9c734416936e75de7182ab4aa116625b0bd7727048fe25cd883e313e",
    "depositor-balances/daily-balances-usdc.csv.gz": "145bc8abb5ec611f112e29316feff80a0f0975bcbb54a4af6926d581119b0f9d",
    "depositor-balances/daily-balances-usdt.csv.gz": "23520c27f7570baa4f470dc199ce7c97b9681351fc7a3d85ca86631d0e5498ad",
    "depositor-balances/reserve-state.csv": "430532cd3cef4e6f6413b77279940a21fe9cfa7d8e381f49913e8bf56f3a4478",
    "depositor-events/PROVENANCE.md": "6140703a3fe72818e1eab35a803454b26610291a83cad4d08d030746f5d8b8ef",
    "depositor-events/events-usdc-2023.csv.gz": "257e15e78c665dc71f4a65aba601e29b00d70205c602fd453af91b1c780cb609",
    "depositor-events/events-usdc-2024.csv.gz": "4e8fac41f9a544b7c76a6ffd805af1ac3390d5718559efaa7aa0118b6de55a82",
    "depositor-events/events-usdc-2025.csv.gz": "6a8cadaee78e2937f44022ab887e5402868a01410be2a96bca14e06e78f0d6d2",
    "depositor-events/events-usdc-2026.csv.gz": "48c660ad88ed77106339a7712bc2bbd3c003f3af7c12c8308ed8fa7ee290bbca",
    "depositor-events/events-usdt-2023.csv.gz": "36291d790b2c3ed5927bb834c3afb75c65a55e6e5cc0a8aaa23ab4036d0e262f",
    "depositor-events/events-usdt-2024.csv.gz": "c5258103913f0e3016c32d804384ae66c1bc73dc04463196aca4229c0f2d3901",
    "depositor-events/events-usdt-2025.csv.gz": "c45acdb91bf953512ddb79954a27f8be3a7a3c0596df25c54b37bd3aa45dda8c",
    "depositor-events/events-usdt-2026.csv.gz": "15e3e302eab3d1c4dd5cc0848e37b921497ffc53119923c532a1b68802956741",
    "depositor-events/daily-balances-ext-usdc.csv.gz": "1cc3167d182dccdc480b2a17991b82461e6aafbe581073033df54b782079cf7d",
    "depositor-events/daily-balances-ext-usdt.csv.gz": "10f07ae6771785c0545b7732ba9b14970de09686d4e123454b48da25035c8196",
    "depositor-events/extended-universe.csv": "97c4cea260327aff289ec3fcf557358145d47492004a4b320dad754d5c1570db",
    "price-history/eth-usd-1h.json": "48b53d72351dbba6b05939a75660babc361678304747bf764d59e97d968bd26c",
    "rate-spike-flows/spike_episodes_full.csv": "c83c65a78e8ac410f040c903d6ebcd509001ab85292fa28cde434520421929bf",
    "cross-venue/PROVENANCE.md": "b568977e7b3d26ba28f0deefe0d35c13629a11ecaa3aa020fc91b9c1458170df",
    "cross-venue/selected-tokens.csv": "c286a24c7afe9a2aa286e63fe2a4d6508c3aded7b330ff50d6215c536f086738",
    "cross-venue/share-paths-daily.csv.gz": "1052f418ae286b52d4720f1af74e690d5b9041f9d8dabcdbe5e5140127f7d4dc",
    "cross-venue/share-price-daily.csv.gz": "08633472e3c34b88bb8bd521f68b1089afb65d1210fb25441c4141af08aef719",
    "cross-venue/nesting.csv": "057d5a12bf5ce7af7ff5d37b7d18406c56c21aa7167f27ec25732ce83367c638",
    "cross-venue/address-flags.csv": "1fbdb6c3d63281e8e06bdeb546c2aa7a613ff841bf66cbf810ff22d92023949b",
    RUN_REL + "results.json": "2946809bed5048e6609c61d42b32beacb6a9303d4c5fd7aa89037d7b0bd7342b",
    RUN_REL + "shipped-b3.json": "555e6510b15eb5d38f02d9b4fba85daf4be7e632b90183ecfa53329ce60ab263",
    RUN_REL + "labels.csv": "1c0989fb6e0890a7934b8112ffae7ca6fac43867852f0b72ce3e446c9f871bf6",
    RUN_REL + "labels-d1.csv": "35a5b306d88dade41cc2bf3e6a6a8e50c4f924a377495c64402b3584bb4f1246",
}

RESERVES = ("USDC", "USDT")
ATOKEN = {r: BA.RESERVES[r]["atoken"].lower() for r in RESERVES}
ASSET = {r: BA.RESERVES[r]["asset"].lower() for r in RESERVES}
RESERVE_OF_ATOKEN = {v: k for k, v in ATOKEN.items()}
POOL = BA.POOL.lower()
MULTICALL3 = BA.MULTICALL3
MULTICALL_CHUNK = 300
EV_TYPES = ("Mint", "Burn", "BalanceTransfer")
EV_TOPICS = [GE.TOPIC_OF[k] for k in EV_TYPES]
EV_COLS = ["reserve", "block", "ts", "tx_hash", "tx_index", "log_index", "type", "party1", "party2", "value_raw",
           "balanceIncrease_raw", "index_ray", "delta1_raw", "delta2_raw"]     # = depositor-events events-*.csv.gz
XV_TOPIC_NAMES = ("Transfer", "Deposit", "Withdraw", "MintV3", "BurnV3", "BalanceTransfer", "MintV2", "BurnV2",
                  "Supply", "CometWithdraw", "Redeem", "Mint4", "Redeem4")
XV_TOPICS = sorted({XA.T[k] for k in XV_TOPIC_NAMES})
XV_EV_COLS = ["token", "block", "ts", "tx_hash", "log_index", "type", "address", "delta_raw", "shares_delta"]
XV_SNAP_COLS = ["snapshot", "block", "ts"]
XV_PRICE_COLS = ["snapshot", "block", "token", "symbol", "kind", "price_basis", "price_num", "price_den", "status"]
CODE_COLS = ["address", "block", "is_contract", "eip7702", "code_bytes", "prefix", "readAt"]
FIRST_SEEN_COLS = ["reserve", "address", "date", "asof_block", "asof_ts"]
X_CELLS = [c for c in G.CELLS if c["kind"] == "x"]      # the 25 issued cells (DL.4; all_h cells are history only)
# Model B4 (DEPOSITOR_LIVE.md B4.5 deviation; opt-in, as the touch log's A5 switch)
MODEL_B4 = "B4"
B4_RUN_REL = "history-forecasts/b4/run-2035639d/"
B4_RUNGS = B4.RUNGS                                      # v2, v4a, v4b
B4_XK = tuple(f"x{x}" for x in G.SIZES)
DAILY_SUB = "daily"
DAILY_COLS = ["date", "block", "ts", "income_usdc", "income_usdt", "readAt"]
LIVE_DAILY_FIRST = "2026-10-14"                         # the first 00:00Z after the frozen asof (frozen dailies end 10-07)
RUNGS = S.RUNGS                                          # v2, v3, v3s

LOGS_URLS = ("https://rpc.mevblocker.io", "https://eth.drpc.org")
LOGS_MAX_RANGE = {"https://rpc.mevblocker.io": 20_000, "https://eth.drpc.org": 100}
LOGS_BATCH = {"https://rpc.mevblocker.io": 1, "https://eth.drpc.org": 3}
LOGS_MIN_RANGE = 100
LOGS_CAP_SUSPECT = 10_000

# Live-record rules (DL.6)
LIVE_CHECK_R, LIVE_CHECK_NEP = (0.67, 1.5), 50
STALE_WINDOW_DAYS, STALE_R, STALE_NEP = 90, (0.5, 2.0), 20
MIN_DAYS_PASS = 90

DECISIONS = [
    "DL-1 theta_i: results.json holds the asof parameters, theta_seg and seg_pop but not each unit's theta_i (only "
    "the 20 panel units' numbers). theta_i = (O_i + 3) / (E_i + 3) is recomputed at every issue exactly as the B3 "
    "asof fit computed it (b3_segments._fit_task kind 'asof': training rows = every labelled, uncapped row with "
    "features, built by bg_gradient.build_rows from the registered frozen inputs; E_i = sum of p0 from the frozen "
    "asof parameters; O_i = the rows' y). No parameter is fit. Every issue checks that the recomputed theta_seg "
    "equal results.json theta_seg (1e-9, else STOP); offline the B3 panel units' v2/v3/v3s p reproduce results.json "
    "to 1e-9.",
    "DL-2 event path at asof: the scaled balance (sum of rayDiv(G.2 change, event index); a BalanceTransfer moves its "
    "scaled value; the depositor-events recon_balance_asof_raw method) over every frozen and live log in blocks <= "
    "asof, times getReserveNormalizedIncome at the asof block. A plain sum of G.2 changes from the frozen asof "
    "anchor would miss the accrued interest (~0.01%/day) and fail the D2 tolerance for every unit within ~10 days. "
    "Anchor check: |path - balanceOf| <= max($10, 0.1% of max(path, balanceOf)) (D2 base; both values are at one "
    "block, so the intraday-peak term is the larger of the two). A unit failing it is issued as anchor_mismatch and "
    "never scored.",
    "DL-3 units: candidates = every (address, reserve) with event-path balance >= $900,000 at asof; balanceOf is read "
    "for each (Multicall3 eth_call at the asof block); unit = balanceOf >= $1,000,000 (B3 rows use the balanceOf "
    "anchor). bal(asof) = balanceOf in every feature, the cap and the truth. Candidates with balanceOf < $1M are "
    "counted in the header.",
    "DL-4 asof = the last block with ts < H, H = issuedAt floored to the hour. The event store appends only blocks "
    ">= 64 deep, which at the 01:07 schedule ends ~13 minutes before asof; the issuer reads the logs in (store end, "
    "asof] itself (recorded in the header, not written), as DL.2 prescribes for missing rounds. The same holds for "
    "the cross-venue logs.",
    "DL-5 features at asof (b3_segments.panel_compute, B3-13): util, bAPR, cash, totalSupply from getReserveData / "
    "aToken totalSupply / underlying balanceOf(aToken) / variableDebtToken totalSupply at asof; d_util, d_bAPR "
    "against the largest block with ts <= asof ts - 86,400; RV7 = b3_segments.rv7_from_rounds with H0 = asof ts "
    "floored to the hour, rounds with updatedAt <= asof ts (touch round store; rounds it lacks are read at the asof "
    "block and not written); own flows = bg_gradient.own_flow_at(t_ref = asof ts, block_ref = asof block) on deltas "
    "summed per (address, block, log index), frozen + live; age = (asof ts - T of the unit's first daily anchor >= "
    "$1M) / 86,400 from the frozen anchors; where those have none (new addresses, or units that reached $1M at no "
    "frozen daily anchor) the first live issue that issued the unit stands in for that anchor "
    "(units/first-seen.csv.gz; age 0 on that issue).",
    "DL-6 cross-venue at asof (B3-13 generalised): snapshots = the frozen daily ones, frozen asof_b1 and asof, the "
    "live daily snapshots (last block with ts < 00:00Z, from 2026-10-14) and the asof block. 7-day base = the "
    "snapshot whose block ts is closest to asof ts - 7 d (ties: the earlier); drop window = every snapshot after "
    "the base up to asof; value, flow, drop and venue count as b3_segments.xv_pair_contrib, summed in (token, "
    "address) order. At the B3 anchor this is B3-13 exactly (base 2026-10-07, window {asof_b1, asof}). Only "
    "address-flags.csv addresses are tracked (B3-4); others read 0 with xv_known = 0. Live share changes: "
    "x_acquire_crossvenue.decode_event per token and transaction, ERC-4626 silent shares, Comet principal = "
    "round(present value * 1e15 / baseSupplyIndex read at the event block). Prices as the cross-venue builder "
    "(price_calls / price_value; Comet totalSupply * 1e15 / totalSupplyBase); a failed price takes the last ok one. "
    "Transition: the frozen daily snapshots end 2026-10-07 and the live ones start 2026-10-14, so until about "
    "2026-10-21 the base is the nearest available snapshot (frozen 2026-10-07, asof_b1, frozen asof or a live "
    "daily) and the flow / drop window spans 7-10 days; from then on the base is the live daily ~7.04 d before a "
    "01:00Z asof and the window holds 7 dailies plus asof. Earlier issues' asof blocks are not snapshots.",
    "DL-7 cross-venue unavailable: if the cross-venue store cannot be brought to asof (a fetch, decode, Comet index "
    "or price read fails), v3 and v3s are inputs_unavailable (blank) for every unit and the xv feature columns are "
    "blank; v2 still issues; the composite D1 display leaves those model cells out (like capped cells).",
    "DL-8 holder type: address-flags.csv is_contract (B3-2); an address outside it gets one eth_getCode at the asof "
    "block of its first issue, recorded in codes/holder-codes.csv.gz and reused (b3_segments.code_kind: 0xef0100 + "
    "20 bytes = EIP-7702 delegation = wallet). Band from bal(asof); segment = 3 * is_contract + band.",
    "DL-9 issued cells: the 25 (x, h) cells; the y_all (all_h) cells are history only and are neither issued nor "
    "scored. Per cell: v2, v3, v3s = each rung's grid after the masked 2-D monotone fix (the values B3 scored); "
    "rung = the shipped rung of (cell, segment) ('pop' where none ships); ps = the shipped rung's p, or the frozen "
    "seg_pop of the unit's segment where no rung ships (population-rate history); label = the displayed label (DL-10); "
    "disp = the composite D1 display value (b3_panel_d1 rule: model cells fixed among themselves, "
    "population cells among themselves, capped cells left out); own = the frozen own rate (DL-11). Capped cells "
    "(x * bal > 100 * cash at asof) are blank in every p column and never scored.",
    "DL-10 label per (cell, segment) = labels-d1.csv label_display (the registered final label, tie-route HIGH shown "
    "MEDIUM); label_final (labels.csv) and label_preholdout (shipped-b3.json) are recorded beside it in the header "
    "table, with the shipped rung (shipped-b3.json) and seg_pop.",
    "DL-11 own rate (BSS vs own) = the unit's y rate over the B3 asof fit's training rows of that cell (bg G9); the "
    "cell's asof population rate where the unit has none (new units included). Population rate = the frozen seg_pop "
    "of the unit's segment (DL.3).",
    "DL-12 informational field, not used by the model or scorer: the variableDebtToken balanceOf of the unit's "
    "address in the same reserve and in the other reserve at asof (same Multicall3 call), vdebt_same_raw / "
    "vdebt_other_raw (parent addition: a later preregistration may define a debt-based exit label).",
    "DL-13 event store: only Mint, Burn and BalanceTransfer logs (Transfer rows carry no G.2 change), in the frozen "
    "decoded column layout, decoded by g_acquire_events.decode_log; one gzip member per run per month file (earlier "
    "bytes never change); fetch-log.jsonl records each range with its last block's ts and hash; each range starts one "
    "block after the previous one (checked on every read; rows beyond the logged coverage STOP the run). eth_getLogs "
    "on rpc.mevblocker.io (<= 20,000 blocks, split on error or >= 10,000 logs), fallback eth.drpc.org (100 blocks, "
    "batches of 3).",
    "DL-14 truth: t0 = H (as a training origin t0 = 00:00Z has its anchor at the last block before it). Path = "
    "bal(asof) + the G.2 changes of the blocks after the asof block; y(x, h) = 1 iff an event time in (H, H + h] has "
    "100 * path <= (100 - x) * bal (bg_gradient.label_x). The D2 tolerance enters through the anchor check: a row "
    "whose path is not anchored within D2 is never scored; no closing check is made. A row resolves at the first "
    "scorer run whose event store covers a block with ts >= H + h.",
    "DL-15 numbers: p values '%.6g' in the issue CSV (as the B3 prediction files), features '%.10g', balances as raw "
    "integers (1e-6 token).",
    "DL-16 event-store completeness (refuting review, must-fix): both public RPCs can return a partial log list "
    "without an error near the head. After every append (issuer and scorer) and for the issuer's in-memory logs up "
    "to asof, aUSDC and aUSDT scaledTotalSupply() are read in one Multicall3 call at the store's new last block "
    "(and at the asof block); the sum of reconstructed scaled balances (frozen + live: Mint +rayDiv(value - "
    "balanceIncrease, index), Burn -rayDiv(value + balanceIncrease, index); a BalanceTransfer nets to 0) minus the "
    "chain value must equal the frozen-anchor offset within 10,000 scaled units per reserve. The offset is computed "
    "at startup from the frozen events and the recorded chain value at block 26,186,746 and must equal the recorded "
    "offset (USDC -8,664, USDT -4,222), else STOP. On failure the issuer writes nothing and stops; the scorer "
    "appends nothing, scores nothing and exits non-zero. The check (chain, reconstruction, residual) is recorded in "
    "fetch-log.jsonl and in the issue header. Rounding drift measured on the first 20k live blocks: USDC -58, USDT "
    "-31.",
    "DL-17 a log provider is used for a range only if its own eth_blockNumber is >= the range end; otherwise the "
    "next provider takes over, and with none left the run stops.",
    "DL-18 store appends are transactions: the byte length of every file a run appends to is recorded first, and any "
    "failure during the writes truncates each file back (new files are removed) before the error propagates; the "
    "issuer's own outputs (CSV, header, chain line, first-seen, holder codes) are written the same way. The scorer "
    "still scores the stored events when an RPC read fails before any write (nothing appended), as the touch "
    "scorer does; a write failure exits non-zero.",
    "DL-19 model B4 (B4.5): opt-in by the issuer flags --model-b4 / --labels-b4 with their sha256 (as the touch log's "
    "A5 switch). Issue files then use schema q26-deposit-live/issue/2 with a top-level model field 'B4'. Every B3 "
    "column is computed and written exactly as before (same order, same values); the B4 columns follow them. Earlier "
    "files are never rewritten and the hash chain runs through the change.",
    "DL-20 frozen B4: shipped-b4.json asof params (v4a coefficients, m_seg, T_ref) and labels-dev.csv; B4's asof v2 "
    "equals B3's asof v2 (checked), so v2 and seg_pop are shared. theta_v4a = (O + 3) / (E + 3) and theta_v4b = "
    "(O_d + m_seg) / (E_d + m_seg), O_d / E_d discounted with half-life 180 d to T_ref = the frozen asof time (not the "
    "live asof), are recomputed at every issue from the frozen rows exactly as the B4 asof fit (b4_depositor fit_one): "
    "m_seg and the per-segment discounted sums must equal shipped-b4.json (else STOP). Nothing is fit. A unit outside "
    "the frozen universe gets theta 1 for both.",
    "DL-21 live daily balances (v4a, parent ruling): one per UTC day from 2026-10-14 (the first 00:00Z after the "
    "frozen asof), defined as the frozen daily anchors: the balance at the last block with ts < 00:00Z, here the "
    "event-path balance there = rayMul(scaled balance of the logs in blocks <= that block, getReserveNormalizedIncome "
    "at it), equal to balanceOf when the store is complete (DL-16). The block and both incomes are stored in "
    "daily/snapshots.csv.gz (appended by the issuer, one transaction). No daily balance exists for 2026-10-08..10-13 "
    "(the frozen anchors stop at 10-07 and the event store starts after the frozen asof); those days count as missing "
    "anchors do in B4 (skipped in maxdd90, never origins). A unit outside the frozen universe has no frozen-span daily "
    "balances.",
    "DL-22 v4a features at asof (B4-10 code: b4_depositor.hist_at / maxdd_at): prior origins = the frozen daily "
    "origins with y(x, 24 h) = 1 plus the live days with balance >= $1M and y(x, 24 h) = 1 on the event path (anchored "
    "at the day's balance, event times in (00:00Z, 00:00Z + 24 h]), each counted only when 00:00Z + 24 h <= asof ts; "
    "n_x90 = those with 00:00Z >= asof ts - 90 d; days since = fractional days to the last one, capped at 365; "
    "maxdd90 over the daily balances with 00:00Z in [asof ts - 90 d, asof ts] plus the asof balance. Only logs in "
    "blocks <= asof enter.",
    "DL-23 B4 cells: v4a, v4b (each grid masked-monotone-fixed), rung4 = shipped-b4.json shipped rung ('pop' where "
    "none ships), ps4 = its p or the frozen seg_pop, disp4 = the B4 D1 display (b3_panel_d1.d1_fix: model cells among "
    "themselves, population cells among themselves, capped left out), label4 = labels-dev.csv label_final (B4 has no "
    "tie route). Capped cells are blank. Per unit: maxdd90, log1p n_x90 and log1p days since per size, the number of "
    "live daily balances and of live origins used.",
    "DL-24 scorer with model B4: the B4 rungs v4a, v4b, ps4 and disp4 are scored on B4 issues beside the B3 rungs. "
    "The DL.6 live check and live STALE use the B4 shipped rung (ps4) over the rows of B4 issues, from the change date, "
    "with 'applied' counting resolved B4 issue days per horizon; the B3 shipped-rung check is still reported "
    "(liveCheckB3, liveStaleB3) over every issue.",
]


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------
iso = C.iso
utc_date = C.utc_date
floor_hour = C.floor_hour
sha256_file = C.sha256_file
sha256_bytes = C.sha256_bytes
write_exclusive = C.write_exclusive
write_atomic = C.write_atomic
append_bytes = C.append_bytes
gz_member = C.gz_member
dumps = C.dumps
clean = C.clean


def live_dir(out_root):
    return os.path.join(out_root, LIVE_REL)


def fmt_p(v):
    return "" if v is None or not np.isfinite(v) else "%.6g" % v


def fmt_f(v):
    return "" if v is None or not np.isfinite(v) else "%.10g" % v


def read_gz_rows(path, header):
    """Multi-member gzip CSV (header in the first member only) -> list of rows (header checked)."""
    if not os.path.exists(path):
        return []
    return C.read_gz_csv(path, header)


def append_gz_rows(path, header, rows):
    if not rows:
        return 0
    append_bytes(path, gz_member(None if os.path.exists(path) else header, rows))
    return len(rows)


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(x) for x in f if x.strip()]


def append_jsonl(path, entry):
    append_bytes(path, (json.dumps(clean(entry), separators=(",", ":"), sort_keys=True) + "\n").encode())


def verify_frozen_inputs(datasets):
    """DL.7: sha256 of every frozen input against the registered value; STOP on any difference."""
    out = {}
    for rel, want in FROZEN_INPUTS.items():
        p = os.path.join(datasets, rel)
        if not os.path.exists(p):
            raise SystemExit(f"STOP: frozen input missing: {rel}")
        got = sha256_file(p)
        if got != want:
            raise SystemExit(f"STOP: sha256 mismatch for frozen input {rel}: {got} != registered {want}")
        out[rel] = {"sha256": got, "bytes": os.path.getsize(p)}
    return out


CODE_FILES = ("live_deposit/q26_dep_common.py", "live_deposit/q26_dep_issue.py", "live_deposit/q26_dep_score.py",
              "b4_depositor.py",
              "live/q26_live_common.py", "bg_gradient.py", "b3_segments.py", "b3_panel_d1.py", "b_behavior.py",
              "b_acquire.py", "g_acquire_events.py", "x_acquire_crossvenue.py")


def code_meta(expect_commit=None):
    def git(*args):
        r = subprocess.run(["git", "-C", MODEL_DIR, *args], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else None
    commit = git("rev-parse", "HEAD")
    dirty = git("status", "--porcelain", "--", *CODE_FILES)
    out = {"repo": "The-Membrane/membrane-app", "dir": "scripts/research/history-forecasts", "commit": commit,
           "dirty": (dirty.splitlines() if dirty else []) if dirty is not None else None,
           "sha256": {f: sha256_file(os.path.join(MODEL_DIR, f)) for f in CODE_FILES},
           "python": sys.version.split()[0], "numpy": np.__version__}
    for mod in ("scipy", "sklearn", "pandas"):
        try:
            out[mod] = __import__(mod).__version__
        except ImportError:
            pass
    if expect_commit is not None and commit != expect_commit:
        raise SystemExit(f"STOP: code checkout is at {commit}, expected the pinned commit {expect_commit}")
    return out


# ---------------------------------------------------------------------------------------------
# JSON-RPC: eth_call / blocks via the touch-log client; Multicall3; block search
# ---------------------------------------------------------------------------------------------
def make_rpc(max_calls=40000, log=None):
    return C.RpcClient(max_calls=max_calls, log=log)


def multicall(rpc, calls, block, chunk=MULTICALL_CHUNK):
    """[(target, calldata bytes)] -> [(ok, returndata)] via Multicall3 aggregate3 at `block` (allowFailure)."""
    out = []
    tag = hex(block) if isinstance(block, int) else block
    for i in range(0, len(calls), chunk):
        part = calls[i:i + chunk]
        res = rpc.eth_call_many([(MULTICALL3, BA.encode_aggregate3(part).hex())], tag)[0]
        if res is C.REVERTED:
            raise C.RpcError("aggregate3 reverted")
        out += BA.decode_aggregate3_result(res, len(part))
    return out


def get_block(rpc, b):
    r = rpc.request_many("eth_getBlockByNumber", [[hex(b) if isinstance(b, int) else b, False]])[0]
    if not isinstance(r, dict) or "timestamp" not in r:
        raise C.RpcError(f"no block {b}")
    return {"number": int(r["number"], 16), "ts": int(r["timestamp"], 16), "hash": r["hash"]}


def block_ts_many(rpc, blocks):
    blocks = sorted(set(int(b) for b in blocks))
    res = rpc.request_many("eth_getBlockByNumber", [[hex(b), False] for b in blocks])
    out = {}
    for b, r in zip(blocks, res):
        if not isinstance(r, dict) or int(r["number"], 16) != b:
            raise C.RpcError(f"bad block {b}")
        out[b] = int(r["timestamp"], 16)
    return out


def find_block_before(rpc, T, head):
    """Largest block with ts < T (b_acquire.find_block_before); head = (number, ts) with ts >= T."""
    hn, hts = head
    if hts < T:
        raise C.RpcError(f"head {hn} ts {hts} is before {T}")
    cache = {hn: hts}

    def ts(b):
        if b not in cache:
            cache[b] = get_block(rpc, b)["ts"]
        return cache[b]
    guess = max(0, hn - (hts - T) // 12 - 1)
    b, tb, tn = BA.find_block_before(T, ts, guess, head=hn)
    return b, tb, tn


def head_block(rpc):
    n, ts = rpc.head()
    return n, ts


# ---------------------------------------------------------------------------------------------
# eth_getLogs (multi-address, topic0 filter) with range splitting and provider fallback
# ---------------------------------------------------------------------------------------------
class RangeError(Exception):
    pass


class ProviderDown(Exception):
    pass


class LogsClient:
    """eth_getLogs on the public endpoints in order (mevblocker, then drpc). A range that errors or returns
    >= 10,000 logs is split in half down to 100 blocks; at the minimum it retries with backoff, then the next
    provider takes over for the rest of the run."""

    def __init__(self, urls=LOGS_URLS, post=None, retries=3, backoff=2.0, sleep=time.sleep, timeout=120,
                 max_requests=6000, log=None):
        for u in urls:
            C.assert_public(u)
        self.urls = tuple(urls)
        self._post = post or C.urllib_post
        self.retries, self.backoff, self._sleep, self.timeout = retries, backoff, sleep, timeout
        self.max_requests = max_requests
        self.cur = 0
        self._id = 0
        self.requests = 0
        self.per_url = {u: {"httpRequests": 0, "logs": 0, "splits": 0, "errors": 0} for u in self.urls}
        self.errors = []
        self._log = log or (lambda *_: None)
        self._head = {}

    def stats(self):
        return {"providers": list(self.urls), "used": {u: v for u, v in self.per_url.items() if v["httpRequests"]},
                "httpRequests": self.requests, "errors": self.errors[-10:], "providerHeads": dict(self._head),
                "note": "public endpoints without a key"}

    def provider_head(self, url):
        """The provider's own eth_blockNumber (DL-17)."""
        self._id += 1
        resp = self._post_json(url, {"jsonrpc": "2.0", "id": self._id, "method": "eth_blockNumber", "params": []})
        if not isinstance(resp, dict) or not isinstance(resp.get("result"), str):
            raise RangeError(f"eth_blockNumber: {str(resp)[:120]}")
        return int(resp["result"], 16)

    def _post_json(self, url, body):
        if self.requests >= self.max_requests:
            raise C.RpcError(f"eth_getLogs request budget {self.max_requests} exhausted")
        self.requests += 1
        self.per_url[url]["httpRequests"] += 1
        try:
            return json.loads(self._post(url, json.dumps(body).encode(), self.timeout))
        except (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError, ValueError) as e:
            raise RangeError(f"transport {type(e).__name__}: {str(e)[:120]}")

    def _req(self, addresses, topic0s, lo, hi):
        self._id += 1
        return {"jsonrpc": "2.0", "id": self._id, "method": "eth_getLogs",
                "params": [{"address": list(addresses), "topics": [list(topic0s)],
                            "fromBlock": hex(lo), "toBlock": hex(hi)}]}

    @staticmethod
    def validate(result, addresses, topic0s, lo, hi):
        if not isinstance(result, list):
            raise RangeError(f"result is {type(result).__name__}")
        if len(result) >= LOGS_CAP_SUSPECT:
            raise RangeError(f"{len(result)} logs: possibly capped")
        aset = {a.lower() for a in addresses}
        tset = {t.lower() for t in topic0s}
        out, seen = [], set()
        for lg in result:
            try:
                a = str(lg["address"]).lower()
                b = int(lg["blockNumber"], 16)
                li = int(lg["logIndex"], 16)
                topics = [str(t).lower() for t in lg["topics"]]
                rec = {"address": a, "block": b, "log_index": li, "tx_index": int(lg["transactionIndex"], 16),
                       "tx": str(lg["transactionHash"]).lower(), "topics": topics, "data": str(lg["data"]).lower(),
                       "ts": int(lg["blockTimestamp"], 16) if lg.get("blockTimestamp") else None,
                       "block_hash": str(lg.get("blockHash") or "").lower()}
            except (KeyError, TypeError, ValueError) as e:
                raise RangeError(f"malformed log: {e}")
            if a not in aset or not topics or topics[0] not in tset:
                raise RangeError("log outside the filter")
            if not lo <= b <= hi or lg.get("removed"):
                raise RangeError("log outside the range or removed")
            if (b, li) in seen:
                raise RangeError(f"duplicate log {b}/{li}")
            seen.add((b, li))
            out.append(rec)
        out.sort(key=lambda x: (x["block"], x["log_index"]))
        return out

    def _one(self, url, addresses, topic0s, lo, hi):
        resp = self._post_json(url, self._req(addresses, topic0s, lo, hi))
        if not isinstance(resp, dict) or "error" in resp or "result" not in resp:
            raise RangeError(f"rpc error {str(resp.get('error') if isinstance(resp, dict) else resp)[:160]}")
        return self.validate(resp["result"], addresses, topic0s, lo, hi)

    def _span_split(self, url, addresses, topic0s, lo, hi):
        attempt = 0
        while True:
            try:
                got = self._one(url, addresses, topic0s, lo, hi)
                self.per_url[url]["logs"] += len(got)
                return got
            except RangeError as e:
                self.per_url[url]["errors"] += 1
                if hi - lo + 1 > LOGS_MIN_RANGE:
                    mid = lo + (hi - lo + 1) // 2
                    self.per_url[url]["splits"] += 1
                    return (self._span_split(url, addresses, topic0s, lo, mid - 1)
                            + self._span_split(url, addresses, topic0s, mid, hi))
                attempt += 1
                if attempt >= self.retries:
                    raise ProviderDown(f"{url}: {e}")
                self._sleep(self.backoff * (2 ** (attempt - 1)))

    def _span_batched(self, url, addresses, topic0s, lo, hi):
        """drpc: 100-block pieces, <= 3 per HTTP batch."""
        pieces = [(s, min(s + LOGS_MAX_RANGE[url] - 1, hi)) for s in range(lo, hi + 1, LOGS_MAX_RANGE[url])]
        out = []
        nb = LOGS_BATCH[url]
        for i in range(0, len(pieces), nb):
            part = pieces[i:i + nb]
            for attempt in range(self.retries):
                try:
                    reqs = [self._req(addresses, topic0s, a, b) for a, b in part]
                    resp = self._post_json(url, reqs if len(reqs) > 1 else reqs[0])
                    if isinstance(resp, dict):
                        resp = [resp]
                    by_id = {r.get("id"): r for r in resp if isinstance(r, dict)}
                    got = []
                    for q, (a, b) in zip(reqs, part):
                        r = by_id.get(q["id"])
                        if r is None or "error" in r or "result" not in r:
                            raise RangeError(f"rpc error {str((r or {}).get('error'))[:160]}")
                        got += self.validate(r["result"], addresses, topic0s, a, b)
                    out += got
                    self.per_url[url]["logs"] += len(got)
                    break
                except RangeError as e:
                    self.per_url[url]["errors"] += 1
                    if attempt == self.retries - 1:
                        raise ProviderDown(f"{url}: {e}")
                    self._sleep(self.backoff * (2 ** attempt))
        return out

    def get_logs(self, addresses, topic0s, lo, hi):
        out = []
        cur = lo
        while cur <= hi:
            if self.cur >= len(self.urls):
                raise C.RpcError(f"all public log endpoints failed: {self.errors[-1:]}")
            url = self.urls[self.cur]
            if self._head.get(url, -1) < hi:                     # DL-17: the provider must have reached hi
                try:
                    self._head[url] = self.provider_head(url)
                except RangeError as e:
                    self._head[url] = -1
                    self.errors.append(f"{url}: {e}"[:200])
                if self._head[url] < hi:
                    self.errors.append(f"{url}: head {self._head[url]} < range end {hi}")
                    self._log(f"logs {url} head {self._head[url]} behind {hi}; falling back")
                    self.cur += 1
                    continue
            nb = LOGS_BATCH.get(url, 1)
            span = LOGS_MAX_RANGE.get(url, 1000) * (nb * 8 if nb > 1 else 1)   # batched: 24 pieces per chunk
            end = min(hi, cur + span - 1)
            try:
                if LOGS_BATCH.get(url, 1) > 1:
                    out += self._span_batched(url, addresses, topic0s, cur, end)
                else:
                    out += self._span_split(url, addresses, topic0s, cur, end)
                cur = end + 1
            except ProviderDown as e:
                self.errors.append(str(e)[:200])
                self._log(f"logs {url} failed ({e}); falling back")
                self.cur += 1
        out.sort(key=lambda x: (x["block"], x["log_index"]))
        return out


def fill_ts(logs, rpc):
    miss = sorted({lg["block"] for lg in logs if lg["ts"] is None})
    if miss:
        t = block_ts_many(rpc, miss)
        for lg in logs:
            if lg["ts"] is None:
                lg["ts"] = t[lg["block"]]
    return logs


# ---------------------------------------------------------------------------------------------
# aToken event store (DL.2, DL-13)
# ---------------------------------------------------------------------------------------------
def decode_atoken_log(lg):
    """One aToken log -> a row in the frozen decoded layout (EV_COLS)."""
    reserve = RESERVE_OF_ATOKEN.get(lg["address"])
    if reserve is None:
        raise SystemExit(f"STOP: log of unexpected address {lg['address']}")
    ev = GE.decode_log(lg["topics"], lg["data"])
    if ev is None or ev["type"] not in EV_TYPES:
        raise SystemExit(f"STOP: unexpected aToken log type at {lg['block']}/{lg['log_index']}")
    d = ev["deltas"]
    if ev["type"] == "BalanceTransfer":
        d1, d2 = d[0][1], d[1][1]
        bi = ""
    else:
        d1, d2 = d[0][1], ""
        bi = ev["balanceIncrease"]
    return [reserve, lg["block"], lg["ts"], lg["tx"], lg["tx_index"], lg["log_index"], ev["type"], ev["party1"],
            ev["party2"], ev["value"], bi, ev["index"], d1, d2]


def fetch_event_rows(logs_client, rpc, lo, hi):
    logs = logs_client.get_logs([BA.RESERVES[r]["atoken"] for r in RESERVES], EV_TOPICS, lo, hi)
    fill_ts(logs, rpc)
    logs = sorted(logs, key=lambda lg: (lg["block"], lg["log_index"]))
    return [decode_atoken_log(lg) for lg in logs]


def month_of(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m")


def event_files(ldir):
    d = os.path.join(ldir, EVENTS_SUB)
    if not os.path.isdir(d):
        return []
    return sorted(os.path.join(d, f) for f in os.listdir(d) if re.fullmatch(r"events-\d{4}-\d{2}\.csv\.gz", f))


def event_store_status(ldir):
    """Coverage of the event store from fetch-log.jsonl; ranges must be contiguous from the frozen asof + 1."""
    lines = read_jsonl(os.path.join(ldir, EVENTS_SUB, "fetch-log.jsonl"))
    cov, cov_ts, last_fetch = FROZEN_ASOF_BLOCK, FROZEN_ASOF_TS, None
    for e in lines:
        if int(e["fromBlock"]) != cov + 1:
            raise SystemExit(f"STOP: event store not contiguous: range starts at {e['fromBlock']}, expected {cov + 1}")
        cov, cov_ts = int(e["toBlock"]), int(e["toBlockTs"])
        last_fetch = int(e["fetchedAt"])
    return {"coveredBlock": cov, "coveredTs": cov_ts, "nRanges": len(lines), "lastFetchedAt": last_fetch}


class AppendTxn:
    """DL-18: record the byte length of every file a run appends to; on any exception inside the block, truncate
    each back (remove files that did not exist) and re-raise. Appends never rewrite earlier bytes."""

    def __init__(self, paths):
        self.sizes = {p: (os.path.getsize(p) if os.path.exists(p) else None) for p in dict.fromkeys(paths)}

    def __enter__(self):
        return self

    def __exit__(self, et, ev, tb):
        if et is None:
            return False
        for p, n in self.sizes.items():
            try:
                if n is None:
                    if os.path.exists(p):
                        os.remove(p)
                elif os.path.exists(p) and os.path.getsize(p) != n:
                    with open(p, "r+b") as f:
                        f.truncate(n)
            except OSError:
                pass
        return False


def rows_scaled_sum(rows_iter, header, upto_block=None):
    """Per reserve: the sum over balance rows of the scaled change over all parties (Mint + rayDiv(delta1, index),
    Burn - rayDiv(-delta1, index); a BalanceTransfer nets to 0), blocks <= upto_block."""
    col = {h: i for i, h in enumerate(header)}
    ir, ib, ity, ix, id1 = col["reserve"], col["block"], col["type"], col["index_ray"], col["delta1_raw"]
    out = {r: 0 for r in RESERVES}
    for row in rows_iter:
        d1 = row[id1]
        if d1 == "" or row[ity] not in ("Mint", "Burn"):
            continue
        if upto_block is not None and int(row[ib]) > upto_block:
            continue
        out[row[ir]] += GE.signed_ray_div(int(d1), int(row[ix]))
    return out


def _add_sums(a, b):
    return {r: a[r] + b[r] for r in RESERVES}


def frozen_scaled_sums(datasets):
    out = {r: 0 for r in RESERVES}
    for p in frozen_event_paths(datasets):
        it = iter_gz_csv(p)
        out = _add_sums(out, rows_scaled_sum(it, next(it)))
    return out


def check_frozen_offset(frozen_sums):
    """DL-16: the frozen-anchor offset computed from the frozen events must equal the recorded one."""
    got = {r: frozen_sums[r] - CHAIN_SCALED_AT_ANCHOR[r] for r in RESERVES}
    if got != ANCHOR_SCALED_OFFSET:
        raise SystemExit(f"STOP: frozen-anchor scaled offset {got} != recorded {ANCHOR_SCALED_OFFSET}")
    return got


def store_scaled_sums(ldir, upto_block=None):
    out = {r: 0 for r in RESERVES}
    for p in event_files(ldir):
        it = iter_gz_csv(p)
        out = _add_sums(out, rows_scaled_sum(it, next(it), upto_block))
    return out


def read_scaled_supply(rpc, block):
    res = multicall(rpc, [(BA.RESERVES[r]["atoken"], SCALED_SUPPLY_SEL) for r in RESERVES], block)
    out = {}
    for r, (ok, ret) in zip(RESERVES, res):
        if not ok or len(ret) != 32:
            raise C.RpcError(f"scaledTotalSupply of {r} unreadable at {block}")
        out[r] = int.from_bytes(ret, "big")
    return out


def supply_check(rpc, block, frozen_sums, live_sums, what):
    """DL-16: reconstructed scaled total (frozen + live, blocks <= block) - chain scaledTotalSupply at block must equal
    the frozen-anchor offset within SUPPLY_TOL per reserve; STOP otherwise (the caller has written nothing)."""
    chain = read_scaled_supply(rpc, block)
    rec = {}
    for r in RESERVES:
        recon = frozen_sums[r] + live_sums[r]
        rec[r] = {"chainScaledTotalSupply": str(chain[r]), "reconScaledTotal": str(recon),
                  "residual": recon - chain[r] - ANCHOR_SCALED_OFFSET[r]}
    bad = {r: v["residual"] for r, v in rec.items() if abs(v["residual"]) > SUPPLY_TOL}
    if bad:
        raise SystemExit(f"STOP: event store incomplete for {what} at block {block}: residual {bad} scaled units "
                         f"(tolerance {SUPPLY_TOL}); nothing written")
    return {"block": block, "tolerance": SUPPLY_TOL, "anchorOffset": ANCHOR_SCALED_OFFSET, "reserves": rec}


def prepare_event_append(ldir, logs_client, rpc, target_block, frozen_sums, clock=time.time):
    """DL.2 + DL-16: fetch every Mint/Burn/BalanceTransfer log after the covered block up to target_block and run the
    completeness check at target_block. Nothing is written; commit_event_append writes the returned append."""
    st = event_store_status(ldir)
    lo = st["coveredBlock"] + 1
    if target_block < lo:
        return {"rows": [], "entry": None, "coveredBlock": st["coveredBlock"],
                "note": "store already covers target"}
    rows = fetch_event_rows(logs_client, rpc, lo, target_block)
    tb = get_block(rpc, target_block)
    live = _add_sums(store_scaled_sums(ldir), rows_scaled_sum(iter(rows), EV_COLS))
    check = supply_check(rpc, target_block, frozen_sums, live, "the append")
    by_month = {}
    for r in rows:
        by_month.setdefault(month_of(r[2]), []).append(r)
    entry = {"fromBlock": lo, "toBlock": target_block, "toBlockTs": tb["ts"], "toBlockHash": tb["hash"],
             "nLogs": len(rows), "byType": {t: sum(r[6] == t for r in rows) for t in EV_TYPES},
             "files": {f"events-{m}.csv.gz": len(rs) for m, rs in sorted(by_month.items())},
             "scaledSupplyCheck": check, "fetchedAt": int(clock())}
    return {"rows": rows, "by_month": by_month, "entry": entry, "coveredBlock": target_block}


def commit_event_append(ldir, pending, log=print):
    """Write a prepared append as one transaction (DL-18)."""
    entry = pending["entry"]
    if entry is None:
        return {"appended": 0, "toBlock": pending["coveredBlock"], "note": pending.get("note")}
    if event_store_status(ldir)["coveredBlock"] != entry["fromBlock"] - 1:
        raise SystemExit("STOP: the event store changed between prepare and commit")
    by_month = pending["by_month"]
    paths = [os.path.join(ldir, EVENTS_SUB, f"events-{m}.csv.gz") for m in sorted(by_month)]
    flog = os.path.join(ldir, EVENTS_SUB, "fetch-log.jsonl")
    with AppendTxn(paths + [flog]):
        for m, rs in sorted(by_month.items()):
            append_gz_rows(os.path.join(ldir, EVENTS_SUB, f"events-{m}.csv.gz"), EV_COLS, rs)
        append_jsonl(flog, entry)
    res = {r: v["residual"] for r, v in entry["scaledSupplyCheck"]["reserves"].items()}
    log(f"event store: +{entry['nLogs']} logs in blocks {entry['fromBlock']}..{entry['toBlock']} "
        f"(to {iso(entry['toBlockTs'])}); scaled residual {res}")
    return entry


def update_event_store(ldir, logs_client, rpc, target_block, frozen_sums, clock=time.time, log=print):
    """prepare_event_append + commit_event_append (the scorer's append)."""
    return commit_event_append(ldir, prepare_event_append(ldir, logs_client, rpc, target_block, frozen_sums,
                                                          clock=clock), log=log)


# ---------------------------------------------------------------------------------------------
# Event tables: scaled balances of every address, per-log deltas (frozen + live), DL-2 / DL-5
# ---------------------------------------------------------------------------------------------
class Reserve:
    """Per reserve: address codes, scaled balance sums (exact), and party rows for per-unit features/paths."""

    def __init__(self, name):
        self.name = name
        self.amap = {}
        self.addrs = []
        self.scaled = {}
        self.code = array("q")
        self.block = array("q")
        self.ts = array("q")
        self.li = array("q")
        self.delta = array("q")
        self.sc = array("q")
        self.last_block = 0
        self._order = None

    def acode(self, a):
        c = self.amap.get(a)
        if c is None:
            c = len(self.addrs)
            self.amap[a] = c
            self.addrs.append(a)
        return c

    def add(self, code, block, ts, li, delta, scaled):
        self.code.append(code)
        self.block.append(block)
        self.ts.append(ts)
        self.li.append(li)
        self.delta.append(delta)
        self.sc.append(scaled)
        self.scaled[code] = self.scaled.get(code, 0) + scaled
        self._order = None

    def finalize(self):
        self.np = {k: np.frombuffer(getattr(self, k), dtype=np.int64) if len(getattr(self, k)) else
                   np.zeros(0, np.int64) for k in ("code", "block", "ts", "li", "delta", "sc")}
        o = np.lexsort((self.np["li"], self.np["block"], self.np["code"]))
        for k in self.np:
            self.np[k] = self.np[k][o]
        self._starts = np.searchsorted(self.np["code"], np.arange(len(self.addrs) + 1))
        return self

    def rows_of(self, addr):
        c = self.amap.get(addr)
        if c is None:
            z = np.zeros(0, np.int64)
            return {k: z for k in ("block", "ts", "li", "delta", "sc")}
        a, b = self._starts[c], self._starts[c + 1]
        return {k: self.np[k][a:b] for k in ("block", "ts", "li", "delta", "sc")}

    def balance_at(self, addr, block, income):
        """Event-path balance after every log in blocks <= block: rayMul(scaled sum, income at that block)."""
        r = self.rows_of(addr)
        s_ = sum(int(v) for v in r["sc"][r["block"] <= block])
        return GE.ray_mul(s_, income) if s_ >= 0 else -GE.ray_mul(-s_, income)

    def logs_of(self, addr):
        """Per-log (block, log index) summed deltas of one address: block, ts, delta (int), delta_f (float)."""
        r = self.rows_of(addr)
        if not len(r["block"]):
            return {"block": r["block"], "ts": r["ts"], "delta": r["delta"], "delta_f": r["delta"].astype(float)}
        key = (r["block"] << 16) | r["li"]
        st = G.group_starts(key)
        d = np.add.reduceat(r["delta"], st)
        return {"block": r["block"][st], "ts": r["ts"][st], "delta": d, "delta_f": d.astype(float)}

    def blocks_of(self, addr):
        """Per-block summed deltas (G2: one event time = one block)."""
        r = self.rows_of(addr)
        if not len(r["block"]):
            return {"block": r["block"], "ts": r["ts"], "delta": r["delta"]}
        st = G.group_starts(r["block"])
        return {"block": r["block"][st], "ts": r["ts"][st], "delta": np.add.reduceat(r["delta"], st)}

    def path_balance(self, addr, income):
        s = self.scaled.get(self.amap.get(addr, -1), 0)
        return GE.ray_mul(s, income) if s >= 0 else -GE.ray_mul(-s, income)


def scan_rows(rows_iter, header, tables, upto_block=None):
    """Balance rows (EV_COLS layout) -> tables[reserve]. Transfer rows (no G.2 change) are skipped."""
    col = {h: i for i, h in enumerate(header)}
    ir, ib, its, ili, ity = col["reserve"], col["block"], col["ts"], col["log_index"], col["type"]
    ip1, ip2, iv, ix, id1, id2 = (col["party1"], col["party2"], col["value_raw"], col["index_ray"], col["delta1_raw"],
                                  col["delta2_raw"])
    n = 0
    for row in rows_iter:
        d1 = row[id1]
        if d1 == "":
            continue
        b = int(row[ib])
        if upto_block is not None and b > upto_block:
            continue
        T = tables[row[ir]]
        if b < T.last_block:
            raise SystemExit(f"STOP: {T.name} events out of block order at {b}")
        T.last_block = b
        typ = row[ity]
        ts, li = int(row[its]), int(row[ili])
        c1 = T.acode(row[ip1].lower())
        if typ == "BalanceTransfer":
            v = int(row[iv])
            T.add(c1, b, ts, li, int(d1), -v)
            T.add(T.acode(row[ip2].lower()), b, ts, li, int(row[id2]), v)
        elif typ in ("Mint", "Burn"):
            T.add(c1, b, ts, li, int(d1), GE.signed_ray_div(int(d1), int(row[ix])))
        else:
            raise SystemExit(f"STOP: balance row of unexpected type {typ}")
        n += 1
    return n


def iter_gz_csv(path):
    with gzip.open(path, "rt", newline="") as f:
        r = csv.reader(f)
        header = next(r)
        yield header
        for row in r:
            yield row


def frozen_event_paths(datasets):
    d = os.path.join(datasets, G.DE)
    return sorted(os.path.join(d, f) for f in os.listdir(d) if re.fullmatch(r"events-(usdc|usdt)-\d{4}\.csv\.gz", f))


def build_event_tables(datasets, ldir, upto_block, extra_rows=None, log=print):
    """Frozen depositor-events + the live event store (+ in-memory rows, e.g. the (store end, asof] gap), rows in
    blocks <= upto_block only. Returns {reserve: Reserve}."""
    t0 = time.time()
    tables = {r: Reserve(r) for r in RESERVES}
    n = 0
    # per reserve: frozen files in year order, then the live store in month order (blocks increase)
    for r in RESERVES:
        for p in frozen_event_paths(datasets):
            if f"events-{r.lower()}-" not in os.path.basename(p):
                continue
            it = iter_gz_csv(p)
            header = next(it)
            n += scan_rows(it, header, tables, upto_block)
    for p in event_files(ldir):
        it = iter_gz_csv(p)
        header = next(it)
        if header != EV_COLS:
            raise SystemExit(f"STOP: {p}: header {header}")
        n += scan_rows(it, header, tables, upto_block)
    if extra_rows:
        n += scan_rows(iter([[str(x) for x in r] for r in extra_rows]), EV_COLS, tables, upto_block)
    for T in tables.values():
        T.finalize()
    log(f"event tables: {n} balance rows, addresses USDC {len(tables['USDC'].addrs)} USDT "
        f"{len(tables['USDT'].addrs)} ({time.time() - t0:.0f}s)")
    return tables


def check_store_rows_within_coverage(ldir):
    st = event_store_status(ldir)
    for p in event_files(ldir):
        it = iter_gz_csv(p)
        header = next(it)
        ib = header.index("block")
        for row in it:
            if int(row[ib]) > st["coveredBlock"] or int(row[ib]) <= FROZEN_ASOF_BLOCK:
                raise SystemExit(f"STOP: {os.path.basename(p)} holds block {row[ib]} outside the logged coverage "
                                 f"({FROZEN_ASOF_BLOCK + 1}..{st['coveredBlock']}): partial write?")
    return st


def anchor_ok(path_raw, chain_raw):
    diff = abs(int(path_raw) - int(chain_raw))
    tol = max(ANCHOR_ABS_RAW, max(int(path_raw), int(chain_raw)) // ANCHOR_REL_DEN)
    return diff <= tol, diff, tol


# ---------------------------------------------------------------------------------------------
# Reserve state, balances, codes (RPC at the asof block)
# ---------------------------------------------------------------------------------------------
def read_reserve_state(rpc, block):
    """b3_segments.read_reserve_state_rpc on the public client, plus getReserveNormalizedIncome."""
    calls = []
    for r in RESERVES:
        a = BA.RESERVES[r]
        calls += [(BA.POOL, BA.call_data("getReserveData", a["asset"])), (a["atoken"], BA.call_data("totalSupply")),
                  (a["asset"], BA.call_data("balanceOf", a["atoken"])),
                  (BA.POOL, XA.cdata("getReserveNormalizedIncome", a["asset"]))]
    res = multicall(rpc, calls, block)
    out = {}
    for k, r in enumerate(RESERVES):
        rd = BA.decode_reserve_data(*res[4 * k])
        if rd["status"] != "ok":
            raise SystemExit(f"STOP: getReserveData {r} at {block}: {rd['status']}")
        inc, st = XA.u256(*res[4 * k + 3])
        if st != "ok" or not inc:
            raise SystemExit(f"STOP: getReserveNormalizedIncome {r} at {block}: {st}")
        out[r] = {"variableBorrowRate_ray": rd["currentVariableBorrowRate"],
                  "liquidityRate_ray": rd["currentLiquidityRate"], "variableDebtToken": rd["variableDebtTokenAddress"],
                  "totalSupply": BA.decode_uint(res[4 * k + 1][1]), "cash": BA.decode_uint(res[4 * k + 2][1]),
                  "normalizedIncome": inc, "liquidityIndex": rd["liquidityIndex"],
                  "lastUpdateTimestamp": rd["lastUpdateTimestamp"]}
    res2 = multicall(rpc, [(out[r]["variableDebtToken"], BA.call_data("totalSupply")) for r in RESERVES], block)
    for k, r in enumerate(RESERVES):
        s = out[r]
        s["variableDebt"] = BA.decode_uint(res2[k][1])
        s["util"] = s["variableDebt"] / s["totalSupply"]
        s["bapr_pct"] = s["variableBorrowRate_ray"] / 10 ** 25
        s["sapr_pct"] = s["liquidityRate_ray"] / 10 ** 25
        for k2 in ("variableBorrowRate_ray", "liquidityRate_ray", "totalSupply", "cash", "variableDebt",
                   "normalizedIncome", "liquidityIndex"):
            s[k2] = str(s[k2])
    return out


def read_balances(rpc, block, pairs, debt_tokens):
    """balanceOf of each (reserve, address) on its aToken, and of the address on both variableDebtTokens (DL-12),
    in one Multicall3 sequence at `block`. Returns {(reserve, address): (balance, {reserve: debt})}."""
    addrs = sorted({a for _, a in pairs})
    calls, keys = [], []
    for r, a in pairs:
        calls.append((BA.RESERVES[r]["atoken"], BA.call_data("balanceOf", a)))
        keys.append(("bal", r, a))
    for a in addrs:
        for r in RESERVES:
            calls.append((debt_tokens[r], BA.call_data("balanceOf", a)))
            keys.append(("debt", r, a))
    res = multicall(rpc, calls, block)
    bal, debt = {}, {}
    for (kind, r, a), (ok, ret) in zip(keys, res):
        if not ok or len(ret) != 32:
            raise SystemExit(f"STOP: balanceOf failed for {kind} {r} {a} at {block}")
        v = int.from_bytes(ret, "big")
        if kind == "bal":
            bal[(r, a)] = v
        else:
            debt.setdefault(a, {})[r] = v
    return {(r, a): (bal[(r, a)], debt[a]) for r, a in pairs}


def read_codes(rpc, addrs, block):
    res = rpc.request_many("eth_getCode", [[a, hex(block)] for a in addrs])
    out = {}
    for a, code in zip(addrs, res):
        if not isinstance(code, str) or not code.startswith("0x"):
            raise SystemExit(f"STOP: eth_getCode {a}: bad result")
        ic, e7 = S.code_kind(code)
        out[a] = {"is_contract": ic, "eip7702": e7, "code_bytes": (len(code) - 2) // 2, "prefix": code[:8]}
    return out


def read_code_store(ldir):
    out = {}
    for row in read_gz_rows(os.path.join(ldir, CODES_SUB, "holder-codes.csv.gz"), CODE_COLS):
        out[row[0]] = {"block": int(row[1]), "is_contract": row[2] == "1", "eip7702": row[3] == "1",
                       "code_bytes": int(row[4]), "prefix": row[5]}
    return out


def append_code_store(ldir, codes, block, now):
    rows = [[a, block, int(v["is_contract"]), int(v["eip7702"]), v["code_bytes"], v["prefix"], now]
            for a, v in sorted(codes.items())]
    return append_gz_rows(os.path.join(ldir, CODES_SUB, "holder-codes.csv.gz"), CODE_COLS, rows)


def read_first_seen(ldir):
    out = {}
    for row in read_gz_rows(os.path.join(ldir, UNITS_SUB, "first-seen.csv.gz"), FIRST_SEEN_COLS):
        k = (row[0], row[1])
        if k in out:
            raise SystemExit(f"STOP: first-seen holds {k} twice")
        out[k] = {"date": row[2], "asof_block": int(row[3]), "asof_ts": int(row[4])}
    return out


# ---------------------------------------------------------------------------------------------
# ETH rounds -> RV7 (DL.2 RV7, DL-5)
# ---------------------------------------------------------------------------------------------
def eth_rounds_upto(datasets, rpc, asof_block, asof_ts, log=print):
    """Rounds with updatedAt <= asof ts: the touch round store, plus (when its coverage is behind asof) the rounds
    after its last stored round read at the asof block (not written to the touch store)."""
    path = os.path.join(datasets, TOUCH_ROUNDS_REL)
    rs = C.read_round_store(path)
    if not rs:
        raise SystemExit("STOP: the touch round store is empty")
    cov = C.round_coverage(os.path.join(datasets, TOUCH_LIVE_REL), "ETH", rs)
    extra = []
    if cov is None or cov < asof_ts:
        if rpc is None:
            raise SystemExit("STOP: the touch round store does not cover asof and no RPC was given")
        feed = C.Feed(rpc, C.FEEDS["ETH"][0], block=hex(asof_block))
        latest = feed.latest()
        if latest.updated_at > asof_ts:
            raise SystemExit("STOP: round in force at the asof block is after asof")
        if latest.round_id > rs[-1].round_id:
            extra = feed.rounds_after(rs[-1], latest)
    used = [r for r in rs if r.updated_at <= asof_ts] + [r for r in extra if r.updated_at <= asof_ts]
    C.check_round_sequence(used)
    meta = {"store": TOUCH_ROUNDS_REL, "storeSha256": sha256_file(path), "storeRounds": len(rs),
            "storeCoveredThrough": cov, "roundsReadAtAsof": len(extra), "roundsUsed": len(used),
            "roundsAfterAsofNotUsed": sum(r.updated_at > asof_ts for r in rs),
            "lastUsed": {"roundId": str(used[-1].round_id), "updatedAt": used[-1].updated_at}}
    return used, meta


def rv7_at_asof(rounds, asof_ts):
    ua = np.array([r.updated_at for r in rounds], dtype=np.int64)
    ans = np.array([float(r.answer) for r in rounds], dtype=float)
    H0 = int(asof_ts) - int(asof_ts) % HOUR
    m = ua <= asof_ts
    rv7, closes = S.rv7_from_rounds(ua[m], ans[m], H0)
    return rv7, H0


# ---------------------------------------------------------------------------------------------
# Cross-venue: frozen per-pair arrays, the live store, features at asof (DL.2 xv, DL-6, DL-7)
# ---------------------------------------------------------------------------------------------
class XvFrozen:
    pass


def frozen_snapshots(datasets):
    """Frozen cross-venue snapshot list [(label, block, ts)]: daily blocks, asof_b1, asof."""
    out = []
    with open(os.path.join(datasets, G.DB, "blocks.csv")) as f:
        for r in csv.DictReader(f):
            if r["kind"] == "daily":
                out.append((r["snapshot"], int(r["block"]), int(r["block_ts"])))
            elif r["kind"] == "asof":
                b1 = (int(r["block"]), int(r["block_ts"]))
    if b1[0] != FROZEN_ASOF_B1:
        raise SystemExit("STOP: blocks.csv asof is not 26,180,400")
    out.append(("asof_b1", b1[0], b1[1]))
    out.append(("asof", FROZEN_ASOF_BLOCK, FROZEN_ASOF_TS))
    return out


def xv_tokens(datasets):
    """Selected cross-venue tokens minus the nested ones (B3-4), as dicts for x_acquire_crossvenue."""
    nest = set()
    adapters = set()
    with open(os.path.join(datasets, S.CV, "nesting.csv")) as f:
        for r in csv.DictReader(f):
            if r["holder_kind"] == "selected_token":
                nest.add(r["holder"].lower())
            elif r["holder_kind"] == "morpho_v2_adapter":
                adapters.add(r["holder"].lower())
    toks = []
    with open(os.path.join(datasets, S.CV, "selected-tokens.csv")) as f:
        for r in csv.DictReader(f):
            a = r["address"].lower()
            if a in nest:
                continue
            toks.append({"address": a, "symbol": r["symbol"], "family": r["family"], "kind": r["kind"],
                         "dec": int(r["token_dec"]), "underlying": r["underlying"].lower(), "udec": int(r["udec"]),
                         "deploy_exact": 0})
    return sorted(toks, key=lambda t: t["address"]), nest, adapters


def parse_price(num, den, status):
    if status == "ok" and num != "" and den != "" and Decimal(den) != 0:
        return float(Decimal(num) / Decimal(den))
    return float("nan")


def load_xv_frozen(datasets, log=print):
    """Per (token, address) share values at every frozen snapshot (b3_segments.load_xv parsing), the exact share
    balance at the frozen asof, and per-token prices (ffilled) at the frozen snapshots."""
    import pandas as pd
    t0 = time.time()
    X = XvFrozen()
    X.snaps = frozen_snapshots(datasets)
    X.sidx = {lab: j for j, (lab, _, _) in enumerate(X.snaps)}
    n = len(X.snaps)
    X.tokens, X.nested, X.adapters = xv_tokens(datasets)
    X.tok = {t["address"]: t for t in X.tokens}
    X.flags = S.load_flags(datasets)
    pr = pd.read_csv(os.path.join(datasets, S.CV, "share-price-daily.csv.gz"), dtype=str, keep_default_na=False)
    pr = pr[pr["snapshot"].isin(X.sidx.keys())]
    X.price = {}
    for tok, g in pr.groupby(pr["token"].str.lower()):
        if tok not in X.tok:
            continue
        arr = np.full(n, np.nan)
        for s_, num, den, st in zip(g["snapshot"], g["price_num"], g["price_den"], g["status"]):
            arr[X.sidx[s_]] = parse_price(num, den, st)
        X.price[tok] = S.ffill_price(arr)
    sp = pd.read_csv(os.path.join(datasets, S.CV, "share-paths-daily.csv.gz"), dtype=str, keep_default_na=False)
    sp["j"] = sp["snapshot"].map(X.sidx)
    if sp["j"].isna().any():
        raise SystemExit("STOP: unknown snapshot in share-paths-daily")
    sp["tok"] = sp["token"].str.lower()
    sp["addr"] = sp["address"].str.lower()
    sp = sp[sp["tok"].isin(X.tok.keys()) & ~sp["addr"].isin(X.adapters)]
    X.S = {}
    X.S0 = {}
    for (tok, a), g in sp.groupby(["tok", "addr"], sort=True):
        g = g.sort_values("j", kind="mergesort")
        j = g["j"].to_numpy(np.int64)
        vals = [int(x) for x in g["shares_raw"]]
        X.S[(tok, a)] = S.pair_series(j, np.array([float(v) for v in vals]), n)
        X.S0[(tok, a)] = vals[-1]                      # change points up to the frozen asof (last snapshot)
    missing = [t["symbol"] for t in X.tokens if t["address"] not in X.price]
    if missing:
        raise SystemExit(f"STOP: no frozen price for {missing}")
    log(f"xv frozen: {len(X.tokens)} tokens, {len(X.S)} pairs ({time.time() - t0:.0f}s)")
    return X


def xv_store_status(ldir):
    lines = read_jsonl(os.path.join(ldir, XV_SUB, "fetch-log.jsonl"))
    cov, cov_ts, last = FROZEN_ASOF_BLOCK, FROZEN_ASOF_TS, None
    for e in lines:
        if int(e["fromBlock"]) != cov + 1:
            raise SystemExit(f"STOP: cross-venue store not contiguous at {e['fromBlock']}")
        cov, cov_ts, last = int(e["toBlock"]), int(e["toBlockTs"]), int(e["fetchedAt"])
    return {"coveredBlock": cov, "coveredTs": cov_ts, "nRanges": len(lines), "lastFetchedAt": last}


def xv_read_store(ldir, upto_block=None):
    """Live cross-venue store: share deltas {(token, address): [(block, shares_delta)]}, daily snapshots and
    their prices."""
    st = xv_store_status(ldir)
    d = os.path.join(ldir, XV_SUB)
    deltas = {}
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if not re.fullmatch(r"events-\d{4}-\d{2}\.csv\.gz", f):
                continue
            for row in read_gz_rows(os.path.join(d, f), XV_EV_COLS):
                b = int(row[1])
                if b > st["coveredBlock"]:
                    raise SystemExit(f"STOP: cross-venue store row at block {b} beyond its coverage")
                if upto_block is not None and b > upto_block:
                    continue
                deltas.setdefault((row[0], row[6]), []).append((b, int(row[8])))
    snaps = [(r[0], int(r[1]), int(r[2])) for r in read_gz_rows(os.path.join(d, "snapshots.csv.gz"), XV_SNAP_COLS)]
    prices = {}
    for r in read_gz_rows(os.path.join(d, "prices.csv.gz"), XV_PRICE_COLS):
        prices.setdefault(r[0], {})[r[2]] = parse_price(r[6], r[7], r[8])
    return {"status": st, "deltas": deltas, "snaps": snaps, "prices": prices}


def xv_price_rows(X, rpc, block, label, pools):
    """One multicall at `block` with every token's price calls -> rows in the share-price-daily layout."""
    plan = []
    for t in X.tokens:
        pool = pools.get(t["address"]) if t["kind"].startswith("atoken") else None
        cs = XA.price_calls(t, pool)
        plan.append((t, len(cs)))
    calls = [c for t in X.tokens for c in XA.price_calls(t, pools.get(t["address"]) if t["kind"].startswith("atoken")
                                                          else None)]
    res = multicall(rpc, calls, block, chunk=100)
    rows, i = [], 0
    for t, k in plan:
        p = XA.price_value(t, res[i:i + k], block)
        i += k
        if p is None or "status" in p:
            rows.append([label, block, t["address"], t["symbol"], t["kind"], "", "", "", (p or {}).get("status", "none")])
        elif t["kind"] == "erc4626":
            rows.append([label, block, t["address"], t["symbol"], t["kind"], "convertToAssets(probe)", p["assets"],
                         p["probe"], "ok"])
        elif t["kind"].startswith("atoken"):
            rows.append([label, block, t["address"], t["symbol"], t["kind"], "getReserveNormalizedIncome", p["income"],
                         GE.RAY, "ok"])
        elif t["kind"] == "ctoken":
            rows.append([label, block, t["address"], t["symbol"], t["kind"], "exchangeRateStored", p["rate"], 10 ** 18,
                         "ok"])
        else:
            rows.append([label, block, t["address"], t["symbol"], t["kind"],
                         f"totalSupply*1e15/totalSupplyBase ({p['totalSupply']}/{p['totalSupplyBase']}; stored "
                         f"baseSupplyIndex {p['baseSupplyIndex']} at {p['lastAccrualTime']})", f"{p['index']:.6f}",
                         XA.COMET_INDEX_SCALE, "ok"])
    return rows


def xv_pools(X, rpc, block):
    toks = [t for t in X.tokens if t["kind"].startswith("atoken")]
    res = multicall(rpc, [(t["address"], XA.cdata("POOL")) for t in toks], block)
    out = {}
    for t, r in zip(toks, res):
        a = XA.addr_word(*r)
        if not a:
            raise C.RpcError(f"POOL() of {t['symbol']} unreadable")
        out[t["address"]] = a
    return out


def xv_decode_logs(X, logs, rpc):
    """Live cross-venue logs (all selected tokens, sorted by block / log index) -> share-delta rows of tracked
    (address-flags) addresses, as x_acquire_crossvenue.decode_token: per token and transaction,
    decode_event + ERC-4626 silent shares; Comet present value -> principal with the exact baseSupplyIndex."""
    U = X.flags
    by_tok = {}
    for lg in logs:
        by_tok.setdefault(lg["address"], []).append(lg)
    pending, rows = [], []
    for tok, lgs in sorted(by_tok.items()):
        t = X.tok.get(tok)
        if t is None:
            raise SystemExit(f"STOP: cross-venue log of an untracked token {tok}")
        kind = t["kind"]
        for grp in XA.iter_tx_groups(lgs):
            evs = []
            for lg in grp:
                try:
                    evs.append(XA.decode_event(kind, lg["topics"], lg["data"]))
                except XA.DecodeError as e:
                    raise SystemExit(f"STOP: cross-venue decode error {t['symbol']} {lg['block']}/{lg['log_index']}: {e}")
            silent = XA.erc4626_silent_shares(evs) if kind == "erc4626" else {}
            for i, (lg, ev) in enumerate(zip(grp, evs)):
                deltas = list(ev["deltas"]) if ev["type"] in XA.BALANCE_TYPES[kind] else []
                if ev["type"] in ("Deposit", "Withdraw") and kind == "erc4626" and i in silent:
                    owner, sh = silent[i]
                    deltas = [(owner, sh, sh)]
                for ad, d, sc in deltas:
                    if ad not in U:
                        continue
                    rec = [tok, lg["block"], lg["ts"], lg["tx"], lg["log_index"], ev["type"], ad, d, sc]
                    if kind == "comet":
                        pending.append(rec)
                    rows.append(rec)
    if pending:                                          # exact Comet supply index at each event block
        need = sorted({(r[0], r[1]) for r in pending})
        idx = {}
        for b in sorted({b for _, b in need}):
            toks = [tk for tk, bb in need if bb == b]
            res = multicall(rpc, [(tk, XA.cdata("totalsBasic")) for tk in toks], b)
            for tk, (ok, ret) in zip(toks, res):
                if not ok or len(ret) < 256:
                    raise C.RpcError(f"Comet totalsBasic unreadable at {b}")
                idx[(tk, b)] = int.from_bytes(ret[:32], "big")
        for r in pending:
            ix = idx[(r[0], r[1])]
            if not ix:
                raise C.RpcError("Comet index 0")
            r[8] = int(round(r[7] * XA.COMET_INDEX_SCALE / ix))
    rows.sort(key=lambda r: (r[1], r[4], r[0], r[6]))
    return rows


def update_xv_store(ldir, X, logs_client, rpc, target_block, head, clock=time.time, log=print):
    """Append the cross-venue logs up to target_block (share deltas of tracked addresses), every daily snapshot
    (last block with ts < 00:00Z) whose block the store then covers, and its prices. Writes nothing on failure."""
    st = xv_store_status(ldir)
    lo = st["coveredBlock"] + 1
    d = os.path.join(ldir, XV_SUB)
    if target_block < lo:
        return {"appended": 0, "toBlock": st["coveredBlock"], "note": "store already covers target"}
    logs = logs_client.get_logs([t["address"] for t in X.tokens], XV_TOPICS, lo, target_block)
    fill_ts(logs, rpc)
    rows = xv_decode_logs(X, logs, rpc)
    tb = get_block(rpc, target_block)
    have = [r[0] for r in read_gz_rows(os.path.join(d, "snapshots.csv.gz"), XV_SNAP_COLS)]
    last_day = max([datetime.strptime(x, "%Y-%m-%d").date() for x in have], default=None)
    day = (last_day.toordinal() + 1) if last_day else datetime.fromtimestamp(FROZEN_ASOF_TS, timezone.utc).date().toordinal() + 1
    new_snaps, new_prices = [], []
    pools = None
    while True:
        dd = datetime.fromordinal(day).replace(tzinfo=timezone.utc)
        T = int(dd.timestamp())
        if T > tb["ts"]:
            break
        b, bts, _ = find_block_before(rpc, T, (target_block, tb["ts"]))
        if b > target_block:
            break
        lab = dd.strftime("%Y-%m-%d")
        pools = pools or xv_pools(X, rpc, target_block)
        new_prices += xv_price_rows(X, rpc, b, lab, pools)
        new_snaps.append([lab, b, bts])
        day += 1
    by_month = {}
    for r in rows:
        by_month.setdefault(month_of(r[2]), []).append(r)
    entry = {"fromBlock": lo, "toBlock": target_block, "toBlockTs": tb["ts"], "toBlockHash": tb["hash"],
             "nLogs": len(logs), "nShareRows": len(rows), "snapshotsAdded": [s[0] for s in new_snaps],
             "pricesNotOk": sum(1 for p in new_prices if p[8] != "ok"), "fetchedAt": int(clock())}
    paths = [os.path.join(d, f"events-{m}.csv.gz") for m in sorted(by_month)] + [
        os.path.join(d, f) for f in ("snapshots.csv.gz", "prices.csv.gz", "fetch-log.jsonl")]
    with AppendTxn(paths):
        for m, rs in sorted(by_month.items()):
            append_gz_rows(os.path.join(d, f"events-{m}.csv.gz"), XV_EV_COLS, rs)
        append_gz_rows(os.path.join(d, "snapshots.csv.gz"), XV_SNAP_COLS, new_snaps)
        append_gz_rows(os.path.join(d, "prices.csv.gz"), XV_PRICE_COLS, new_prices)
        append_jsonl(os.path.join(d, "fetch-log.jsonl"), entry)
    log(f"cross-venue store: +{len(logs)} logs ({len(rows)} share rows of tracked addresses), snapshots "
        f"{entry['snapshotsAdded']}")
    return entry


def xv_features(X, live, asof_block, asof_ts, asof_prices=None, gap_rows=None):
    """Per tracked address at asof: (other-venue USD, 7-day flow USD, drop flag, venues > $100k) and the snapshot
    rule used (DL-6). live = xv_read_store(...) or None (frozen only); asof_prices {token: price} for a live asof."""
    snaps = [(lab, b, ts, ("f", j)) for j, (lab, b, ts) in enumerate(X.snaps) if b <= asof_block]
    if live:
        snaps += [(lab, b, ts, ("l", lab)) for lab, b, ts in live["snaps"] if b < asof_block]
    if asof_block not in {s[1] for s in snaps}:
        if asof_prices is None:
            raise SystemExit("STOP: a live asof needs its prices")
        snaps.append(("asof-live", asof_block, asof_ts, ("a", None)))
    snaps.sort(key=lambda s: s[1])
    if snaps[-1][1] != asof_block:
        raise SystemExit("STOP: asof snapshot is not the last")
    target = asof_ts - XV_BASE_LAG
    base_i = min(range(len(snaps)), key=lambda i: (abs(snaps[i][2] - target), snaps[i][2]))
    if base_i >= len(snaps) - 1:
        raise SystemExit("STOP: the 7-day base is the asof snapshot")
    use = [snaps[base_i]] + snaps[base_i + 1:]          # base, window ..., asof
    # prices per token at the used snapshots (live failures take the last ok price before them)
    P = {}
    for t in X.tokens:
        tok = t["address"]
        seq = []
        for lab, b, ts, (kind, key) in snaps:
            if kind == "f":
                v = X.price[tok][key]
            elif kind == "l":
                v = live["prices"].get(key, {}).get(tok, float("nan"))
            else:
                v = asof_prices.get(tok, float("nan"))
            seq.append(v)
        seq = S.ffill_price(np.array(seq))
        P[tok] = seq[base_i:]
    deltas = {}
    if live:
        for k, v in live["deltas"].items():
            deltas.setdefault(k, []).extend((b, d) for b, d in v if b <= asof_block)
    for r in gap_rows or []:
        if r[1] <= asof_block:
            deltas.setdefault((r[0], r[6]), []).append((r[1], int(r[8])))
    pairs = sorted(set(X.S.keys()) | set(deltas.keys()))
    out = {}
    nuse = len(use)
    for tok, a in pairs:
        t = X.tok.get(tok)
        if t is None:
            continue
        Sv = np.zeros(nuse)
        dl = sorted(deltas.get((tok, a), []))
        db = np.array([b for b, _ in dl], dtype=np.int64)
        dc = np.cumsum([d for _, d in dl]) if dl else np.zeros(0)
        s0 = X.S0.get((tok, a), 0)
        for k, (lab, b, ts, (kind, key)) in enumerate(use):
            if kind == "f":
                Sv[k] = X.S[(tok, a)][key] if (tok, a) in X.S else 0.0
            else:
                n_ = int(np.searchsorted(db, b, side="right"))
                Sv[k] = float(s0 + (int(dc[n_ - 1]) if n_ else 0))
        scale = 10.0 ** t["udec"]
        price = P[tok]
        V = Sv * price / scale
        ov = V[-1]
        fl = (Sv[-1] - Sv[0]) * price[-1] / scale
        dr = bool(V[0] > 0 and V[1:].min() <= S.XV_DROP_KEEP * V[0])
        cnt = int(V[-1] > S.XV_VENUE_MIN_USD)
        o = out.setdefault(a, [0.0, 0.0, False, 0])
        o[0] += ov
        o[1] += fl
        o[2] |= dr
        o[3] += cnt
    rule = {"base": {"snapshot": use[0][0], "block": use[0][1], "ts": use[0][2]},
            "window": [{"snapshot": s[0], "block": s[1], "ts": s[2]} for s in use[1:]], "target_ts": target}
    return out, rule


# ---------------------------------------------------------------------------------------------
# Frozen model (DL.3, DL-1)
# ---------------------------------------------------------------------------------------------
class Frozen:
    pass


def read_csv_dicts(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def load_frozen(datasets, log=print, b4=None):
    """The B3 frozen model at the asof anchor: asof parameters, theta_seg, seg_pop, shipped rungs, labels, and
    each universe unit's theta_i, own rate and first daily anchor >= $1M (recomputed from the frozen inputs).
    b4 = load_b4_frozen(...) adds model B4 (load_frozen_b4 on the same rows)."""
    from scipy.special import expit
    t0 = time.time()
    F = Frozen()
    with open(os.path.join(datasets, RUN_REL, "results.json")) as f:
        res_json = json.load(f)
    F.asof_params = res_json["asof_params"]
    F.features = res_json["features"]
    if list(F.features["v3"]) != list(S.FEATURES_V3):
        raise SystemExit("STOP: results.json feature list differs from b3_segments.FEATURES_V3")
    with open(os.path.join(datasets, RUN_REL, "shipped-b3.json")) as f:
        shipped = json.load(f)
    lab = {(r["cell"], r["segment"]): r for r in read_csv_dicts(os.path.join(datasets, RUN_REL, "labels.csv"))}
    labd = {(r["cell"], r["segment"]): r for r in read_csv_dicts(os.path.join(datasets, RUN_REL, "labels-d1.csv"))}
    F.table = {}
    for c in G.CELLS:
        for si, s in enumerate(S.SEG_IDS):
            sh = shipped["cells"][c["id"]][s]
            lf, ld = lab[(c["id"], s)], labd[(c["id"], s)]
            if (lf["shipped"] or None) != sh["shipped"] or (ld["shipped"] or None) != sh["shipped"]:
                raise SystemExit(f"STOP: shipped rung differs between frozen files at {c['id']} {s}")
            if ld["label_final"] != lf["label_final"]:
                raise SystemExit(f"STOP: label_final differs between labels.csv and labels-d1.csv at {c['id']} {s}")
            F.table[(c["id"], s)] = {"rung": sh["shipped"], "label": ld["label_display"],
                                     "label_final": lf["label_final"], "label_preholdout": sh["label"],
                                     "display_reason": ld["display_reason"],
                                     "seg_pop": F.asof_params[c["id"] + ":v2"]["seg_pop"][si]}
    ctx, res = G.load_main(datasets, log=lambda *a: None)
    rows = G.build_rows(ctx, res, compute_labels=True)
    X = S.load_xv(datasets, ctx, log=lambda *a: None)
    cu, missing = S.unit_contract(rows, X.flags)
    if missing:
        raise SystemExit(f"STOP: {len(missing)} universe addresses missing from address-flags.csv")
    rows["X3"], rows["band"], rows["seg"] = S.b3_features(rows, X, cu)
    nU = rows["n_units"]
    F.theta, F.own, F.pop = {}, {}, {}
    worst = 0.0
    for ci, c in enumerate(G.CELLS):
        if c["kind"] != "x":
            continue
        tr = rows["RES"][:, c["hi"]] & ~rows["CAP"][:, ci] & rows["feat_ok"]
        tri = np.nonzero(tr)[0]
        y = rows["Y"][tri, ci].astype(float)
        u = rows["unit"][tri]
        O = np.bincount(u, weights=y, minlength=nU)
        nn = np.bincount(u, minlength=nU)
        for ver in ("v2", "v3"):
            f = F.asof_params[c["id"] + ":" + ver]
            if f["params"] is None:
                raise SystemExit(f"STOP: single-class asof fit at {c['id']} {ver}")
            p0 = expit(G.z_from_params(f["params"], rows["X3"][tri, :S.NF3[ver]]))
            E = np.bincount(u, weights=p0, minlength=nU)
            th = G.eb_theta(O, E)
            F.theta[(c["id"], ver)] = th
            if ver == "v3":                                # DL-1 check: theta_seg reproduces results.json
                pins = expit(G.z_from_params(f["params"], rows["X3"][tri, :S.NF3[ver]]) + np.log(th[u]))
                ts_, _, _ = S.theta_segments(y, pins, rows["seg"][tri])
                worst = max(worst, float(np.max(np.abs(ts_ - np.array(f["theta_seg"])))))
        pop = F.asof_params[c["id"] + ":v2"]["pop"]
        if abs(float(y.mean()) - pop) > 1e-12:
            raise SystemExit(f"STOP: asof training rate {y.mean()} != results.json pop {pop} at {c['id']}")
        F.pop[c["id"]] = pop
        F.own[c["id"]] = G.own_rate(O, nn, pop)
    if worst > 1e-9:
        raise SystemExit(f"STOP: recomputed theta_seg differ from results.json by {worst:.3g}")
    F.theta_seg_check = worst
    F.unit = {}
    F.first_big_ts = {}
    for R in res:
        base = rows["unit_base"][R.name]
        t0b = G.first_big_day(R.A, R.Av, ctx.D)
        for u, a in enumerate(R.addrs):
            F.unit[(R.name, a)] = base + u
            if t0b[u] >= 0:
                F.first_big_ts[base + u] = int(ctx.T[t0b[u]])
    F.flags = X.flags
    F.n_units = nU
    F.n_train_rows = int(rows["feat_ok"].sum())
    F.b4 = None
    if b4 is not None:                                   # DL-20: B4's v2 is B3's v2 (same frozen asof fit)
        for c in X_CELLS:
            a_ = {k: F.asof_params[c["id"] + ":v2"][k] for k in ("params", "const_p0", "pop", "seg_pop")}
            b_ = {k: b4["shipped"]["asof_params"][c["id"]]["v2"][k] for k in ("params", "const_p0", "pop", "seg_pop")}
            if a_ != b_:
                raise SystemExit(f"STOP: B4 asof v2 differs from B3 asof v2 at {c['id']}")
        F.b4 = load_frozen_b4(ctx, res, rows, b4, log=log)
    del rows, res, X, ctx
    gc.collect()
    log(f"frozen model: {nU} universe units, theta_i recomputed (theta_seg check {worst:.2g}) "
        f"({time.time() - t0:.0f}s)")
    return F


# ---------------------------------------------------------------------------------------------
# Model B4 (B4.5): frozen inputs, theta recompute, live daily balances, features, grid (DL-19..DL-24)
# ---------------------------------------------------------------------------------------------
def load_b4_inputs(datasets, shipped_rel, shipped_sha, labels_rel, labels_sha):
    """The frozen B4 files named by the issuer flags; each sha256 must equal the flag (DL.7)."""
    out = {}
    for name, rel, want in (("shipped", shipped_rel, shipped_sha), ("labels", labels_rel, labels_sha)):
        pth = os.path.join(datasets, rel)
        got = sha256_file(pth)
        if got != (want or "").lower():
            raise SystemExit(f"STOP: sha256 mismatch for frozen B4 input {rel}: {got} != registered {want}")
        out[name + "_meta"] = {"path": rel, "sha256": got, "bytes": os.path.getsize(pth)}
    with open(os.path.join(datasets, shipped_rel)) as f:
        out["shipped"] = json.load(f)
    out["labels"] = {(r["cell"], r["segment"]): r for r in read_csv_dicts(os.path.join(datasets, labels_rel))}
    return out


def load_frozen_b4(ctx, res, rows, b4, log=print):
    """B4 asof model on the frozen rows (B4-5, B4-6, B4-10), nothing refit: v4a features of every row
    (b4_depositor.v4a_features), theta_v4a = (O + 3) / (E + 3) with p0 from the frozen asof v4a params, discounted
    O_d, E_d with T_ref = the frozen asof time, m_seg recomputed (b4_depositor.m_by_segment) and required to equal
    shipped-b4.json, the per-(segment) discounted sums too; per unit the flagged prior origins per size and the
    daily anchors (for the live v4a features)."""
    from scipy.special import expit
    t0 = time.time()
    shp, labs = b4["shipped"], b4["labels"]
    ap = shp["asof_params"]
    B4.v4a_features(rows, res, ctx.D)
    nU = rows["n_units"]
    out = {"params": {}, "theta4": {}, "Od": {}, "Ed": {}, "mseg": {}, "table": {}, "inputs": {
        k: b4[k] for k in ("shipped_meta", "labels_meta")}}
    worst = 0.0
    for ci, c in enumerate(G.CELLS):
        if c["kind"] != "x":
            continue
        cid = c["id"]
        f = ap[cid]
        if f["v4a"]["params"] is None:
            raise SystemExit(f"STOP: single-class B4 asof fit at {cid}")
        tr = rows["RES"][:, c["hi"]] & ~rows["CAP"][:, ci] & rows["feat_ok"]
        tri = np.nonzero(tr)[0]
        y = rows["Y"][tri, ci].astype(float)
        u = rows["unit"][tri]
        X4 = B4.x4_matrix(rows, B4.XKEYS[c["xi"]])[tri]
        p0 = expit(G.z_from_params(f["v4a"]["params"], X4))
        O = np.bincount(u, weights=y, minlength=nU)
        E = np.bincount(u, weights=p0, minlength=nU)
        w = B4.discount_weights(rows["T0"][tri], f["v4b"]["T_ref"])
        Od = np.bincount(u, weights=w * y, minlength=nU)
        Ed = np.bincount(u, weights=w * p0, minlength=nU)
        mseg, info = B4.m_by_segment(u, rows["seg"][tri], w, y, p0, nU)
        if list(mseg) != list(f["v4b"]["m_seg"]):
            raise SystemExit(f"STOP: recomputed B4 m_seg {list(mseg)} != shipped-b4.json {f['v4b']['m_seg']} at {cid}")
        for sj in range(S.NSEG):
            for k in ("O_d", "E_d"):
                a_, b_ = float(info[sj][k]), float(f["v4b"]["seg_info"][sj][k])
                worst = max(worst, abs(a_ - b_) / max(1.0, abs(b_)))
        out["params"][cid] = f["v4a"]
        out["theta4"][cid] = G.eb_theta(O, E)
        out["Od"][cid], out["Ed"][cid], out["mseg"][cid] = Od, Ed, np.asarray(mseg, float)
        for sj, sid in enumerate(S.SEG_IDS):
            cl = shp["cells"][cid][sid]
            lr = labs[(cid, sid)]
            if (lr["shipped"] or None) != cl["shipped"] or lr["label_final"] != cl["label_final"]:
                raise SystemExit(f"STOP: labels-dev.csv differs from shipped-b4.json at {cid} {sid}")
            out["table"][(cid, sid)] = {"rung": cl["shipped"], "label": cl["label_final"], "label_dev": cl["label_dev"],
                                        "holdout_outcome": cl["holdout_outcome"], "seg_pop": f["v2"]["seg_pop"][sj],
                                        "b3_rung": lr["b3_shipped"] or None}
    if worst > 1e-9:
        raise SystemExit(f"STOP: recomputed B4 discounted (O, E) per segment differ from shipped-b4.json ({worst:.3g})")
    out["check"] = {"m_seg_equal": True, "seg_info_max_rel_diff": worst}
    out["T"] = np.asarray(ctx.T, dtype=np.int64)
    out["anchors"] = B4.anchor_matrix(res, ctx.D)
    flags = {}
    for xk in B4_XK:
        ci24 = B4.xcell24(xk)
        m = rows["RES"][:, 2] & (rows["Y"][:, ci24] == 1)
        uu, tt = rows["unit"][m], rows["t"][m]
        o = np.lexsort((tt, uu))
        uu, tt = uu[o], tt[o]
        st_ = G.group_starts(uu)
        en = np.r_[st_[1:], len(uu)]
        flags[xk] = {int(uu[a]): tt[a:b].copy() for a, b in zip(st_, en)}
    out["flags"] = flags
    log(f"frozen model B4: theta_v4a / discounted O,E recomputed, m_seg equal to shipped-b4.json in 25 cells "
        f"(segment sums max rel diff {worst:.2g}) ({time.time() - t0:.0f}s)")
    return out


def read_incomes(rpc, block):
    res = multicall(rpc, [(BA.POOL, XA.cdata("getReserveNormalizedIncome", BA.RESERVES[r]["asset"])) for r in RESERVES],
                    block)
    out = {}
    for r, (ok, ret) in zip(RESERVES, res):
        v, st = XA.u256(ok, ret)
        if st != "ok" or not v:
            raise C.RpcError(f"getReserveNormalizedIncome {r} unreadable at {block}")
        out[r] = v
    return out


def read_daily_store(ldir):
    out = []
    for row in read_gz_rows(os.path.join(ldir, DAILY_SUB, "snapshots.csv.gz"), DAILY_COLS):
        out.append({"date": row[0], "block": int(row[1]), "ts": int(row[2]), "T": day_ts(row[0]),
                    "income": {"USDC": int(row[3]), "USDT": int(row[4])}})
    return out


def day_ts(date):
    return int(datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def update_daily_store(ldir, rpc, upto_ts, head, clock=time.time, log=print):
    """DL-21: one row per UTC day from 2026-10-14 with 00:00Z <= upto_ts: the last block with ts < 00:00Z (as the
    frozen daily anchors) and getReserveNormalizedIncome of both reserves at it. Appended as one transaction."""
    have = read_daily_store(ldir)
    day = (datetime.strptime(have[-1]["date"], "%Y-%m-%d").date().toordinal() + 1) if have else \
        datetime.strptime(LIVE_DAILY_FIRST, "%Y-%m-%d").date().toordinal()
    new = []
    while True:
        dd = datetime.fromordinal(day).replace(tzinfo=timezone.utc)
        T = int(dd.timestamp())
        if T > upto_ts:
            break
        b, bts, _ = find_block_before(rpc, T, head)
        inc = read_incomes(rpc, b)
        new.append([dd.strftime("%Y-%m-%d"), b, bts, inc["USDC"], inc["USDT"], int(clock())])
        day += 1
    pth = os.path.join(ldir, DAILY_SUB, "snapshots.csv.gz")
    with AppendTxn([pth]):
        append_gz_rows(pth, DAILY_COLS, new)
    if new:
        log(f"daily store: +{len(new)} days {[r[0] for r in new]}")
    return {"appended": [r[0] for r in new]}


def live_daily_unit(T_, r, a, days, asof_ts):
    """DL-21/22: per live day (00:00Z <= asof ts): the event-path balance at the day's block and, for days with
    00:00Z + 24 h <= asof ts and balance >= $1M (a daily origin), y(x, 24 h) per size on the event path."""
    blocks = T_.blocks_of(a)
    out = []
    for d in days:
        if d["T"] > asof_ts:
            continue
        bal = T_.balance_at(a, d["block"], d["income"][r])
        flags = {}
        if bal >= G.MIN_BAL and d["T"] + DAY <= asof_ts:
            mn, has, _ = truth_unit(blocks, bal, d["block"], d["T"], DAY)
            for x in G.SIZES:
                flags[f"x{x}"] = bool(G.label_x(np.array([bal]), np.array([mn]), np.array([has]), x)[0])
        out.append({"T": d["T"], "bal": bal, "flags": flags})
    return out


def b4_features_at(Fb, gu, live, bal_asof, asof_ts):
    """B4-10 asof features from frozen + live daily data (b4_depositor.hist_at / maxdd_at): per size
    [log1p n_x90, maxdd90, log1p days since]; maxdd90 over the daily balances with 00:00Z in [asof - 90 d, asof]
    and the asof balance."""
    Tf = Fb["T"]
    D_ = len(Tf)
    Tl = np.array([d["T"] for d in live], dtype=np.int64)
    T_all = np.r_[Tf, Tl]
    if gu is not None:
        af = Fb["anchors"][gu]
        bal_days = np.r_[np.where(np.isfinite(af), af, 0.0), np.array([float(d["bal"]) for d in live])]
        valid = np.r_[np.isfinite(af), np.ones(len(live), bool)]
    else:
        bal_days = np.r_[np.zeros(D_), np.array([float(d["bal"]) for d in live])]
        valid = np.r_[np.zeros(D_, bool), np.ones(len(live), bool)]
    mdd = B4.maxdd_at(T_all, bal_days, valid, asof_ts, bal_asof)
    out = {}
    for xk in B4_XK:
        fd = list(Fb["flags"][xk].get(gu, [])) if gu is not None else []
        fd += [D_ + j for j, d in enumerate(live) if d["flags"].get(xk)]
        n, days = B4.hist_at(T_all, fd, asof_ts)
        out[xk] = [math.log1p(n), mdd, math.log1p(days)]
    return out


def forecast_grid_b4(F, x2, f4, gu, seg, bal, cash, v2_fixed):
    """B4 rung grids (v2 = the B3 grid, the same frozen fit), the B4 shipped rung's p, the D1 display (model cells
    fixed among themselves, population cells among themselves, capped left out)."""
    Fb = F.b4
    capx = np.array([x * bal > 100 * cash for x in G.SIZES])
    raw = {r: np.full((G.NH, G.NX), np.nan) for r in ("v4a", "v4b")}
    sid = S.SEG_IDS[seg]
    for c in X_CELLS:
        hi, xi, cid = c["hi"], c["xi"], c["id"]
        prm = Fb["params"][cid]
        x4 = np.array(list(x2[:B4.KEEP_V2]) + f4[f"x{c['x']}"], float)[None]
        th4 = 1.0 if gu is None else float(Fb["theta4"][cid][gu])
        raw["v4a"][hi, xi] = G.predict_p(prm["params"], prm["const_p0"], x4, np.array([th4]))[0][0]
        Od = 0.0 if gu is None else float(Fb["Od"][cid][gu])
        Ed = 0.0 if gu is None else float(Fb["Ed"][cid][gu])
        thb = float(B4.theta_v4b(Od, Ed, Fb["mseg"][cid][seg]))
        raw["v4b"][hi, xi] = G.predict_p(prm["params"], prm["const_p0"], x4, np.array([thb]))[0][0]
    fixed = {"v2": v2_fixed}
    for r in ("v4a", "v4b"):
        fixed[r] = G.monotone_fix_masked(raw[r][None], capx[None])[0]
    comp = np.full((G.NH, G.NX), np.nan)
    model = np.zeros((G.NH, G.NX), bool)
    for c in X_CELLS:
        hi, xi = c["hi"], c["xi"]
        tb = Fb["table"][(c["id"], sid)]
        if tb["rung"]:
            model[hi, xi] = True
            comp[hi, xi] = fixed[tb["rung"]][hi, xi]
        else:
            comp[hi, xi] = tb["seg_pop"]
    disp = P1.d1_fix(comp, model, capx)
    ps = np.where(np.broadcast_to(capx[None, :], comp.shape), np.nan, comp)
    return {"fixed": fixed, "raw": raw, "ps": ps, "disp": disp, "capx": capx, "model": model}


# ---------------------------------------------------------------------------------------------
# Unit features and the forecast grid (DL.4, DL-5, DL-9)
# ---------------------------------------------------------------------------------------------
def unit_feature_row(reserve, addr, bal, st, st24, rv7, logs, age_days, contract, xv, xv_known, asof_ts, asof_block):
    """b3_segments.panel_compute feature row (22 values, FEATURES_V3 order). xv = (ov, fl, dr, cnt) or None."""
    f7, dc, ds = G.own_flow_at(logs["ts"], logs["delta_f"], logs["block"], asof_ts, asof_block)
    cash, sup = int(st["cash"]), int(st["totalSupply"])
    util, bapr = st["util"], st["bapr_pct"]
    x2 = [util, util - st24["util"], bapr, bapr - st24["bapr_pct"], rv7, math.log10(bal / G.MICRO),
          math.log1p(age_days), 1.0 if reserve == "USDT" else 0.0, math.log(cash / bal), bal / sup, f7 / bal,
          math.log1p(dc), math.log1p(ds)]
    band = int(S.band_of([bal])[0])
    seg = int(S.segment_of([contract], [band])[0])
    if xv is None:
        x3 = x2 + [float(contract), float(band == 1), float(band == 2)] + [float("nan")] * 6
    else:
        ov, fl, dr, cnt = xv
        balu = bal / G.MICRO
        x3 = x2 + [float(contract), float(band == 1), float(band == 2), math.log1p(ov), ov / (ov + balu), fl / balu,
                   float(dr), float(cnt), float(xv_known)]
    return x3, seg, band


def forecast_grid(F, x3, gu, seg, bal, cash, xv_ok):
    """Per-rung masked-fixed grids (NH, NX), the shipped-rung p, the composite D1 display, own rates, caps."""
    xr = np.array(x3, float)[None]
    capx = np.array([x * bal > 100 * cash for x in G.SIZES])
    raw = {r: np.full((G.NH, G.NX), np.nan) for r in RUNGS}
    for c in X_CELLS:
        hi, xi, cid = c["hi"], c["xi"], c["id"]
        for ver in ("v2", "v3"):
            if ver == "v3" and not xv_ok:
                continue
            f = F.asof_params[cid + ":" + ver]
            th = 1.0 if gu is None else float(F.theta[(cid, ver)][gu])
            p, _ = G.predict_p(f["params"], f["const_p0"], xr[:, :S.NF3[ver]], np.array([th]))
            raw[ver][hi, xi] = p[0]
            if ver == "v3":
                raw["v3s"][hi, xi] = S.odds_mult(p, f["theta_seg"][seg])[0]
    fixed = {r: (G.monotone_fix_masked(raw[r][None], capx[None])[0] if (r == "v2" or xv_ok) else raw[r])
             for r in RUNGS}
    comp = np.full((G.NH, G.NX), np.nan)
    model = np.zeros((G.NH, G.NX), bool)
    unavail = np.zeros((G.NH, G.NX), bool)
    ps = np.full((G.NH, G.NX), np.nan)
    own = np.full((G.NH, G.NX), np.nan)
    sid = S.SEG_IDS[seg]
    for c in X_CELLS:
        hi, xi, cid = c["hi"], c["xi"], c["id"]
        tb = F.table[(cid, sid)]
        own[hi, xi] = F.pop[cid] if gu is None else float(F.own[cid][gu])
        if tb["rung"]:
            model[hi, xi] = True
            if tb["rung"] != "v2" and not xv_ok:
                unavail[hi, xi] = True
                continue
            comp[hi, xi] = fixed[tb["rung"]][hi, xi]
        else:
            comp[hi, xi] = tb["seg_pop"]
        ps[hi, xi] = comp[hi, xi]
    cap = np.broadcast_to(capx[None, :], (G.NH, G.NX))
    fm = P1.monotone_fix_cells(comp[None], (~model | cap | unavail)[None])[0]
    fp = P1.monotone_fix_cells(comp[None], (model | cap)[None])[0]
    disp = np.where(cap | unavail, np.nan, np.where(model, fm, fp))
    ps = np.where(cap, np.nan, ps)
    return {"fixed": fixed, "raw": raw, "ps": ps, "disp": disp, "own": own, "capx": capx, "model": model,
            "unavail": unavail}


# ---------------------------------------------------------------------------------------------
# Issue files: CSV columns, hash chain, refusal guards (DL.4, DL.7)
# ---------------------------------------------------------------------------------------------
UNIT_COLS = ["reserve", "address", "status", "new_unit", "segment", "holder_contract", "contract_source", "balance_raw",
             "path_raw", "anchor_diff_raw", "anchor_tol_raw", "cash_over_bal", "age_days", "age_source", "xv_status",
             "vdebt_same_raw", "vdebt_other_raw"] + [f"cap_x{x}" for x in G.SIZES]
FEAT_COLS = list(S.FEATURES_V3)
CELL_FIELDS = ("v2", "v3", "v3s", "rung", "ps", "disp", "label", "own")
CELL_COLS = [f"{c['id']}_{k}" for c in X_CELLS for k in CELL_FIELDS]
CSV_HEADER = UNIT_COLS + FEAT_COLS + CELL_COLS
B4_UNIT_COLS = (["b4_maxdd90"] + [f"b4_log1p_n_x90_{xk}" for xk in B4_XK] + [f"b4_log1p_days_{xk}" for xk in B4_XK]
                + ["b4_live_days", "b4_live_origins"])
B4_CELL_FIELDS = ("v4a", "v4b", "rung4", "ps4", "disp4", "label4")
B4_CELL_COLS = [f"{c['id']}_{k}" for c in X_CELLS for k in B4_CELL_FIELDS]
CSV_HEADER_B4 = CSV_HEADER + B4_UNIT_COLS + B4_CELL_COLS


def issues_dir(ldir):
    return os.path.join(ldir, ISSUES_SUB)


def list_issues(idir):
    if not os.path.isdir(idir):
        return []
    return sorted((m.group(1), n) for n in os.listdir(idir) if (m := ISSUE_JSON_RE.match(n)))


def verify_chain(idir):
    """[] when intact. Header i: prevSha256 = sha256(bytes of header i-1) (genesis 64 zeros), csvSha256 =
    sha256(bytes of its CSV); chain.jsonl line i = (header, CSV) with the sha256 of their current bytes."""
    problems = []
    files = list_issues(idir)
    csvs = sorted(m.group(1) for n in (os.listdir(idir) if os.path.isdir(idir) else []) if (m := ISSUE_CSV_RE.match(n)))
    if csvs != [d for d, _ in files]:
        problems.append(f"issue CSV dates {csvs} != header dates {[d for d, _ in files]}")
    entries = read_jsonl(os.path.join(idir, "chain.jsonl"))
    if len(entries) != len(files):
        problems.append(f"chain.jsonl has {len(entries)} lines but there are {len(files)} issues")
    prev_sha, prev_name = ZERO_SHA, None
    for i, (date, name) in enumerate(files):
        with open(os.path.join(idir, name), "rb") as f:
            raw = f.read()
        sha = sha256_bytes(raw)
        cpath = os.path.join(idir, date + ".csv.gz")
        csha = sha256_file(cpath) if os.path.exists(cpath) else None
        try:
            doc = json.loads(raw)
        except ValueError:
            problems.append(f"{name}: not valid JSON")
            prev_sha, prev_name = sha, name
            continue
        if doc.get("date") != date:
            problems.append(f"{name}: date {doc.get('date')!r} != file name")
        if doc.get("prevSha256") != prev_sha:
            problems.append(f"{name}: prevSha256 does not equal the sha256 of {prev_name or 'genesis'}")
        if doc.get("prevFile") != prev_name:
            problems.append(f"{name}: prevFile {doc.get('prevFile')!r} != {prev_name!r}")
        if doc.get("csvSha256") != csha:
            problems.append(f"{name}: csvSha256 does not match {date}.csv.gz")
        if i < len(entries):
            e = entries[i]
            if (e.get("file") != name or e.get("sha256") != sha or e.get("prevSha256") != prev_sha
                    or e.get("csvSha256") != csha):
                problems.append(f"chain.jsonl line {i + 1} does not match {name} (file changed after issue?)")
        prev_sha, prev_name = sha, name
    return problems


def preflight(idir, date, issued_at):
    """DL.7 refusals. Returns (prevFile, prevSha256)."""
    files = list_issues(idir)
    later = [n for d, n in files if d >= date]
    if os.path.isdir(idir):
        later += [n for n in os.listdir(idir) if (m := ISSUE_CSV_RE.match(n)) and m.group(1) >= date]
    if later:
        raise SystemExit(f"STOP: issue file(s) dated {date} or later exist: {sorted(set(later))}. A file is never "
                         "rewritten and nothing is backfilled.")
    problems = verify_chain(idir)
    if problems:
        raise SystemExit("STOP: hash chain broken:\n  " + "\n  ".join(problems))
    if not files:
        return None, ZERO_SHA
    name = files[-1][1]
    with open(os.path.join(idir, name), "rb") as f:
        raw = f.read()
    prev_issued = json.loads(raw).get("issuedAt")
    if prev_issued is None or int(prev_issued) >= issued_at:
        raise SystemExit(f"STOP: clock went backwards: {name} issuedAt {prev_issued} >= now {issued_at}")
    return name, sha256_bytes(raw)


def check_store_clocks(ldir, now):
    """DL.7 clock guard on the stores: no store fetch may post-date the clock."""
    for sub in (EVENTS_SUB, XV_SUB):
        for e in read_jsonl(os.path.join(ldir, sub, "fetch-log.jsonl")):
            for k in ("fetchedAt", "toBlockTs"):
                if int(e[k]) > now:
                    raise SystemExit(f"STOP: clock went backwards: {sub} fetch-log {k} {iso(e[k])} after now {iso(now)}")
    for row in read_gz_rows(os.path.join(ldir, CODES_SUB, "holder-codes.csv.gz"), CODE_COLS):
        if int(row[6]) > now:
            raise SystemExit("STOP: clock went backwards: holder code read after now")
    for row in read_gz_rows(os.path.join(ldir, DAILY_SUB, "snapshots.csv.gz"), DAILY_COLS):
        if int(row[5]) > now or int(row[2]) > now:
            raise SystemExit(f"STOP: clock went backwards: daily snapshot {row[0]} read after now")


def csv_bytes(rows, header=None):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header or CSV_HEADER)
    for r in rows:
        w.writerow(r)
    return gzip.compress(buf.getvalue().encode(), compresslevel=9, mtime=0)


def read_issue_csv(path):
    import pandas as pd
    return pd.read_csv(path, dtype=str, keep_default_na=False)


# ---------------------------------------------------------------------------------------------
# Scoring math (DL.5, DL.6)
# ---------------------------------------------------------------------------------------------
def truth_unit(blocks, bal, asof_block, H, h_sec):
    """DL-14: path = bal + changes of blocks after asof_block; event times in (H, H + h]. Returns (mn, has, n)
    with mn = min path over those event times (bal when none)."""
    b, ts, d = blocks["block"], blocks["ts"], blocks["delta"]
    m = b > asof_block
    b, ts, d = b[m], ts[m], d[m]
    path = int(bal) + np.cumsum(d) if len(d) else np.zeros(0, np.int64)
    w = (ts > H) & (ts <= H + h_sec)
    if not w.any():
        return int(bal), False, 0
    return int(path[w].min()), True, int(w.sum())


def count_episodes_units(units, dates, y):
    """G.7 n_ep: maximal runs of consecutive issue days with y = 1 for one unit (a day without a scored row breaks
    the run)."""
    if not len(y):
        return 0
    od = np.array([C.date_ordinal(d) for d in dates], dtype=np.int64)
    u = np.asarray(units)
    yy = np.asarray(y, dtype=np.int64) == 1
    if not yy.any():
        return 0
    uu, dd = u[yy], od[yy]
    o = np.lexsort((dd, uu))
    uu, dd = uu[o], dd[o]
    new = np.r_[True, (uu[1:] != uu[:-1]) | (dd[1:] - dd[:-1] != 1)]
    return int(new.sum())


def ratio(sp, sy):
    if sy > 0:
        return sp / sy
    return "inf" if sp > 0 else None


def r_inside(R, lo, hi):
    return R is not None and R != "inf" and lo <= R <= hi


def stats_block(p, y, pop, own, units, dates):
    p, y, pop, own = (np.asarray(v, float) for v in (p, y, pop, own))
    n = len(y)
    if n == 0:
        return None
    b = float(np.mean((p - y) ** 2))
    bp = float(np.mean((pop - y) ** 2))
    bo = float(np.mean((own - y) ** 2))
    return {"n": n, "n_ep": count_episodes_units(units, dates, y), "brier": b, "brier_pop": bp, "brier_own": bo,
            "bss_vs_pop": (1 - b / bp) if bp > 0 else None, "bss_vs_own": (1 - b / bo) if bo > 0 else None,
            "R": ratio(float(p.sum()), float(y.sum())), "sum_p": float(p.sum()), "sum_y": float(y.sum())}
