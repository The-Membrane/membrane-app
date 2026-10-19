# Publishable reduction of the R16.1 development aggregates: sums per (series, T, level, regime, calendar month)
import sys, glob, os, numpy as np
from datetime import datetime, timezone
src, dst = sys.argv[1], sys.argv[2]
cols = ["n", "sy"] + [f"{p}_{r}" for r in ("a", "f", "fbL", "fH") for p in ("sp", "se", "sl")]
for T in (168, 336, 720):
    out = {c: [] for c in ["series_i", "k", "regime", "month"] + cols}
    names = []
    for si, p in enumerate(sorted(glob.glob(os.path.join(src, "*.npz")))):
        z = np.load(p); names.append(os.path.basename(p)[:-4])
        m = z["T"] == T
        d = z["day"][m].astype("datetime64[D]")
        mon = (d.astype("datetime64[M]").astype(np.int64)).astype(np.int32)   # months since 1970-01
        key = np.stack([z["k"][m].astype(np.int64), z["regime"][m].astype(np.int64) + 1, mon.astype(np.int64)], 1)
        u, inv = np.unique(key, axis=0, return_inverse=True); inv = inv.ravel()
        out["series_i"].append(np.full(len(u), si, np.int16)); out["k"].append(u[:, 0].astype(np.int8))
        out["regime"].append((u[:, 1] - 1).astype(np.int8)); out["month"].append(u[:, 2].astype(np.int16))
        for c in cols:
            out[c].append(np.bincount(inv, weights=z[c][m].astype(float), minlength=len(u)))
    arr = {c: np.concatenate(v) for c, v in out.items()}
    arr["series_names"] = np.array(names)
    arr["levels"] = np.array([-0.02, -0.03, -0.05, -0.07, -0.10, -0.15, -0.20, -0.25, -0.30, -0.40])
    np.savez_compressed(os.path.join(dst, f"dev-month-{T}h.npz"), **arr)
    print(T, len(arr["n"]))
