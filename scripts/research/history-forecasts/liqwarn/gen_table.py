"""Generate the versioned routing table (JSON) for liqwarn/router.py from the Q26 UI confidence map.

The map (membrane-board knowledge/q26-ui-confidence-map.md) is the source of truth. This script parses its tables
into rules. It never invents a class: an unparseable row is kept in "unparsed" and never routes.

  python3 gen_table.py --map <q26-ui-confidence-map.md> [--live <design/HISTORY_TOUCH_LIVE.md>]
                       [--datasets <local membrane-datasets checkout>] --out routing-table.json

Live D12 classes (HISTORY_TOUCH_LIVE.md D12-A2): with --datasets, the live monitor flags are read from
<datasets>/forecasts/q26-touch-live/d12/classes.json. Its cells define the D12 coverage (instead of the board
sentence), and every cell the live monitor has downgraded (live class CALIBRATED, downgraded = true) gets a "live"
rule ranked above every map section, so the router shows it as CALIBRATED (labelled context, not a warning).

Sections read (in precedence order, highest first):
  "Release grading" (written by the R19.3 regrade; read when present, any table with horizon/level/class columns)
  "Borrower liquidation warnings"
  "Oracle and liquidation-proximity"
  "Price-touch odds"
Deterministic: the same map bytes give the same rules (generated_utc is the only time-varying field, and it is not
part of the table version).
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re

SCHEMA = "liqwarn-routing/1"
SECTIONS = [("release", r"release grading"), ("borrower", r"borrower liquidation warnings"),
            ("oracle", r"oracle and liquidation-proximity"), ("touch", r"price-touch odds")]
SECTION_RANK = {"live": -1, "release": 0, "borrower": 1, "oracle": 2, "touch": 3}
D12_CLASSES_REL = "forecasts/q26-touch-live/d12/classes.json"
D12_GROUP = {"ETHBTC": "btc_eth", "LARGE": "large"}
CLASSES = ["SKILL", "CALIBRATED-WARN", "RECALIBRATE", "CALIBRATED", "PENDING", "SCENARIO", "HISTORY COUNT",
           "DO NOT SHOW"]
MONITORS = ("D12", "D11", "D10", "D9", "D8")
INF_H = 10 ** 6
DASH = "–—-"            # en dash, em dash, hyphen
MINUS = "−"


# ---------------------------------------------------------------------------------------------------------------------
# markdown
# ---------------------------------------------------------------------------------------------------------------------
def split_sections(md):
    """-> list of (heading text, body) for '## ' sections."""
    out, cur, buf = [], None, []
    for line in md.splitlines():
        if line.startswith("## "):
            if cur is not None:
                out.append((cur, "\n".join(buf)))
            cur, buf = line[3:].strip(), []
        elif cur is not None:
            buf.append(line)
    if cur is not None:
        out.append((cur, "\n".join(buf)))
    return out


def md_tables(body):
    """-> list of tables; each table = (header cells, rows of cells)."""
    tables, cur = [], []
    for line in body.splitlines() + [""]:
        if line.strip().startswith("|"):
            cur.append(line.strip())
        elif cur:
            tables.append(cur)
            cur = []
    out = []
    for t in tables:
        rows = [[c.strip() for c in r.strip("|").split("|")] for r in t]
        if len(rows) < 2:
            continue
        hdr, body_rows = rows[0], [r for r in rows[2:] if not all(set(c) <= set("-: ") for c in r)]
        out.append((hdr, body_rows))
    return out


def strip_md(s):
    return re.sub(r"\*\*|`", "", s).strip()


# ---------------------------------------------------------------------------------------------------------------------
# field parsers
# ---------------------------------------------------------------------------------------------------------------------
def _num(s):
    return float(s.replace(MINUS, "-").replace(",", "."))


def _unit_h(u):
    return {"h": 1, "d": 24}[u]


def parse_horizon(s):
    """-> list of [lo_h, hi_h] intervals (inclusive), or None if unparseable. 'any' -> [[0, INF]]."""
    t = strip_md(s).lower().replace("within", "").strip()
    if t in ("any", "all", ""):
        return [[0, INF_H]] if t in ("any", "all") else None
    t = re.sub(r"\(.*?\)", "", t)
    out = []
    for part in [p.strip() for p in t.split(",") if p.strip()]:
        m = re.fullmatch(rf"(\d+(?:\.\d+)?)\s*([hd])?\s*[{DASH}]\s*(\d+(?:\.\d+)?)\s*([hd])", part)
        if m:
            a, ua, b, ub = m.groups()
            ua = ua or ub
            out.append([float(a) * _unit_h(ua), float(b) * _unit_h(ub)])
            continue
        m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([hd])", part)
        if m:
            v = float(m.group(1)) * _unit_h(m.group(2))
            out.append([v, v])
            continue
        return None
    return out or None


LEVEL_VOCAB = [  # phrases the map uses without numbers (the 6 h ETH/BTC row defines shallow-mid as "to -10%")
    (r"shallow.mid", {"kind": "range", "lo": -0.10, "hi": 0.0}),
    (r"same bands", {"kind": "range", "lo": -0.10, "hi": 0.0}),
    (r"deeper than the bands", {"kind": "range", "lo": -1.0, "hi": -0.04}),
    (r"label classes", {"kind": "range", "lo": -1.0, "hi": 0.0}),
]


def parse_levels(s):
    """-> dict {kind: 'range'|'set', lo, hi} in fractions (negative), or None. 'to -10%' = [-0.10, 0];
    '-25% and deeper' = [-1, -0.25]; '-15%, -20%' = set; '-2...-10%' = [-0.10, -0.02]; 'any'/'all' = [-1, 0]."""
    t = strip_md(s).lower().replace(MINUS, "-")
    if not re.search(r"\d", t):
        for rx, val in LEVEL_VOCAB:
            if re.search(rx, t):
                return dict(val)
    if re.search(r"\b(any|all)\b", t) and not re.search(r"\d", t):
        return {"kind": "range", "lo": -1.0, "hi": 0.0}
    m = re.search(r"\bto\s*(-\d+(?:\.\d+)?)%", t)
    if m:
        return {"kind": "range", "lo": _num(m.group(1)) / 100, "hi": 0.0}
    m = re.search(r"(-\d+(?:\.\d+)?)%\s*and deeper", t)
    if m:
        return {"kind": "range", "lo": -1.0, "hi": _num(m.group(1)) / 100}
    m = re.search(r"(-\d+(?:\.\d+)?)%?\s*(?:…|\.\.\.|[" + DASH + r"])\s*(-\d+(?:\.\d+)?)%", t)
    if m:
        a, b = _num(m.group(1)) / 100, _num(m.group(2)) / 100
        return {"kind": "range", "lo": min(a, b), "hi": max(a, b)}
    vals = [_num(v) / 100 for v in re.findall(r"(-\d+(?:\.\d+)?)%", t)]
    vals += [_num(v) / 100 for v in re.findall(r"(-\d+(?:\.\d+)?)(?=/)", t)]      # '-2/-3%' style
    if vals:
        return {"kind": "set", "values": sorted(set(round(v, 6) for v in vals))}
    return None


ASSET_WORDS = [("btc_eth", r"\beth\b|\bbtc\b"), ("large", r"large caps?"), ("steth", r"steth"),
               ("alt", r"altcoin|small caps?|gate\.io small"), ("young", r"young")]


def parse_assets(s):
    t = strip_md(s).lower()
    if re.fullmatch(r"\s*(any|all)\s*", t):
        return ["btc_eth", "large", "alt", "young", "steth"]
    got = [k for k, rx in ASSET_WORDS if re.search(rx, t)]
    if "young" in got:
        got = ["young"]
    return got or None


def parse_class(s):
    t = strip_md(s).upper()
    for c in CLASSES:
        if c in t:
            return c
    if "CALIBRATED CONTEXT" in t:
        return "CALIBRATED"
    return None


SOURCE_RULES = [  # (regex on the whole row text, source id). First match wins.
    (r"chained", "chain"),
    (r"\breg2\b", "reg2_young"),
    (r"\bgru\b", "gru"),
    (r"twap .already through.|already through", "imminent_oracle"),
    (r"recursive \(fh\)", "recursive_fH"),
    (r"pooled standardized library", "pooled_library"),
    (r"probability ranges", "prob_ranges"),
    (r"linear pool", "linear_pool"),
    (r"r13\.1 recalibration", "recal_r131"),
    (r"recalibrat", "recal_fH"),
    (r"liquidation ladder", "measured"),
    (r"liquidation volume", "scenario"),
    (r"position-level", "position_odds"),
]


def source_of(row_text, cls):
    t = row_text.lower()
    for rx, src in SOURCE_RULES:
        if re.search(rx, t):
            if src == "recal_fH" and cls not in ("RECALIBRATE",):
                continue
            return src
    if cls == "RECALIBRATE":
        return "recal_fH"
    return "raw_fH"


def monitor_of(row_text, cls, live_ids):
    found = [m for m in MONITORS if re.search(rf"\b{m}\b", row_text)]
    if found:
        mid = found[0]
    elif cls == "CALIBRATED-WARN":
        mid = "D12"                                    # owner ruling 2026-10-24: CALIBRATED-WARN needs D12
    else:
        return {"id": None, "status": "none"}
    return {"id": mid, "status": "deployed" if mid in live_ids else "planned"}


# ---------------------------------------------------------------------------------------------------------------------
def explicit_cells(evidence):
    """'only at 1 h -2/-3%, 3 h -2/-3%, 12 h -2%' -> [[1, -0.02], [1, -0.03], [3, ...], [12, -0.02]]; None if absent."""
    t = strip_md(evidence).replace(MINUS, "-")
    m = re.search(r"only at ([^.;()]*)", t)
    if not m:
        return None
    cells = []
    for h, u, ks in re.findall(r"(\d+)\s*([hd])\s*((?:-\d+(?:\.\d+)?%?/?)+)", m.group(1)):
        for k in re.findall(r"-\d+(?:\.\d+)?", ks):
            cells.append([float(h) * _unit_h(u), float(k) / 100])
    return cells or None


def _col(hdr, *names):
    for j, h in enumerate(hdr):
        hl = strip_md(h).lower()
        if any(n in hl for n in names):
            return j
    return None


GROUP_WORDS = {"eth/btc": "btc_eth", "eth, btc": "btc_eth", "large caps": "large", "large": "large",
               "altcoins": "alt", "altcoin": "alt"}
SEG_RX = re.compile(r"^(CALIBRATED-WARN|RECALIBRATE|DO NOT SHOW|HISTORY COUNT|CALIBRATED)\s+((?:[-\u2212]\d+(?:\.\d+)?%?,?\s*)+)")


def _pairs(text):
    """'altcoins 1 h -5%, 3 h -7%' / '-10% 6 h-7 d' style -> list of (group|None, [lo_h, hi_h], k)."""
    t = strip_md(text).replace(MINUS, "-")
    out, grp = [], None
    for m in re.finditer(r"(eth/btc|large caps|altcoins)?\s*(\d+)\s*([hd])\s*(-\d+(?:\.\d+)?(?:,\s*-\d+(?:\.\d+)?)*)%", t,
                         flags=re.I):
        if m.group(1):
            grp = GROUP_WORDS[m.group(1).lower()]
        h = float(m.group(2)) * _unit_h(m.group(3))
        for k in re.findall(r"-\d+(?:\.\d+)?", m.group(4)):
            out.append((grp, [h, h], float(k) / 100))
    return out


def parse_release(body, live_ids, d12_cov=None):
    """The R19.3 'Release grading' section: a Group | T | 'Class by level' table, plus the recalibration transfer
    sentence and the D12 coverage sentence. -> (rules, unparsed)."""
    rules, unparsed = [], []
    flat = strip_md(body).replace(MINUS, "-")
    m = re.search(r"repair holds at[^:]*:\s*([^.]*)\.", flat)
    confirmed = {(g or "alt", h[0], k) for g, h, k in _pairs(m.group(1))} if m else set()
    m = re.search(r"Cells repaired in walk-forward CV:\s*(.*?)(?:\n|$)", flat)
    cv = set()
    if m:
        for part in m.group(1).split("."):
            g = None
            pl = part.strip().lower()
            for w, gid in GROUP_WORDS.items():
                if pl.startswith(w):
                    g = gid
                    break
            for _g, h, k in _pairs(part):
                cv.add((g or "alt", h[0], k))
    m = re.search(r"D12[^.]*?covers\s+([^.]*)\.", flat)
    d12 = []
    if m:
        grp_txt = m.group(1).lower()
        d12_groups = [gid for w, gid in (("eth/btc", "btc_eth"), ("large caps", "large")) if w in grp_txt]
        for k, a, ua, b, ub in re.findall(r"(-\d+)%\s*(\d+)\s*([hd])?\s*[" + DASH + r"]\s*(\d+)\s*([hd])", m.group(1)):
            ua = ua or ub
            d12.append((d12_groups, float(a) * _unit_h(ua), float(b) * _unit_h(ub), float(k) / 100))

    def mon(grp, h, k, cls):
        if d12_cov is not None:                      # live classes.json coverage replaces the board sentence
            if (grp, float(h), round(k, 4)) in d12_cov:
                return {"id": "D12", "status": "deployed"}
            if cls in ("CALIBRATED-WARN", "RECALIBRATE"):
                return {"id": None, "status": "needed"}
            return {"id": None, "status": "none"}
        for gs, lo, hi, kk in d12:
            if grp in gs and lo <= h <= hi and abs(k - kk) < 1e-9:
                return {"id": "D12", "status": "deployed" if "D12" in live_ids else "planned"}
        if cls in ("CALIBRATED-WARN", "RECALIBRATE"):
            return {"id": None, "status": "needed"}
        return {"id": None, "status": "none"}

    for ti, (hdr, rows) in enumerate(md_tables(body)):
        cg, ct = _col(hdr, "group"), _col(hdr, "t")
        cc = _col(hdr, "class by level", "class")
        if None in (cg, ct, cc):
            continue
        for ri, r in enumerate(rows):
            text = " | ".join(r)
            grp = GROUP_WORDS.get(strip_md(r[cg]).lower())
            hz = parse_horizon(r[ct])
            if grp is None or hz is None:
                unparsed.append({"id": f"release-{ti}-{ri}", "row": text, "why": "group or horizon"})
                continue
            h = hz[0][0]
            for si, seg in enumerate(re.split(r"<br\s*/?>", r[cc])):
                seg = strip_md(seg).replace(MINUS, "-")
                ms = SEG_RX.match(seg)
                if not ms:
                    unparsed.append({"id": f"release-{ti}-{ri}-{si}", "row": seg, "why": "segment"})
                    continue
                cls = ms.group(1)
                ks = [float(x) / 100 for x in re.findall(r"-\d+(?:\.\d+)?", ms.group(2))]
                for k in ks:
                    rid = f"release-{ti}-{ri}-{si}-{int(round(-100 * k))}"
                    src, c2, val = "raw_fH", cls, None
                    if cls == "RECALIBRATE":
                        src = "recal_fH"
                        if (grp, h, k) in confirmed:
                            val = True                         # transfer-confirmed C3 repair
                        elif (grp, h, k) in cv:
                            c2, val = "CALIBRATED", True       # CV-repaired only: labelled context
                        else:
                            val = False                        # no validated fix: not warning odds
                    rule = {"id": rid, "section": "release", "rank": SECTION_RANK["release"], "context": None,
                            "assets": [grp], "horizon": [[h, h]], "levels": {"kind": "set", "values": [k]},
                            "class": c2, "source": src, "evidence": f"Release grading (R19.3): {strip_md(r[cg])} "
                            f"{strip_md(r[ct])} {seg[:300]}", "monitor": mon(grp, h, k, c2), "row": text,
                            "display": True, "ui_use": ""}
                    if val is not None:
                        rule["validated"] = val
                    if cls == "RECALIBRATE" and c2 == "CALIBRATED":
                        rule["note"] = "C3 repair in CV only; labelled context until a live monitor confirms it"
                    if cls == "RECALIBRATE" and val is False:
                        rule["note"] = "no validated fix; raw (fH) may appear as labelled context, not warning odds"
                    rules.append(rule)
    return rules, unparsed


def d12_cells(classes):
    """classes.json -> {(asset class, horizon h, level): cell} for the D12 cells."""
    out = {}
    for c in (classes or {}).get("cells", {}).values():
        g = D12_GROUP.get(c.get("group"))
        h = c.get("horizon_h")
        if g is None or h is None:
            continue
        out[(g, float(h), round(float(c["level"]), 4))] = c
    return out


def live_rules(classes):
    """A 'live' rule for every cell the D12 monitor has downgraded to CALIBRATED (ranked above every map section)."""
    rules = []
    for (g, h, k), c in sorted(d12_cells(classes).items()):
        if not (c.get("downgraded") and c.get("class") == "CALIBRATED"):
            continue
        rules.append({"id": f"live-d12-{g}-{int(h)}h-{int(round(-100 * k))}", "section": "live",
                      "rank": SECTION_RANK["live"], "context": None, "assets": [g], "horizon": [[h, h]],
                      "levels": {"kind": "set", "values": [k]}, "class": "CALIBRATED", "source": "raw_fH",
                      "evidence": f"D12 live calibration monitor downgraded this cell on {c.get('downgradedAt')} "
                                  f"(monitors {', '.join(c.get('monitors', []))}; default {c.get('defaultClass')})",
                      "monitor": {"id": "D12", "status": "deployed"}, "row": "", "display": True, "ui_use": "",
                      "note": "downgraded by the D12 live monitor: labelled context, not warning odds"})
    return rules


def build(map_text, live_text="", d12_classes=None):
    live_ids = set(re.findall(r"^###\s+(D\d+)\b", live_text, flags=re.M))
    d12_cov = set(d12_cells(d12_classes)) if d12_classes is not None else None
    if not d12_cov:                                  # a pre-A2 classes.json (no horizon_h): keep the board sentence
        d12_cov, d12_classes = None, None
    else:
        live_ids.add("D12")
    rules, unparsed = [], []
    for head, body in split_sections(map_text):
        sec = next((sid for sid, rx in SECTIONS if re.search(rx, head.lower())), None)
        if sec is None:
            continue
        if sec == "release":
            rr, uu = parse_release(body, live_ids, d12_cov)
            if rr:
                rules += rr
                unparsed += uu
                continue
        for ti, (hdr, rows) in enumerate(md_tables(body)):
            ch, cl, ca, cc = _col(hdr, "horizon"), _col(hdr, "level"), _col(hdr, "asset", "group"), _col(hdr, "class")
            cs = _col(hdr, "signal")
            ce = _col(hdr, "evidence", "source")
            cu = _col(hdr, "ui use", "ui")
            for ri, r in enumerate(rows):
                text = " | ".join(r)
                rid = f"{sec}-{ti}-{ri}"
                cls = parse_class(r[cc]) if cc is not None and cc < len(r) else None
                if sec == "oracle":
                    if cs is None or cls is None:
                        unparsed.append({"id": rid, "row": text, "why": "oracle row"})
                        continue
                    sig = strip_md(r[cs])
                    assets = parse_assets(sig) or (["alt"] if "altcoin" in sig.lower() else None)
                    if re.search(r"membrane", sig.lower()):
                        assets = ["alt", "large"]
                    if re.search(r"^same, eth", sig.lower()):
                        assets = ["btc_eth"]
                    src = source_of(text, cls)
                    if src != "imminent_oracle" and not sig.lower().startswith("same"):
                        unparsed.append({"id": rid, "row": text, "why": "oracle row is not a forecast route"})
                        continue
                    rules.append({"id": rid, "section": sec, "rank": SECTION_RANK[sec], "context": "oracle_through",
                                  "assets": assets or ["alt"], "horizon": [[0, 6]], "levels": None, "class": cls,
                                  "source": "imminent_oracle",
                                  "evidence": strip_md(r[ce]) if ce is not None and ce < len(r) else text,
                                  "monitor": monitor_of(text, cls, live_ids), "row": text})
                    continue
                if None in (ch, cl, ca, cc) or max(ch, cl, ca, cc) >= len(r):
                    unparsed.append({"id": rid, "row": text, "why": "missing column"})
                    continue
                hz, lv, asg = parse_horizon(r[ch]), parse_levels(r[cl]), parse_assets(r[ca])
                if hz is None or lv is None or asg is None or cls is None:
                    unparsed.append({"id": rid, "row": text,
                                     "why": f"parse horizon={hz is not None} levels={lv is not None} "
                                            f"assets={asg is not None} class={cls is not None}"})
                    continue
                src = source_of(text, cls)
                rule = {"id": rid, "section": sec, "rank": SECTION_RANK[sec], "context": None, "assets": asg,
                        "horizon": hz, "levels": lv, "class": cls, "source": src,
                        "evidence": strip_md(r[ce]) if ce is not None and ce < len(r) else text,
                        "monitor": monitor_of(text, cls, live_ids), "row": text}
                cells = explicit_cells(rule["evidence"])
                if cells:
                    rule["cells"] = cells
                ui = strip_md(r[cu]) if cu is not None and cu < len(r) else ""
                rule["ui_use"] = ui
                rule["display"] = not re.search(r"research build only|^none\b|^\u2014|^-$|^log only", ui.lower())
                if cls == "RECALIBRATE":
                    rule["validated"] = "no validated fix" not in text.lower()
                if src == "reg2_young":
                    rule["context"] = "young_listing"
                    rule["age_days"] = [85, 364]
                rules.append(rule)
    if d12_classes is not None:
        rules = apply_live(rules, d12_classes)
    return rules, unparsed, sorted(live_ids)


def apply_live(rules, classes):
    """Add the live D12 downgrade rules, but only where the map's own routing gives a warning class (SKILL or
    CALIBRATED-WARN). A downgrade never raises a cell the map already routes lower (e.g. DO NOT SHOW)."""
    import router as RT
    base = RT.Router({"schema": SCHEMA, "version": "pre-live", "map_sha256": "", "rules": rules})
    out = list(rules)
    for lr in live_rules(classes):
        g, (h, _), k = lr["assets"][0], lr["horizon"][0], lr["levels"]["values"][0]
        o = base.route(g, h, k)
        if o["class"] in ("SKILL", "CALIBRATED-WARN"):
            lr["evidence"] += f" || map class was {o['class']} (rule {o['rule_id']})"
            out.insert(0, lr)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", required=True)
    ap.add_argument("--live", default=None)
    ap.add_argument("--datasets", default=None, help="local membrane-datasets checkout (reads the live D12 classes)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.map, "rb") as f:
        raw = f.read()
    live = ""
    if a.live:
        with open(a.live) as f:
            live = f.read()
    d12, d12_meta = None, None
    if a.datasets:
        p = os.path.join(a.datasets, D12_CLASSES_REL)
        with open(p, "rb") as f:
            craw = f.read()
        d12 = json.loads(craw)
        d12_meta = {"path": D12_CLASSES_REL, "sha256": hashlib.sha256(craw).hexdigest(),
                    "lastLedgerDate": d12.get("lastLedgerDate"),
                    "downgraded": sorted(k for k, c in d12.get("cells", {}).items() if c.get("downgraded"))}
    rules, unparsed, live_ids = build(raw.decode("utf-8"), live, d12)
    has_release = any(r["section"] == "release" for r in rules)
    core = {"schema": SCHEMA, "map_sha256": hashlib.sha256(raw).hexdigest(), "release_grading_present": has_release,
            "live_monitors_deployed": live_ids, "d12_classes": d12_meta, "section_rank": SECTION_RANK, "rules": rules, "unparsed": unparsed}
    version = hashlib.sha256(json.dumps(core, sort_keys=True).encode()).hexdigest()[:16]
    doc = {"version": version, "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           **core}
    with open(a.out, "w") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
    print(f"wrote {a.out}: version {version}, {len(rules)} rules, {len(unparsed)} unparsed, "
          f"release grading {'present' if has_release else 'absent'}")


if __name__ == "__main__":
    main()
