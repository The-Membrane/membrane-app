"""Q26 R21: young-market analogs for deep touch odds (development only, seen crypto data).

membrane-board design/q26-r21-young-market-analogs-2026-10-24.md (registered before any score). Parents:
design/Q26_ROUND13_PREREG.md D-R13.4a-c, design/q26-standardization-diagnosis-2026-10-19.md.

Owner question (2026-10-24): "Are there asset classes that moved like crypto early in their lifespan, before they
matured, and can we use those datasets to forecast crypto?"

Subcommands
  acquire      B3 COTAHIST 1986-1999 (dev company roots only; split per ticker x currency regime MODREF), FRED public
               domain closes (EIA oil/gas, Fed H.10 FX), French ME-decile daily returns, Brazil CPI (OECD, monthly).
               Streams every file, keeps compact daily arrays, deletes raw files. Prints counts and parser sanity only.
  encode-hl    frozen R13.4 encoder (beta from meta-r134-dev.json) + r16_diag extras on the B3 1986-1999 segments;
               rows in the r16_diag.Rows field layout (class index 6 = 'eq_br_early').
  encode-cp    close-path encoder (v = squared close-to-close log return, same log-HAR form): beta fitted once on the
               R13.4 dev slices' close paths (class-equal), frozen, applied to every close-path set.
  similarity   vol-matched standardized tail F(z) of each analog group vs crypto dev (HL and close-path lanes).
  neff         distinct crash weeks the analogs add (outside crypto's span) and two-way N_eff gain (HL lane).
  transfer     arms A0 / A1 / A2 (reg2 decoder) on seen B12/B9 deep cells vs (fH) and L_all; power reading.

Reserved-set guard: B3 tickers are kept only if split3(root) == 'dev' (EQ-A/EQ-B roots are skipped at parse time in
every year). No path containing '/locked' is opened. No address, key or secret is read or written.
"""
from __future__ import annotations

import os

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import csv  # noqa: E402
import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import shutil  # noqa: E402
import sys  # noqa: E402
import zipfile  # noqa: E402

import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import r134_library as L4  # noqa: E402

DAY = 86400
WORK = "/home/user/r13work/r21"
SEED = 2026210
NB = 400
JUMP_CA = math.log(3.0)          # |ln C_t/C_{t-1}| > ln 3 marks a corporate action (unadjusted grupamentos)
GAP_SPLIT = 10                   # a calendar break of > 10 trading days with no trade starts a new segment
ERA = {"BR-I": ("1986-01-01", "1994-06-30"), "BR-II": ("1994-07-01", "1999-12-31")}
FRED_COM = {"DCOILWTICO": "OIL", "DCOILBRENTEU": "OIL", "DHHNGSP": "GAS"}
# H.10: (series, quoted as FC per USD?) ; value of the foreign currency in USD = 1/x when FC per USD
FRED_FXM = {"DEXJPUS": True, "DEXUSUK": False, "DEXSZUS": True, "DEXCAUS": True, "DEXUSAL": False,
            "DEXUSNZ": False, "DEXSDUS": True, "DEXNOUS": True, "DEXDNUS": True}
FRED_FXE = {"DEXMXUS": True, "DEXKOUS": True, "DEXTHUS": True, "DEXMAUS": True, "DEXSIUS": True, "DEXINUS": True,
            "DEXBZUS": True, "DEXSFUS": True, "DEXCHUS": True, "DEXTAUS": True, "DEXSLUS": True, "DEXVZUS": True,
            "DEXHKUS": True}
FRED_CPI = "BRACPIALLMINMEI"
FRENCH_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/Portfolios_Formed_on_ME_daily_CSV.zip"
R16_ROWS = "/tmp/claude-0/-home-user/5db7bc9d-0d68-5d3f-a50f-faa01897ef28/scratchpad/lev/r16enc/rows-r16.npz"
R16_META = "/tmp/claude-0/-home-user/5db7bc9d-0d68-5d3f-a50f-faa01897ef28/scratchpad/lev/r16enc/encode-r16.json"
FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={s}"


def now_iso():
    return L4.now_iso()


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=True, default=float)


def guard(p):
    if "/locked" in os.path.abspath(p).replace("\\", "/"):
        raise SystemExit(f"STOP: refusing a locked path {p}")
    return p


def curl_get(url, timeout=300):
    """FRED's edge stalls urllib requests; curl (proxy-configured) works. Returns bytes."""
    import subprocess
    for i in range(4):
        r = subprocess.run(["curl", "-sS", "--fail", "--max-time", str(timeout), url], capture_output=True)
        if r.returncode == 0 and r.stdout:
            return r.stdout
    raise RuntimeError(f"curl failed {url}: {r.stderr[:200]!r}")


def disk_ok(minfree_gb=1.5):
    st = shutil.disk_usage("/")
    free = st.free / 2 ** 30
    if free < minfree_gb:
        raise SystemExit(f"STOP: free disk {free:.2f} GB < {minfree_gb} GB")
    return free


# =============================================================================================
# acquire
# =============================================================================================
def parse_cotahist_year(y, tmp, store, sanity):
    url = L4.B3_URL.format(y=y)
    raw = L4.http_get(url, timeout=600)
    sha = hashlib.sha256(raw).hexdigest()
    zp = os.path.join(tmp, f"c{y}.zip")
    with open(zp, "wb") as f:
        f.write(raw)
    nbytes = len(raw)
    del raw
    st = {"year": y, "url": url, "sha256": sha, "bytes": nbytes, "eq_rows": 0, "kept_dev": 0, "skipped_AB": 0,
          "hl_bad": 0, "zero_trades": 0, "modref": {}}
    with zipfile.ZipFile(zp) as z:
        name = z.namelist()[0]
        with z.open(name) as fh:
            for line in io.TextIOWrapper(fh, encoding="latin-1"):
                if not line.startswith("01") or line[10:12] != "02" or line[24:27] != "010":
                    continue
                especi = line[39:49].strip()
                if not especi.startswith(L4.EQ_ESPECI):
                    continue
                st["eq_rows"] += 1
                tick = line[12:24].strip()
                if L4.split3(tick[:4]) != "dev":           # reserved-set guard: EQ-A / EQ-B roots never kept
                    st["skipped_AB"] += 1
                    continue
                fat = int(line[210:217]) or 1
                o = int(line[56:69]) / 100.0 / fat
                h = int(line[69:82]) / 100.0 / fat
                lo = int(line[82:95]) / 100.0 / fat
                c = int(line[108:121]) / 100.0 / fat
                n = int(line[147:152])
                mod = line[52:56].strip()
                st["modref"][mod] = st["modref"].get(mod, 0) + 1
                if h < lo:
                    st["hl_bad"] += 1
                if n == 0:
                    st["zero_trades"] += 1
                rec = store.setdefault(tick, {k: [] for k in ("d", "o", "h", "l", "c", "n", "dis", "isin", "mod")})
                rec["d"].append(L4.date_days(line[2:10]))
                rec["o"].append(o)
                rec["h"].append(h)
                rec["l"].append(lo)
                rec["c"].append(c)
                rec["n"].append(n)
                rec["dis"].append(int(line[242:245]) if line[242:245].strip().isdigit() else -1)
                rec["isin"].append(line[230:242])
                rec["mod"].append(mod)
                st["kept_dev"] += 1
    os.remove(zp)
    sanity.append(st)
    print(f"{now_iso()} B3 {y}: equity rows {st['eq_rows']}, dev kept {st['kept_dev']}, A/B skipped "
          f"{st['skipped_AB']}, high<low {st['hl_bad']}, MODREF {st['modref']}", flush=True)


