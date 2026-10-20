"""CODEX CONTINUATION: retained dependency projection of immutable r16_dev.task.

No GJR/EG/MS fits, discarded scale models, GB/NN, Monte Carlo or random-number
stream is needed by the retained shallow fields. This is NOT certified equivalent
until frozen real-series byte-parity gates pass. D.task and its globals are never
patched by this module. BTC initialization remains the caller's original D.init_btc.
"""
from __future__ import annotations
import time
import numpy as np
import r16_dev as D
from r16_nn import STATIC

HORIZONS = (1, 3, 12)
RETAINED = ('ts', 'y', 'fH', 'f') + tuple(STATIC)


def features(ser, spec):
    """Exact F0 operations from D.task, omitting unused dow/hour/age fields."""
    n1 = len(ser.close) + 1
    volume = D.load_volume(spec)
    with np.errstate(invalid='ignore', divide='ignore'):
        har = np.log(D.A6.har_of(ser))
        lc = np.log(ser.spot)
        hi = np.concatenate([[np.nan], ser.high])
        lo = np.concatenate([[np.nan], ser.low])
    def lagret(length):
        out = np.full(n1, np.nan)
        out[length:] = lc[length:] - lc[:-length]
        return out
    def rollmax(x, window):
        from numpy.lib.stride_tricks import sliding_window_view
        out = np.full(n1, np.nan)
        if len(x) > window:
            value = sliding_window_view(np.where(np.isfinite(x), x, -np.inf), window).max(axis=1)
            out[window:] = value[:n1-window]
        out[~np.isfinite(out)] = np.nan
        return out
    def rollmin(x, window):
        return -rollmax(-x, window)
    hmax720 = rollmax(hi[1:], 720)
    hmax24, lmin24 = rollmax(hi[1:], 24), rollmin(lo[1:], 24)
    out = dict(dm=har[:, 0]-har[:, 2], wm=har[:, 1]-har[:, 2],
               r24=lagret(24), r168=lagret(168), r720=lagret(720))
    with np.errstate(invalid='ignore', divide='ignore'):
        out['dd720'] = lc - np.log(hmax720)
        out['rng24'] = np.log(hmax24/lmin24)
        if volume is not None and len(volume) == len(ser.close):
            v24 = D.roll_mean(volume, 24, ser.start_i)
            v720 = D.roll_mean(volume, 720, ser.start_i)
            out['lvol'] = np.log(v24/v720)
        else:
            out['lvol'] = np.full(n1, np.nan)
    for key in out:
        out[key][~np.isfinite(out[key])] = np.nan
    timestamps = ser.base_ts+D.STEP*np.arange(n1)
    out['btc_r24'], out['btc_dm'] = D.btc_lookup(timestamps)
    return out, timestamps


def task(spec):
    """Only retained fields; fits/fallback metadata explicitly excludes omitted work.

    Identical baseline fallback precedes the common finite mask. Q2 and tail
    censoring occurs after per-fold concatenation, preserving original row order.
    """
    started = time.time()
    ser, folds, caps = D.R12.load_series(spec)
    f0, timestamps = features(ser, spec)
    n1 = len(ser.close)+1
    fold_q = [f for f in folds if f['qs_i'] < n1]
    rows, fallback = {}, {}
    for horizon in HORIZONS:
        prep = D.A6.Prep6(ser, horizon, with_fbL=False)
        p, n = prep.P, prep.n
        loglevels = np.log1p(np.array(D.LV[horizon]))
        origins = np.arange(n)
        out = {key:[] for key in RETAINED+('q2', 'tail')}
        counts = dict(f=0, fH=0)
        for fold in fold_q:
            qs, qe = fold['qs_i'], min(fold['qe_i'], n)
            limit = qs-horizon
            if limit <= 0:
                continue
            train = origins <= limit
            te = np.arange(qs, qe)
            te = te[p.lab_ok[te] & (timestamps[te]+horizon*D.STEP <= caps['full']) &
                    (timestamps[te] % (D.ORIGIN_STEP[horizon]*D.STEP) == 0)]
            te = te[np.isfinite(p.depth[te])]
            if len(te) == 0:
                continue
            coefficient, _ = prep.har_coef(qs)
            sigma_h = prep.sigma_H(coefficient)
            z_h, valid_h = prep.z_of(sigma_h)
            with np.errstate(invalid='ignore', divide='ignore'):
                threshold_h = loglevels[None, :]/(sigma_h[te][:, None]*p.scale)
                threshold_f = loglevels[None, :]/(ser.sigma[te][:, None]*p.scale)
            f = D.M2.fhs_predict(p.z[1.0][p.valid[1.0] & train], threshold_f)
            fh = D.M2.fhs_predict(z_h[valid_h & train], threshold_h)
            bad_h = ~np.all(np.isfinite(fh), axis=1)
            fh[bad_h] = f[bad_h]
            keep = np.all(np.isfinite(fh), axis=1) & np.all(np.isfinite(f), axis=1)
            te, fh, f = te[keep], fh[keep], f[keep]
            if len(te) == 0:
                continue
            for key, value in (('fH', fh), ('f', f)):
                value = np.asarray(value, float)
                bad = ~np.all(np.isfinite(value), axis=1)
                counts[key] += int(bad.sum())
                value[bad] = fh[bad]
                out[key].append(np.minimum.accumulate(value, axis=1).astype(np.float32))
            ts = timestamps[te]
            out['ts'].append(ts)
            out['y'].append((p.depth[te][:, None] <= loglevels[None, :]).astype(np.int8))
            out['q2'].append((ts+horizon*D.STEP > D.R12.Q2_START) & (ts < D.R12.Q2_END))
            out['tail'].append(ts+horizon*D.STEP > caps['primary'])
            for key in STATIC:
                if key == 'lsH':
                    value = np.log(sigma_h[te])
                elif key == 'lsf':
                    value = np.log(ser.sigma[te])
                else:
                    value = f0[key][te]
                out[key].append(np.asarray(value, np.float32))
        if out['ts']:
            result = {key:np.concatenate(parts) for key, parts in out.items()}
            mask = ~result['q2'] & ~result['tail']
            rows[horizon] = {key:value[mask] for key,value in result.items() if key not in ('q2','tail')}
        fallback[horizon] = counts
        D.A6._clear(ser) if hasattr(D.A6, '_clear') else None
    return dict(key=spec['key'], rows=rows, fallback=fallback,
                fits={'status':'unretained GJR/EG/MS fits intentionally not executed'},
                sec=time.time()-started)