def cmd_acquire(a):
    out = guard(a.work)
    os.makedirs(out, exist_ok=True)
    tmp = os.path.join(out, "_tmp")
    os.makedirs(tmp, exist_ok=True)
    man = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "b3": [], "fred": {}, "french": {}}
    if not a.skip_b3:
        store, sanity = {}, []
        for y in range(1986, 2000):
            disk_ok()
            parse_cotahist_year(y, tmp, store, sanity)
        man["b3"] = sanity
        # segments: ticker x MODREF run, split at > GAP_SPLIT trading-day breaks
        cal = np.unique(np.concatenate([np.array(r["d"], np.int32) for r in store.values()]))
        segdir = os.path.join(out, "b3early")
        os.makedirs(segdir, exist_ok=True)
        nseg, nrows, njump = 0, 0, 0
        seg_by_mod = {}
        for tick, rec in sorted(store.items()):
            d = np.array(rec["d"], np.int32)
            o_ = np.argsort(d, kind="mergesort")
            d = d[o_]
            keep = np.r_[True, np.diff(d) > 0]
            idx = o_[keep]
            d = d[keep]
            arr = {k: np.array(rec[k], np.float64)[idx] for k in ("o", "h", "l", "c")}
            ntr = np.array(rec["n"], np.int32)[idx]
            dis = np.array(rec["dis"], np.int32)[idx]
            isin = np.array(rec["isin"])[idx]
            mod = np.array(rec["mod"])[idx]
            ci = np.searchsorted(cal, d)
            brk = np.r_[True, (mod[1:] != mod[:-1]) | (np.diff(ci) > GAP_SPLIT)]
            sid = np.cumsum(brk) - 1
            for s in range(sid[-1] + 1):
                mk = sid == s
                if mk.sum() < 30:
                    continue
                c = arr["c"][mk]
                with np.errstate(all="ignore"):
                    jr = np.abs(np.log(c[1:] / c[:-1]))
                jump = np.r_[False, jr > JUMP_CA]
                isin_chg = np.r_[False, isin[mk][1:] != isin[mk][:-1]] | jump
                njump += int(jump.sum())
                key = f"{tick}~{mod[mk][0] or 'NA'}~{int(d[mk][0])}"
                np.savez_compressed(os.path.join(segdir, f"equity-{key.replace('$', 'S')}.npz"),
                                    d=d[mk], o=arr["o"][mk], h=arr["h"][mk], l=arr["l"][mk], c=c, n=ntr[mk],
                                    dis=dis[mk], isin_chg=isin_chg, mod=np.array([mod[mk][0]]))
                nseg += 1
                nrows += int(mk.sum())
                seg_by_mod[mod[mk][0]] = seg_by_mod.get(mod[mk][0], 0) + 1
        np.save(os.path.join(out, "b3early-cal.npy"), cal)
        man["b3_segments"] = {"tickers": len(store), "segments": nseg, "rows": nrows, "jump_ca_days": njump,
                              "segments_by_modref": seg_by_mod, "calendar_days": int(len(cal))}
        print(f"{now_iso()} B3 1986-1999 dev: tickers {len(store)}, segments {nseg}, rows {nrows}, "
              f"x3-jump CA days {njump}, by MODREF {seg_by_mod}", flush=True)
        del store
    # FRED (public domain series only)
    fdir = os.path.join(out, "fred")
    os.makedirs(fdir, exist_ok=True)
    for sname in list(FRED_COM) + list(FRED_FXM) + list(FRED_FXE) + [FRED_CPI]:
        raw = curl_get(FRED_URL.format(s=sname), timeout=180)
        sha = hashlib.sha256(raw).hexdigest()
        rows = list(csv.reader(io.StringIO(raw.decode("utf-8", "replace"))))
        d, v = [], []
        for r in rows[1:]:
            if len(r) < 2 or r[1] in ("", "."):
                continue
            try:
                x = float(r[1])
            except ValueError:
                continue
            d.append(L4.date_days(r[0]))
            v.append(x)
        np.savez_compressed(os.path.join(fdir, f"{sname}.npz"), d=np.array(d, np.int32), v=np.array(v))
        man["fred"][sname] = {"sha256": sha, "obs": len(d), "first": rows[1][0] if len(rows) > 1 else None}
        print(f"{now_iso()} FRED {sname}: obs {len(d)} first {man['fred'][sname]['first']}", flush=True)
    # French ME portfolios, daily (value-weighted deciles)
    raw = curl_get(FRENCH_URL, timeout=300)
    man["french"]["sha256"] = hashlib.sha256(raw).hexdigest()
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        txt = z.read(z.namelist()[0]).decode("latin-1")
    del raw
    lines = txt.splitlines()
    hdr_i = next(i for i, ln in enumerate(lines) if ln.strip().startswith(",") and "Lo 10" in ln)
    hdr = [x.strip() for x in lines[hdr_i].split(",")]
    cols = [j for j, h in enumerate(hdr) if h in ("Lo 10", "Dec 2", "Dec 3", "Dec 4", "Dec 5", "Dec 6", "Dec 7",
                                                  "Dec 8", "Dec 9", "Hi 10")]
    d, R = [], []
    for ln in lines[hdr_i + 1:]:
        p = [x.strip() for x in ln.split(",")]
        if len(p) < len(hdr) or not p[0].isdigit() or len(p[0]) != 8:
            break                                      # first block = value-weighted returns
        d.append(L4.date_days(p[0]))
        R.append([float(p[j]) for j in cols])
    R = np.array(R) / 100.0
    np.savez_compressed(os.path.join(out, "french-me-vw.npz"), d=np.array(d, np.int32), r=R,
                        names=np.array([hdr[j] for j in cols]))
    man["french"].update({"rows": len(d), "first": int(d[0]), "names": [hdr[j] for j in cols],
                          "block": "first block in file (value-weighted)"})
    print(f"{now_iso()} French ME daily VW: rows {len(d)}, columns {len(cols)}", flush=True)
    write_json(os.path.join(out, "acquire-r21.json"), man)
    shutil.rmtree(tmp, ignore_errors=True)


# =============================================================================================
# resegment (instrument fix found before any score: MODREF reads 'CR$' for both the cruzeiro and the cruzeiro real,
# so the 1993-08-01 redenomination is not a MODREF change; a market-wide x100-x1000 unit change also hits 1987-06-01.
# A x3 jump left inside a segment would also poison the 252-bar long-run level LR. Rule: split segments at every
# x3 close jump and at the first trading day on/after 1987-06-01 and 1993-08-01.)
# =============================================================================================
UNIT_CHANGE_DAYS = ("1987-06-01", "1993-08-01")


def cmd_resegment(a):
    src = guard(os.path.join(a.work, "b3early"))
    dst = guard(os.path.join(a.work, "b3early-seg"))
    os.makedirs(dst, exist_ok=True)
    uc = [L4.date_days(x) for x in UNIT_CHANGE_DAYS]
    n_in, n_out, rows, njump = 0, 0, 0, 0
    for f in sorted(os.listdir(src)):
        z = dict(np.load(os.path.join(src, f)))
        n_in += 1
        d, c = z["d"], z["c"]
        with np.errstate(all="ignore"):
            jr = np.abs(np.log(c[1:] / c[:-1]))
        brk = np.r_[True, jr > JUMP_CA]
        njump += int((jr > JUMP_CA).sum())
        for u in uc:
            k = np.searchsorted(d, u)
            if 0 < k < len(d):
                brk[k] = True
        sid = np.cumsum(brk) - 1
        base = f[:-4]
        for s_ in range(sid[-1] + 1):
            mk = sid == s_
            if mk.sum() < 30:
                continue
            part = {k: v[mk] for k, v in z.items() if k != "mod"}
            part["isin_chg"] = np.r_[False, part["isin_chg"][1:]]       # a split segment starts clean
            part["mod"] = z["mod"]
            np.savez_compressed(os.path.join(dst, f"{base}~{s_}.npz"), **part)
            n_out += 1
            rows += int(mk.sum())
    shutil.rmtree(src)
    os.rename(dst, src)
    info = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "segments_in": n_in, "segments_out": n_out,
            "rows_out": rows, "x3_jumps_split": njump, "unit_change_days": UNIT_CHANGE_DAYS}
    write_json(os.path.join(a.work, "resegment-r21.json"), info)
    print(f"{now_iso()} resegment: {info}", flush=True)


# =============================================================================================
# encode-hl (frozen R13.4 encoder, r16_diag field layout)
# =============================================================================================
def encode_rows(series, beta, cls_idx, sid0, hs=(1, 3, 5)):
    import r16_diag as D
    rows = {hh: {k: [] for k in D.FIELDS} for hh in hs}
    rt = 0.0
    for j, s in enumerate(series):
        E = L4.encode_inputs(s)
        X = D.extra_inputs(s)
        with np.errstate(all="ignore"):
            lns1 = 0.5 * (E["X"] @ beta[1])
        for hh in hs:
            F = E["fwd"][hh]
            ok = F["ok"]
            if not ok.any():
                continue
            R = rows[hh]
            n = int(ok.sum())
            with np.errstate(all="ignore"):
                lns0 = 0.5 * (E["X"][ok] @ beta[hh]) + 0.5 * math.log(hh)
                depth = np.log(F["wmin"][ok]) - E["lc"][ok]
                lnrv = np.log(F["rv"][ok])
                dec = np.exp(E["lc"][ok] + (depth / np.exp(lns0)) * np.exp(lns0))
            rt = max(rt, float(np.nanmax(np.abs(dec / F["wmin"][ok] - 1.0))))
            R["cls"].append(np.full(n, cls_idx, np.int8))
            R["sid"].append(np.full(n, sid0 + j, np.int32))
            R["day"].append(s["d"][ok].astype(np.int32))
            R["end"].append(F["end_day"][ok].astype(np.int32))
            R["age"].append(np.asarray(E["age"])[ok].astype(np.int32))
            R["q2"].append(np.zeros(n, bool))
            R["depth"].append(depth)
            R["lns0"].append(lns0)
            R["lnrv"].append(lnrv)
            R["lnD"].append(E["X"][ok, 1])
            R["lnW"].append(E["X"][ok, 2])
            R["lnM"].append(E["X"][ok, 3])
            for k in ("lnLR", "lnEW", "lnRVcc", "spike"):
                R[k].append(X[k][ok])
            R["vov"].append(E["vov"][ok])
            R["vr"].append(E["vr"][ok])
            R["lns1"].append(lns1[ok])
    out = {}
    for hh in hs:
        for k, v in rows[hh].items():
            v = np.concatenate(v) if v else np.zeros(0)
            if v.dtype == np.float64 and k not in ("depth", "lns0"):
                v = v.astype(np.float32)
            out[f"h{hh}_{k}"] = v
    return out, rt


def load_b3early(work):
    segdir = guard(os.path.join(work, "b3early"))
    cal = np.load(os.path.join(work, "b3early-cal.npy"))
    series = []
    for f in sorted(os.listdir(segdir)):
        B = L4.bars_b3(os.path.join(segdir, f), cal)
        key = f[len("equity-"):-4]
        B.update(key=f"b3e:{key}", cls="eq_br_early", sub="b3early", asset=key.split("~")[0])
        series.append(B)
    return series


def cmd_encode_hl(a):
    import r16_diag as D
    disk_ok()
    meta = json.load(open(a.meta))
    beta = {int(k): np.array(v) for k, v in meta["beta"].items()}
    series = load_b3early(a.work)
    nser_r16 = len(json.load(open(a.r16meta))["series"])
    out, rt = encode_rows(series, beta, 6, nser_r16)
    np.savez(os.path.join(a.work, "rows-r21-br.npz"), **out)
    info = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "round_trip_max_rel": rt, "sid0": nser_r16,
            "series": [{"key": s["key"], "cls": s["cls"], "sub": s["sub"]} for s in series],
            "rows": {str(h): int(len(out[f"h{h}_depth"])) for h in (1, 3, 5)},
            "valid_bars": int(sum(int(s["valid"].sum()) for s in series)),
            "ca_bars": int(sum(int(s["ca"].sum()) for s in series))}
    write_json(os.path.join(a.work, "encode-hl-r21.json"), info)
    print(f"{now_iso()} encode-hl: series {len(series)}, rows {info['rows']}, round trip {rt:.2e}, "
          f"CA bars {info['ca_bars']}", flush=True)
    del D


# =============================================================================================
# encode-cp (close-path encoder)
# =============================================================================================
CP_FIELDS = ("sid", "day", "end", "depth", "lnrv", "lnD", "lnW", "lnM", "lnLR")


def cp_inputs(B, hs=(1, 3, 5)):
    """close-path encoder inputs: v_t = (ln C_t - ln C_{t-1})^2 with both bars valid; window = min close t+1..t+h."""
    c, valid = B["c"], B["valid"] & (B["c"] > 0)
    with np.errstate(all="ignore"):
        lc = np.where(valid, np.log(np.where(c > 0, c, np.nan)), np.nan)
    r = np.r_[np.nan, np.diff(lc)]
    v = r * r                                            # nan unless both bars valid
    M = L4.roll_mean(v, 22, 20)
    W = L4.roll_mean(v, 5, 4)
    LR = L4.roll_mean(v, 252, 20)
    f = np.isfinite(v)
    cs, cn = np.cumsum(np.where(f, v, 0.0)), np.cumsum(f)
    with np.errstate(all="ignore"):
        expd = np.where(cn >= 20, cs / np.maximum(cn, 1), np.nan)
        LR = np.where(np.isfinite(LR), LR, expd)
        LR[:21] = np.nan
        Dv = np.maximum(np.where(f, v, np.nan), L4.VFLOOR * M)
        Wf = np.maximum(W, L4.VFLOOR * M)
        X = np.stack([np.log(Dv), np.log(Wf), np.log(M)], 1)
    okX = np.all(np.isfinite(X), 1) & np.isfinite(lc)
    n = len(c)
    i = np.arange(n)
    ca = B["ca"].astype(float)
    cca = np.concatenate([[0.0], np.cumsum(ca)])
    ca_back = (cca[i + 1] - cca[np.maximum(i - 21, 0)]) > 0
    out = {}
    for hh in hs:
        rv = L4.fwd_window(v, hh, "mean")
        wm = L4.fwd_window(lc, hh, "min")
        ca_f = (cca[np.minimum(i + hh + 1, n)] - cca[i + 1]) > 0
        end_day = np.r_[B["d"][hh:], np.full(hh, 10 ** 9)][:n] if n > hh else np.full(n, 10 ** 9)
        ok = np.isfinite(wm) & okX & ~ca_back & ~ca_f & (end_day + 1 <= B["cap_day"]) & np.isfinite(rv) & (rv > 0)
        with np.errstate(all="ignore"):
            out[hh] = {"ok": ok, "day": B["d"][ok], "end": end_day[ok], "depth": (wm - lc)[ok], "lnrv": np.log(rv[ok]),
                       "lnD": X[ok, 0], "lnW": X[ok, 1], "lnM": X[ok, 2], "lnLR": np.log(LR[ok])}
    return out


def fred_series(work, name, invert):
    z = np.load(guard(os.path.join(work, "fred", f"{name}.npz")))
    d, v = z["d"], z["v"].astype(float)
    if invert:
        with np.errstate(all="ignore"):
            v = np.where(v > 0, 1.0 / v, np.nan)
    B = {"d": d, "c": v, "valid": np.isfinite(v) & (v > 0), "ca": np.zeros(len(d), bool),
         "cap_day": int(d[-1]) + 1}
    return B


def cp_series_all(a, log):
    """every close-path series: (key, group-base, B). Dev slices (for the beta fit) + analogs."""
    import r16_diag as D
    a.datasets, a.acq, a.data = a.datasets, a.acq, a.data
    dev, _, _ = D.load_dev_series(a, log)
    out = []
    for s in dev:
        g = {"crypto": "crypto", "equity": "BR-M", "etf": "dev-etf", "fx": "dev-fx", "index": "dev-index",
             "commodity": "dev-commodity"}[s["cls"]]
        out.append((s["key"], g, s["cls"], s))
    for s in load_b3early(a.work):
        out.append((s["key"], "BR-early", "eq_br_early", s))
    for nm, grp in FRED_COM.items():
        out.append((f"fred:{nm}", grp, "analog", fred_series(a.work, nm, False)))
    for nm, inv in FRED_FXM.items():
        out.append((f"fred:{nm}", "FXM", "analog", fred_series(a.work, nm, inv)))
    for nm, inv in FRED_FXE.items():
        out.append((f"fred:{nm}", "FXE", "analog", fred_series(a.work, nm, inv)))
    z = np.load(guard(os.path.join(a.work, "french-me-vw.npz")))
    for j, nm in enumerate(z["names"]):
        r = z["r"][:, j]
        ok = r > -0.99
        lvl = np.exp(np.cumsum(np.log1p(np.where(ok, r, 0.0))))
        B = {"d": z["d"], "c": np.where(ok, lvl, np.nan), "valid": ok & np.isfinite(lvl), "ca": np.zeros(len(r), bool),
             "cap_day": int(z["d"][-1]) + 1}
        out.append((f"ff:{nm}", "FF", "analog", B))
    return out


def cmd_encode_cp(a):
    disk_ok()
    log = lambda s: print(f"{now_iso()} {s}", flush=True)  # noqa: E731
    allser = cp_series_all(a, log)
    log(f"close-path series {len(allser)}")
    hs = (1, 3, 5)
    rows = {hh: {k: [] for k in CP_FIELDS} for hh in hs}
    keys, groups, classes = [], [], []
    for sid, (key, grp, cls, B) in enumerate(allser):
        keys.append(key)
        groups.append(grp)
        classes.append(cls)
        I = cp_inputs(B, hs)
        for hh in hs:
            for k in CP_FIELDS:
                if k == "sid":
                    rows[hh][k].append(np.full(int(I[hh]["ok"].sum()), sid, np.int32))
                else:
                    rows[hh][k].append(I[hh][k])
    dev_cls = ("crypto", "equity", "etf", "fx", "index", "commodity")
    clsarr = np.array(classes)
    beta = {}
    out = {}
    for hh in hs:
        R = {k: np.concatenate(v) for k, v in rows[hh].items()}
        q2 = L4.q2_overlap(R["day"], R["end"])
        rcls = clsarr[R["sid"]]
        X = np.c_[np.ones(len(R["day"])), R["lnD"], R["lnW"], R["lnM"]]
        Xs, ys, ws = [], [], []
        for c in dev_cls:
            mk = (rcls == c) & ~q2
            if mk.sum() == 0:
                continue
            Xs.append(X[mk])
            ys.append(R["lnrv"][mk])
            ws.append(np.full(int(mk.sum()), 1.0 / mk.sum()))
        Xf, yf, wf = np.vstack(Xs), np.concatenate(ys), np.concatenate(ws)
        sw = np.sqrt(wf)
        b, *_ = np.linalg.lstsq(Xf * sw[:, None], yf * sw, rcond=None)
        smear = float(np.sum(wf * np.exp(yf - Xf @ b)) / np.sum(wf))
        b[0] += math.log(smear)
        beta[hh] = b
        log(f"CP beta h={hh}: {np.round(b, 4).tolist()} (fit rows {len(yf)})")
        R["lns"] = 0.5 * (X @ b) + 0.5 * math.log(hh)
        R["m"] = R["depth"] / np.exp(R["lns"])
        R["q2"] = q2
        for k, v in R.items():
            out[f"h{hh}_{k}"] = v.astype(np.float32) if (v.dtype == np.float64 and k not in ("m", "depth")) else v
    # vol state (CP): 1-bar sigma-hat vs long-run level, on each h's rows
    for hh in hs:
        X1 = np.c_[np.ones(len(out[f"h{hh}_day"])), out[f"h{hh}_lnD"], out[f"h{hh}_lnW"], out[f"h{hh}_lnM"]]
        out[f"h{hh}_vstate"] = (0.5 * (X1.astype(float) @ beta[1]) - 0.5 * out[f"h{hh}_lnLR"].astype(float))
    np.savez(os.path.join(a.work, "rows-r21-cp.npz"), **out)
    write_json(os.path.join(a.work, "encode-cp-r21.json"), {"created_utc": now_iso(), "code_sha": L4.git_sha(),
               "beta_cp": {str(k): v.tolist() for k, v in beta.items()}, "keys": keys, "groups": groups,
               "classes": classes, "rows": {str(h): int(len(out[f"h{h}_day"])) for h in hs}})
    log("encode-cp done")


# =============================================================================================
# shared analysis helpers
# =============================================================================================
ZS = (-2.0, -3.0, -4.0)
HS = (1, 3, 5)
BLOCK_WEEKS = 4
MIN_DEC_ROWS = 200


def block_of(day):
    return (L4.week_of(day) // BLOCK_WEEKS).astype(np.int64)


def r16_rows(a, hh):
    import r16_diag as D
    return D.Rows(a.r16rows, a.r16meta, hh)


def br_rows(a, hh):
    """B3 1986-1999 rows with the r16_diag.Rows filter (finite lnrv and lnLR)."""
    import r16_diag as D
    z = np.load(os.path.join(a.work, "rows-r21-br.npz"))
    R = {k: z[f"h{hh}_{k}"] for k in D.FIELDS}
    keep = ~R["q2"] & np.isfinite(R["lnrv"]) & np.isfinite(R["lnLR"])
    return {k: v[keep] for k, v in R.items()}


def era_mask(day, era):
    lo, hi = ERA[era]
    return (day >= L4.date_days(lo)) & (day <= L4.date_days(hi))


def joint_boot(groups, nb, seed, zs=ZS, ndec=10, chunk=40):
    """groups: name -> dict(sid, block, dec, m). Returns point and draws of decile-matched F_g(z) (mean over deciles
    with >= MIN_DEC_ROWS rows). Pigeonhole two-way bootstrap: series weights x block weights, both global (shared)."""
    allsid = np.unique(np.concatenate([g["sid"] for g in groups.values()]))
    allblk = np.unique(np.concatenate([g["block"] for g in groups.values()]))
    S, G = len(allsid), len(allblk)
    rng = np.random.default_rng(seed)
    Ws = np.stack([np.bincount(rng.integers(0, S, S), minlength=S) for _ in range(nb)], 1).astype(np.float32)
    Wb = np.stack([np.bincount(rng.integers(0, G, G), minlength=G) for _ in range(nb)], 1).astype(np.float32)
    out = {}
    for nm, g in groups.items():
        si = np.searchsorted(allsid, g["sid"])
        bi = np.searchsorted(allblk, g["block"])
        key = (si.astype(np.int64) * G + bi) * ndec + g["dec"]
        uk, inv = np.unique(key, return_inverse=True)
        n = np.bincount(inv, minlength=len(uk)).astype(np.float64)
        Y = np.stack([np.bincount(inv, weights=(g["m"] <= z).astype(float), minlength=len(uk)) for z in zs], 1)
        cs, cb, cd = (uk // ndec) // G, (uk // ndec) % G, uk % ndec
        nd = np.bincount(cd, weights=n, minlength=ndec)
        okd = nd >= MIN_DEC_ROWS
        Fd = np.stack([np.bincount(cd, weights=Y[:, j], minlength=ndec) / np.maximum(nd, 1) for j in range(len(zs))], 1)
        point = Fd[okd].mean(axis=0) if okd.any() else np.full(len(zs), np.nan)
        draws = np.empty((nb, len(zs)))
        oh = np.zeros((len(uk), ndec), np.float32)
        oh[np.arange(len(uk)), cd] = 1.0
        for a0 in range(0, nb, chunk):
            a1 = min(nb, a0 + chunk)
            Wc = Ws[cs, a0:a1] * Wb[cb, a0:a1]                       # cells x k
            Nd = oh.T @ (Wc * n[:, None].astype(np.float32))         # ndec x k
            for j in range(len(zs)):
                Yd = oh.T @ (Wc * Y[:, j:j + 1].astype(np.float32))
                Fdj = Yd / np.maximum(Nd, 1e-9)
                draws[a0:a1, j] = Fdj[okd].mean(axis=0)
        out[nm] = {"point": point, "draws": draws, "rows": int(len(g["m"])), "series": int(len(np.unique(g["sid"]))),
                   "blocks": int(len(np.unique(g["block"]))), "dec_rows": nd.astype(int).tolist(),
                   "dec_used": int(okd.sum()), "events": [int(np.sum(g["m"] <= z)) for z in zs]}
    return out


LAMZ = np.array([-4.0, -3.5, -3.0, -2.5, -2.0, -1.5])


def matched_F(m, dec, z, ndec=10):
    vals = []
    for d_ in range(ndec):
        mm = m[dec == d_]
        if len(mm) >= MIN_DEC_ROWS:
            vals.append(np.mean(mm[:, None] <= np.atleast_1d(z)[None, :], axis=0))
    return np.mean(vals, axis=0) if vals else np.full(len(np.atleast_1d(z)), np.nan)


def lam_fit(mc, dc, mg, dg):
    Fc = matched_F(mc, dc, LAMZ)
    best = (np.inf, 1.0)
    for lam in np.arange(0.5, 2.501, 0.01):
        Fg = matched_F(mg, dg, LAMZ / lam)
        ok = (Fc > 0) & (Fg > 0)
        if ok.sum() < 2:
            continue
        sse = float(np.sum((np.log(Fc[ok]) - np.log(Fg[ok])) ** 2))
        if sse < best[0]:
            best = (sse, float(lam))
    lam = best[1]
    zr = np.array(ZS)
    Fc3, Fg3 = matched_F(mc, dc, zr), matched_F(mg, dg, zr / lam)
    with np.errstate(all="ignore"):
        resid = np.log(Fc3) - np.log(Fg3)
    return lam, resid


def similarity_table(groups, young, bench, nb, seed, log, label):
    """groups name -> dict(sid, block, dec, m). young: list of group names compared with bench."""
    B = joint_boot(groups, nb, seed)
    c = B["crypto"]
    res = {"groups": {}, "closer": {}}
    mc, dc = groups["crypto"]["m"], groups["crypto"]["dec"]
    for nm, g in B.items():
        if nm == "crypto":
            res["groups"][nm] = {k: (v.tolist() if isinstance(v, np.ndarray) and k == "point" else v)
                                 for k, v in g.items() if k != "draws"}
            continue
        with np.errstate(all="ignore"):
            lnR = np.log(c["point"]) - np.log(g["point"])
            lnRd = np.log(c["draws"]) - np.log(g["draws"])
        lo, hi = np.nanquantile(lnRd, 0.05, axis=0), np.nanquantile(lnRd, 0.95, axis=0)
        lam, resid = lam_fit(mc, dc, groups[nm]["m"], groups[nm]["dec"])
        res["groups"][nm] = {"F": g["point"].tolist(), "R": np.exp(lnR).tolist(), "R_lo90": np.exp(lo).tolist(),
                             "R_hi90": np.exp(hi).tolist(), "lam": lam, "resid_after_lam": resid.tolist(),
                             "rows": g["rows"], "series": g["series"], "blocks": g["blocks"], "dec_used": g["dec_used"],
                             "dec_rows": g["dec_rows"], "events": g["events"], "_lnRd": lnRd}
        log(f"  {label} {nm}: rows {g['rows']} series {g['series']} dec {g['dec_used']} | R z-2/-3/-4 " +
            " ".join(f"{np.exp(x):.2f}" for x in lnR) + " | CI z-3 " + f"{np.exp(lo[1]):.2f}-{np.exp(hi[1]):.2f}" +
            f" | lam {lam:.2f} resid " + " ".join(f"{x:+.2f}" for x in resid))
    bd = res["groups"][bench]["_lnRd"]
    bp = np.log(res["groups"][bench]["R"])
    for nm in young:
        if nm not in res["groups"]:
            continue
        gd = res["groups"][nm]["_lnRd"]
        gp = np.log(res["groups"][nm]["R"])
        diff_d = np.abs(gd) - np.abs(bd)
        diff_p = np.abs(gp) - np.abs(bp)
        hi = np.nanquantile(diff_d, 0.95, axis=0)
        res["closer"][nm] = {"diff_point": diff_p.tolist(), "diff_hi90": hi.tolist(),
                             "closer_cell": [bool(p < 0 and h < 0) for p, h in zip(diff_p, hi)]}
    for nm in res["groups"]:
        res["groups"][nm].pop("_lnRd", None)
    return res


def cmd_similarity(a):
    import r16_diag as D
    log = lambda s: print(f"{now_iso()} {s}", flush=True)  # noqa: E731
    res = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "nb": a.nb, "z": ZS, "hl": {}, "cp": {}}
    # ---------------- HL lane (frozen R13.4 encoder) ----------------
    for hh in HS:
        R = r16_rows(a, hh)
        B = br_rows(a, hh)
        vs_c = R.vstate[R.cls == 0]
        cuts = np.quantile(vs_c, np.linspace(0.1, 0.9, 9))
        sid0 = len(R.keys)
        groups = {}
        for nm, mk in (("crypto", R.cls == 0), ("BR-M", R.cls == 1)):
            groups[nm] = {"sid": R.sid[mk], "block": R.block[mk], "dec": np.digitize(R.vstate[mk], cuts),
                          "m": R.m0[mk]}
        vsB = B["lns1"].astype(float) - 0.5 * B["lnLR"].astype(float)
        mB = B["depth"] / np.exp(B["lns0"])
        for era in ERA:
            mk = era_mask(B["day"], era)
            groups[era] = {"sid": B["sid"][mk], "block": block_of(B["day"][mk]), "dec": np.digitize(vsB[mk], cuts),
                           "m": mB[mk]}
        mk = np.ones(len(mB), bool)
        groups["BR-I+II"] = {"sid": B["sid"], "block": block_of(B["day"]), "dec": np.digitize(vsB, cuts), "m": mB}
        log(f"HL h={hh}")
        res["hl"][str(hh)] = similarity_table(groups, ["BR-I", "BR-II"], "BR-M", a.nb, SEED + hh, log, f"HL h{hh}")
        # deflated sensitivity (BR-I only): depth minus CPI log change over the window's calendar days
        cpi = np.load(os.path.join(a.work, "fred", f"{FRED_CPI}.npz"))
        cd, cv = cpi["d"].astype(float), np.log(cpi["v"].astype(float))
        # daily log CPI by linear interpolation between month starts
        mk = era_mask(B["day"], "BR-I")
        lt = np.interp(B["day"][mk].astype(float), cd, cv)
        le = np.interp(B["end"][mk].astype(float), cd, cv)
        mdef = (B["depth"][mk] - (le - lt)) / np.exp(B["lns0"][mk])
        g2 = dict(groups)
        g2["BR-I-deflated"] = {"sid": B["sid"][mk], "block": block_of(B["day"][mk]),
                               "dec": np.digitize(vsB[mk], cuts), "m": mdef}
        g2 = {k: g2[k] for k in ("crypto", "BR-M", "BR-I-deflated")}
        res["hl"][str(hh)]["deflated"] = similarity_table(g2, ["BR-I-deflated"], "BR-M", a.nb, SEED + 10 + hh, log,
                                                          f"HL h{hh} deflated")
        del R, B
    # ---------------- close-path lane ----------------
    z = np.load(os.path.join(a.work, "rows-r21-cp.npz"))
    info = json.load(open(os.path.join(a.work, "encode-cp-r21.json")))
    grp = np.array(info["groups"])
    eras_cp = {"OIL": [("OIL-86-99", "1986-01-01", "1999-12-31"), ("OIL-00+", "2000-01-01", "2026-12-31")],
               "GAS": [("GAS-97+", "1997-01-01", "2026-12-31")],
               "FXM": [("FXM-71-85", "1971-01-01", "1985-12-31"), ("FXM-86+", "1986-01-01", "2026-12-31")],
               "FXE": [("FXE-71-99", "1971-01-01", "1999-12-31"), ("FXE-00+", "2000-01-01", "2026-12-31")],
               "FF": [("FF-26-45", "1926-01-01", "1945-12-31"), ("FF-46-99", "1946-01-01", "1999-12-31"),
                      ("FF-00+", "2000-01-01", "2026-12-31")],
               "BR-early": [("BR-I", *ERA["BR-I"]), ("BR-II", *ERA["BR-II"])]}
    for hh in HS:
        sid, day = z[f"h{hh}_sid"], z[f"h{hh}_day"]
        keep = ~z[f"h{hh}_q2"] & np.isfinite(z[f"h{hh}_vstate"]) & np.isfinite(z[f"h{hh}_m"])
        g_of = grp[sid]
        vs = z[f"h{hh}_vstate"].astype(float)
        m = z[f"h{hh}_m"].astype(float)
        blk = block_of(day)
        cuts = np.quantile(vs[keep & (g_of == "crypto")], np.linspace(0.1, 0.9, 9))
        dec = np.digitize(vs, cuts)
        groups = {}
        for nm in ("crypto", "BR-M"):
            mk = keep & (g_of == nm)
            groups[nm] = {"sid": sid[mk], "block": blk[mk], "dec": dec[mk], "m": m[mk]}
        young = []
        for base, lst in eras_cp.items():
            for nm, lo, hi in lst:
                mk = keep & (g_of == base) & (day >= L4.date_days(lo)) & (day <= L4.date_days(hi))
                if mk.sum() == 0:
                    continue
                groups[nm] = {"sid": sid[mk], "block": blk[mk], "dec": dec[mk], "m": m[mk]}
                young.append(nm)
        log(f"CP h={hh}")
        res["cp"][str(hh)] = similarity_table(groups, young, "BR-M", a.nb, SEED + 100 + hh, log, f"CP h{hh}")
    write_json(os.path.join(a.work, "similarity-r21.json"), res)
    log("similarity done")
    del D


# =============================================================================================
# neff: distinct crash weeks and two-way N_eff
# =============================================================================================
def combined_rows(a, hh, eras):
    """r16_diag.Rows for the R13.4 dev rows + B3 1986-1999 rows of the given eras as class 6 ('eq_br_early')."""
    import r16_diag as D
    R = r16_rows(a, hh)
    if not eras:
        return R
    B = br_rows(a, hh)
    mk = np.zeros(len(B["day"]), bool)
    for e in eras:
        mk |= era_mask(B["day"], e)
    for k in D.FIELDS:
        setattr(R, k, np.concatenate([getattr(R, k), B[k][mk].astype(getattr(R, k).dtype)]))
    info = json.load(open(os.path.join(a.work, "encode-hl-r21.json")))
    R.keys = np.concatenate([R.keys, np.array([s["key"] for s in info["series"]])])
    R.subs = np.concatenate([R.subs, np.array([s["sub"] for s in info["series"]])])
    R.n = len(R.depth)
    R.m0 = R.depth / np.exp(R.lns0)
    R.week = L4.week_of(R.day)
    R.block = (R.week // BLOCK_WEEKS).astype(np.int64)
    R.year = (1970 + (R.day.astype(np.int64) / 365.2425)).astype(int)
    R.vstate = (R.lns1 - 0.5 * R.lnLR).astype(np.float64)
    return R


def set_classes(n):
    import r16_diag as D
    import r16_diag_an as AN
    cl = L4.CLASSES + (("eq_br_early",) if n == 7 else ())
    D.CLASSES = cl
    AN.CLASSES = cl


def cmd_neff(a):
    import r16_diag as D
    import r16_diag_an as AN
    log = lambda s: print(f"{now_iso()} {s}", flush=True)  # noqa: E731
    res = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "nb": a.nb, "hl": {}, "cp": {}}
    for hh in (1, 3):
        set_classes(7)
        R = combined_rows(a, hh, ["BR-I", "BR-II"])
        isc = R.cls == 0
        span0 = int(R.day[isc].min())
        out = {"crypto_first_origin_day": span0}
        for z in (-3.0, -4.0):
            ev = R.m0 <= z
            wk = R.week
            w_c = set(np.unique(wk[ev & isc]).tolist())
            w_dev_nc = set(np.unique(wk[ev & (R.cls >= 1) & (R.cls <= 5)]).tolist())
            ent = {}
            for nm, mk in (("BR-I", (R.cls == 6) & era_mask(R.day, "BR-I")),
                           ("BR-II", (R.cls == 6) & era_mask(R.day, "BR-II")), ("BR-I+II", R.cls == 6),
                           ("dev-noncrypto", (R.cls >= 1) & (R.cls <= 5)), ("crypto", isc)):
                w = np.unique(wk[ev & mk])
                ws = set(w.tolist())
                ent[nm] = {"weeks": len(ws), "events": int((ev & mk).sum()),
                           "weeks_before_crypto_span": int(np.sum(w < L4.week_of(span0))),
                           "weeks_without_crypto_event": len(ws - w_c),
                           "weeks_new_vs_dev_noncrypto": len(ws - w_dev_nc),
                           "weeks_new_vs_all_dev": len(ws - w_c - w_dev_nc)}
            # two-way N_eff (diagnosis method)
            one = np.ones(R.n)
            ne = {}
            ne["crypto_only"] = AN.neff_events(R, isc, z, one, a.nb, AN.gkey("r21ne1", hh, z))
            mk0 = R.cls <= 5
            set_classes(6)
            w0 = D.cls_weights(R.cls, mk0)
            ne["dev_pool_class_equal"] = AN.neff_events(R, mk0, z, w0, a.nb, AN.gkey("r21ne2", hh, z))
            set_classes(7)
            w1 = D.cls_weights(R.cls)
            ne["dev_pool_plus_BR_class_equal"] = AN.neff_events(R, np.ones(R.n, bool), z, w1, a.nb,
                                                                AN.gkey("r21ne3", hh, z))
            ne["BR_only"] = AN.neff_events(R, R.cls == 6, z, one, a.nb, AN.gkey("r21ne4", hh, z))
            ne["noncrypto_plus_BR_class_equal"] = AN.neff_events(R, ~isc, z, D.cls_weights(R.cls, ~isc), a.nb,
                                                                 AN.gkey("r21ne5", hh, z))
            ent["neff"] = ne
            out[f"z{z}"] = ent
            log(f"HL h={hh} z={z}: BR weeks {ent['BR-I+II']['weeks']} (before crypto span "
                f"{ent['BR-I+II']['weeks_before_crypto_span']}, new vs all dev {ent['BR-I+II']['weeks_new_vs_all_dev']})"
                f" | N_eff two-way crypto {ne['crypto_only']['neff_events_two'] or 0:.0f}, dev pool "
                f"{ne['dev_pool_class_equal']['neff_events_two'] or 0:.0f} -> +BR "
                f"{ne['dev_pool_plus_BR_class_equal']['neff_events_two'] or 0:.0f}; BR alone "
                f"{ne['BR_only']['neff_events_two'] or 0:.0f}")
        res["hl"][str(hh)] = out
        del R
    # close-path weeks
    z_ = np.load(os.path.join(a.work, "rows-r21-cp.npz"))
    info = json.load(open(os.path.join(a.work, "encode-cp-r21.json")))
    grp = np.array(info["groups"])
    for hh in (1, 3):
        sid, day, m = z_[f"h{hh}_sid"], z_[f"h{hh}_day"], z_[f"h{hh}_m"].astype(float)
        keep = ~z_[f"h{hh}_q2"] & np.isfinite(m)
        g_of = grp[sid]
        wk = L4.week_of(day)
        span0 = int(day[keep & (g_of == "crypto")].min())
        out = {"crypto_first_origin_day": span0}
        for z in (-3.0, -4.0):
            ev = keep & (m <= z)
            w_c = set(np.unique(wk[ev & (g_of == "crypto")]).tolist())
            w_dev = set(np.unique(wk[ev & np.isin(g_of, ["BR-M", "dev-etf", "dev-fx", "dev-index",
                                                         "dev-commodity"])]).tolist())
            ent = {}
            for nm in ("BR-early", "OIL", "GAS", "FXM", "FXE", "FF"):
                w = np.unique(wk[ev & (g_of == nm)])
                ws = set(w.tolist())
                ent[nm] = {"weeks": len(ws), "events": int((ev & (g_of == nm)).sum()),
                           "weeks_before_crypto_span": int(np.sum(w < L4.week_of(span0))),
                           "weeks_without_crypto_event": len(ws - w_c), "weeks_new_vs_all_dev": len(ws - w_c - w_dev)}
            allw = set()
            for nm in ("BR-early", "OIL", "GAS", "FXM", "FXE", "FF"):
                allw |= set(np.unique(wk[ev & (g_of == nm)]).tolist())
            ent["all_analogs"] = {"weeks": len(allw), "weeks_new_vs_all_dev": len(allw - w_c - w_dev),
                                  "crypto_weeks": len(w_c), "dev_weeks": len(w_c | w_dev)}
            out[f"z{z}"] = ent
            log(f"CP h={hh} z={z}: " + "; ".join(f"{k} {v['weeks']}/{v['weeks_new_vs_all_dev']}" for k, v in ent.items()
                                                 if k != "all_analogs") + f"; all {ent['all_analogs']}")
        res["cp"][str(hh)] = out
    write_json(os.path.join(a.work, "neff-r21.json"), res)
    log("neff done")


# =============================================================================================
# transfer: arms A0/A1/A2 (reg2) on seen B12/B9 deep cells vs (fH) and L_all
# =============================================================================================
LEVELS_T = (-0.15, -0.20, -0.25, -0.30, -0.40)
PRIMARY = (-0.15, -0.20, -0.30)
ARMS = {"A0": [], "A1": ["BR-I", "BR-II"], "A2": ["BR-I"]}


def cgm_z(d, si, bi):
    """mean(d) / sqrt(V_s + V_b - V_sb): analytic two-way cluster-robust variance of the mean."""
    n = len(d)
    u = d - d.mean()

    def vc(g):
        _, inv = np.unique(g, return_inverse=True)
        s = np.bincount(inv, weights=u)
        return float(np.sum(s * s)) / n ** 2
    v = vc(si) + vc(bi) - vc(si.astype(np.int64) * 10 ** 7 + bi)
    return float(d.mean() / math.sqrt(v)) if v > 0 else None


def calib_slope(p, y):
    x = np.log(np.clip(p, 1e-7, 1 - 1e-7) / (1 - np.clip(p, 1e-7, 1 - 1e-7)))
    b = np.array([0.0, 1.0])
    X = np.c_[np.ones(len(x)), x]
    for _ in range(50):
        eta = X @ b
        mu = 1 / (1 + np.exp(-eta))
        W = mu * (1 - mu) + 1e-12
        g = X.T @ (y - mu)
        H = X.T @ (X * W[:, None])
        step = np.linalg.solve(H, g)
        b = b + step
        if np.max(np.abs(step)) < 1e-8:
            break
    return float(b[1])


def leave_top(d, y, bi, k):
    if k == 0:
        return float(d.mean())
    _, inv = np.unique(bi, return_inverse=True)
    pos = np.bincount(inv, weights=y)
    top = np.argsort(-pos, kind="mergesort")[:k]
    keep = ~np.isin(inv, top)
    return float(d[keep].mean()) if keep.any() else None


def cmd_transfer(a):
    import r16_diag as D
    import r16_diag_an as AN
    log = lambda s: print(f"{now_iso()} {s}", flush=True)  # noqa: E731
    FH = np.load(a.fh)
    res = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "nb": a.nb, "arms": ARMS, "cells": {}, "pooled": {},
           "power": {}}
    pooled = {arm: {"d": [], "si": [], "bi": [], "y": []} for arm in ("A1", "A2")}
    lv = np.array(LEVELS_T)
    for hh in (1, 3):
        T = 24 * hh
        kid = {k: i for i, k in enumerate(np.unique(FH[f"T{T}_key"]))}
        code = np.array([kid[k] for k in FH[f"T{T}_key"]], np.int64) * 10 ** 6 + FH[f"T{T}_ts"] // DAY
        lut = dict(zip(code.tolist(), range(len(code))))
        Rs = {}
        for arm, eras in ARMS.items():
            set_classes(7 if eras else 6)
            Rs[arm] = combined_rows(a, hh, eras)
        for scored in ("b12", "b9"):
            P = {}
            base = None
            for arm, eras in ARMS.items():
                set_classes(7 if eras else 6)
                R = Rs[arm]
                ids = np.where(R.subs == scored)[0]
                insc = (R.cls == 0) & np.isin(R.sid, ids)
                tr = ~insc
                idx = np.where(insc)[0]
                mk_ = np.array([kid.get(R.keys[s], -1) for s in R.sid[idx]], np.int64)
                cc = mk_ * 10 ** 6 + (R.day[idx].astype(np.int64) + 1)
                hit = np.array([lut.get(c_, -1) if m_ >= 0 else -1 for c_, m_ in zip(cc.tolist(), mk_.tolist())])
                okh = hit >= 0
                idx, hit = idx[okh], hit[okh]
                if base is None:
                    pf = FH[f"T{T}_pH"][hit].astype(float)
                    Y = (R.depth[idx][:, None] <= np.log1p(lv)[None, :]).astype(np.int8)
                    w = D.cls_weights(R.cls, tr)
                    lib = D.lib_from(R.m0, w)
                    zt = np.log1p(lv)[None, :] / np.exp(R.lns0[idx])[:, None]
                    P["L_all"] = np.stack([D.F_at(lib, zt[:, j]) for j in range(len(lv))], 1)
                    P["fH"] = pf
                    base = {"si": R.sid[idx].copy(), "bi": R.block[idx].copy(), "day": R.day[idx].copy(), "Y": Y,
                            "n": len(idx)}
                else:
                    assert len(idx) == base["n"] and np.array_equal(R.sid[idx], base["si"]), "row alignment"
                P[arm] = AN.fix_predict(R, tr, idx, "V0", "reg2", LEVELS_T)
            log(f"h={hh} {scored}: matched rows {base['n']}")
            for j, k in enumerate(LEVELS_T):
                ok = np.isfinite(P["fH"][:, j])
                y = base["Y"][ok, j].astype(float)
                si, bi = base["si"][ok], base["bi"][ok]
                ent = {"rows": int(ok.sum()), "pos": int(y.sum()), "blocks": int(len(np.unique(bi))),
                       "pos_blocks": int(len(np.unique(bi[y > 0]))), "primary": k in PRIMARY, "models": {}, "cmp": {}}
                for nm, p_ in P.items():
                    p = p_[ok, j]
                    ent["models"][nm] = {"R": float(p.sum() / max(y.sum(), 1)), "brier": float(np.mean((p - y) ** 2)),
                                         "slope": calib_slope(p, y) if y.sum() >= 5 else None}
                for cand, ref in (("A0", "fH"), ("A1", "fH"), ("A2", "fH"), ("A0", "L_all"), ("A1", "L_all"),
                                  ("A2", "L_all"), ("A1", "A0"), ("A2", "A0"), ("L_all", "fH")):
                    d = (P[cand][ok, j] - y) ** 2 - (P[ref][ok, j] - y) ** 2
                    one = np.ones(len(d))
                    v2 = float(np.var(D.twoway_var(si, bi, d, one, a.nb, AN.gkey("r21t", hh, scored, k, cand, ref))))
                    md = float(d.mean())
                    c = {"mean_d": md, "bss": float(1 - ent["models"][cand]["brier"] / ent["models"][ref]["brier"]),
                         "z_two": md / math.sqrt(v2) if v2 > 0 else None, "z_cgm": cgm_z(d, si, bi),
                         "leave_top1": leave_top(d, y, bi, 1), "leave_top3": leave_top(d, y, bi, 3)}
                    ent["cmp"][f"{cand}_vs_{ref}"] = c
                    if ref == "A0" and k in PRIMARY:
                        pooled[cand]["d"].append(d / ent["models"]["A0"]["brier"])
                        pooled[cand]["si"].append(si)
                        pooled[cand]["bi"].append(bi)
                        pooled[cand]["y"].append(y)
                res["cells"][f"h{hh}/{scored}/{k}"] = ent
                cm = ent["cmp"]
                log(f"  h={hh} {scored} k={k}: pos {ent['pos']} posblk {ent['pos_blocks']} | R fH "
                    f"{ent['models']['fH']['R']:.2f} L_all {ent['models']['L_all']['R']:.2f} A0 "
                    f"{ent['models']['A0']['R']:.2f} A1 {ent['models']['A1']['R']:.2f} A2 {ent['models']['A2']['R']:.2f}"
                    f" | BSS A1vA0 {cm['A1_vs_A0']['bss']:+.4f} (z {cm['A1_vs_A0']['z_two'] or 0:+.2f}) A2vA0 "
                    f"{cm['A2_vs_A0']['bss']:+.4f} (z {cm['A2_vs_A0']['z_two'] or 0:+.2f}) | vs fH A0 "
                    f"{cm['A0_vs_fH']['bss']:+.4f} A1 {cm['A1_vs_fH']['bss']:+.4f} (z {cm['A1_vs_fH']['z_two'] or 0:+.2f})")
        del Rs
    # pooled 12-cell statistic and pass rule
    for arm in ("A1", "A2"):
        d = np.concatenate(pooled[arm]["d"])
        si = np.concatenate(pooled[arm]["si"])
        bi = np.concatenate(pooled[arm]["bi"])
        v2 = float(np.var(D.twoway_var(si, bi, d, np.ones(len(d)), a.nb, AN.gkey("r21pool", arm))))
        prim = [c for c in res["cells"].values() if c["primary"]]
        nwin = sum(1 for c in prim if c["cmp"][f"{arm}_vs_A0"]["bss"] > 0)
        rbad = sum(1 for c in prim if not (0.8 <= c["models"][arm]["R"] <= 1.25) and (0.8 <= c["models"]["A0"]["R"]
                                                                                     <= 1.25))
        # leave-top-3 on the pooled statistic: drop the 3 blocks with the most positives over the primary cells
        yy = np.concatenate(pooled[arm]["y"])
        lt3 = leave_top(d, yy, bi, 3)
        z2 = float(d.mean() / math.sqrt(v2)) if v2 > 0 else None
        cgm = cgm_z(d, si, bi)
        helps = (nwin >= 8) and (z2 is not None and z2 <= -1.645) and rbad == 0 and (lt3 is not None and lt3 < 0)
        res["pooled"][arm] = {"mean": float(d.mean()), "z_two": z2, "z_cgm": cgm, "cells_bss_pos": nwin,
                              "cells": len(prim), "R_band_breaks": rbad, "leave_top3_mean": lt3, "HELPS": bool(helps)}
        log(f"pooled {arm} vs A0: mean {d.mean():+.5f} z {z2:+.2f} cgm {cgm or 0:+.2f}; BSS>0 in {nwin}/{len(prim)};"
            f" R breaks {rbad}; leave-top3 {lt3}; HELPS {helps}")
    # power reading (D-R13.5c rule 1): blocks for 80% at one-sided 5%, G* = G_dev (2.487 / z)^2
    for tag in ("A1_vs_A0", "A2_vs_A0", "A0_vs_fH", "A1_vs_fH", "A2_vs_fH"):
        best = None
        for key, c in res["cells"].items():
            zz = c["cmp"][tag]["z_two"]
            if zz is not None and c["cmp"][tag]["mean_d"] < 0 and (best is None or zz < best[1]):
                best = (key, zz, c["blocks"])
        if best is None:
            res["power"][tag] = {"best_cell": None, "note": "no cell with mean d < 0"}
        else:
            res["power"][tag] = {"best_cell": best[0], "z_dev": best[1], "blocks_dev": best[2],
                                 "G_star_80pct": float(best[2] * (2.487 / abs(best[1])) ** 2)}
        log(f"power {tag}: {res['power'][tag]}")
    write_json(os.path.join(a.work, "transfer-r21.json"), res)
    log("transfer done")


# =============================================================================================
# placebo (POST HOC, reported only; added after the transfer result was seen): does any added 7th class help
# through dilution alone? P1 = A0 + a duplicate of the modern B3 dev equity rows (2000-2026) as class 6.
# Same seeds, cells and pooled statistic as cmd_transfer. Not part of the registered menu.
# =============================================================================================
def placebo_rows(a, hh):
    import r16_diag as D
    R = r16_rows(a, hh)
    mk = R.cls == 1
    off = len(R.keys)
    for k in D.FIELDS:
        v = getattr(R, k)
        add = v[mk].copy()
        if k == "cls":
            add[:] = 6
        if k == "sid":
            add = add + off
        setattr(R, k, np.concatenate([v, add]))
    R.keys = np.concatenate([R.keys, np.array([f"placebo:{x}" for x in R.keys])])
    R.subs = np.concatenate([R.subs, np.array(["placebo"] * off)])
    R.n = len(R.depth)
    R.m0 = R.depth / np.exp(R.lns0)
    R.week = L4.week_of(R.day)
    R.block = (R.week // BLOCK_WEEKS).astype(np.int64)
    R.vstate = (R.lns1 - 0.5 * R.lnLR).astype(np.float64)
    return R


def cmd_placebo(a):
    import r16_diag as D
    import r16_diag_an as AN
    log = lambda s: print(f"{now_iso()} {s}", flush=True)  # noqa: E731
    FH = np.load(a.fh)
    res = {"created_utc": now_iso(), "code_sha": L4.git_sha(), "post_hoc": True, "cells": {}, "pooled": {}}
    pooled = {"d": [], "si": [], "bi": [], "y": []}
    lv = np.array(LEVELS_T)
    for hh in (1, 3):
        T = 24 * hh
        kid = {k: i for i, k in enumerate(np.unique(FH[f"T{T}_key"]))}
        code = np.array([kid[k] for k in FH[f"T{T}_key"]], np.int64) * 10 ** 6 + FH[f"T{T}_ts"] // DAY
        lut = dict(zip(code.tolist(), range(len(code))))
        set_classes(6)
        R0 = r16_rows(a, hh)
        set_classes(7)
        R1 = placebo_rows(a, hh)
        for scored in ("b12", "b9"):
            P = {}
            for nm, R, ncl in (("A0", R0, 6), ("P1", R1, 7)):
                set_classes(ncl)
                ids = np.where(R.subs == scored)[0]
                insc = (R.cls == 0) & np.isin(R.sid, ids)
                tr = ~insc
                idx = np.where(insc)[0]
                mk_ = np.array([kid.get(R.keys[s_], -1) for s_ in R.sid[idx]], np.int64)
                cc = mk_ * 10 ** 6 + (R.day[idx].astype(np.int64) + 1)
                hit = np.array([lut.get(c_, -1) if m_ >= 0 else -1 for c_, m_ in zip(cc.tolist(), mk_.tolist())])
                okh = hit >= 0
                idx, hit = idx[okh], hit[okh]
                if nm == "A0":
                    P["fH"] = FH[f"T{T}_pH"][hit].astype(float)
                    Y = (R.depth[idx][:, None] <= np.log1p(lv)[None, :]).astype(np.int8)
                    si0, bi0 = R.sid[idx].copy(), R.block[idx].copy()
                P[nm] = AN.fix_predict(R, tr, idx, "V0", "reg2", LEVELS_T)
            for j, k in enumerate(LEVELS_T):
                ok = np.isfinite(P["fH"][:, j])
                y = Y[ok, j].astype(float)
                si, bi = si0[ok], bi0[ok]
                d = (P["P1"][ok, j] - y) ** 2 - (P["A0"][ok, j] - y) ** 2
                b0 = float(np.mean((P["A0"][ok, j] - y) ** 2))
                v2 = float(np.var(D.twoway_var(si, bi, d, np.ones(len(d)), a.nb, AN.gkey("r21t", hh, scored, k,
                                                                                           "A1", "A0"))))
                ent = {"bss_P1_vs_A0": float(-d.mean() / b0), "z_two": float(d.mean() / math.sqrt(v2)) if v2 > 0 else None,
                       "R_P1": float(P["P1"][ok, j].sum() / max(y.sum(), 1)),
                       "R_A0": float(P["A0"][ok, j].sum() / max(y.sum(), 1))}
                res["cells"][f"h{hh}/{scored}/{k}"] = ent
                if k in PRIMARY:
                    pooled["d"].append(d / b0)
                    pooled["si"].append(si)
                    pooled["bi"].append(bi)
                    pooled["y"].append(y)
                log(f"  h={hh} {scored} k={k}: P1 vs A0 BSS {ent['bss_P1_vs_A0']:+.4f} z {ent['z_two'] or 0:+.2f} "
                    f"R A0 {ent['R_A0']:.2f} P1 {ent['R_P1']:.2f}")
        del R0, R1
    d = np.concatenate(pooled["d"])
    si = np.concatenate(pooled["si"])
    bi = np.concatenate(pooled["bi"])
    v2 = float(np.var(D.twoway_var(si, bi, d, np.ones(len(d)), a.nb, AN.gkey("r21pool", "A1"))))
    nwin = sum(1 for kk, c in res["cells"].items() if float(kk.split("/")[2]) in PRIMARY and c["bss_P1_vs_A0"] > 0)
    res["pooled"] = {"mean": float(d.mean()), "z_two": float(d.mean() / math.sqrt(v2)), "z_cgm": cgm_z(d, si, bi),
                     "cells_bss_pos": nwin}
    log(f"placebo pooled P1 vs A0: {res['pooled']}")
    write_json(os.path.join(a.work, "placebo-r21.json"), res)


# =============================================================================================
# main
# =============================================================================================
def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("acquire")
    p.add_argument("--work", default=WORK)
    p.add_argument("--skip-b3", action="store_true")
    for nm in ("resegment", "encode-hl", "encode-cp", "similarity", "neff", "transfer", "placebo"):
        p = sub.add_parser(nm)
        p.add_argument("--work", default=WORK)
        p.add_argument("--datasets", default="/home/user/membrane-datasets")
        p.add_argument("--data", default="/home/user/r13work/r134/data")
        p.add_argument("--acq", default="/home/user/r13work/r134/dev-cad651e9/acq_r12")
        p.add_argument("--meta", default="/home/user/r13work/r134/dev-cad651e9/meta-r134-dev.json")
        p.add_argument("--r16rows", default=R16_ROWS)
        p.add_argument("--r16meta", default=R16_META)
        p.add_argument("--fh", default="/home/user/membrane-datasets/history-forecasts/r13/r134-dev-cad651e9/"
                                       "fh-r134.npz")
        p.add_argument("--workers", type=int, default=3)
        p.add_argument("--nb", type=int, default=NB)
    a = ap.parse_args()
    {"acquire": cmd_acquire, "resegment": cmd_resegment, "encode-hl": cmd_encode_hl, "encode-cp": cmd_encode_cp,
     "similarity": cmd_similarity, "neff": cmd_neff, "transfer": cmd_transfer, "placebo": cmd_placebo}[a.cmd](a)


if __name__ == "__main__":
    main()
