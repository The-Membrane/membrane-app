#!/usr/bin/env python3
"""Independent retained-output oracle. Requires parent's COMPLETE-result SHA.
Never imports conditional_depth, fits a model, or reads partial result files.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
for name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[name] = '1'
import numpy as np
ROOT = Path(__file__).resolve().parent
REQUEST_SHA = '5484fcfca49d29cf8792a507c66f0ff7ea4e0e545dbf28ba36b11322b27ffc99'
RESULT_SHA = '3424b97d0c22fdf686bf8c1d33ee366c11ae0a735a85f0da17fbf2bab96950e5'
CUT_SHA = '15119684a77a93e62da694ae0392c5c6922d5ecf821984796d61995872499ce4'
SOURCE_SHA = '1bfd3d85f035b4e32e2b1d01edf4ba881595ce1e588615c380c60d96e277881e'
BARRIERS = [-.4, -.2, -.1, -.05, -.02]
QUANTILES = [.01, .05, .1, .25, .5, .75, .9, .95, .99]
YEAR24, YEAR25, END = 1704067200, 1735689600, 1767225600
AXES = ['issued_log_sigma', 'downside_imbalance_D', 'jump_share_D']
FIELDS = ['sid','ts','issue_eligible','fH_fallback','Xbase','Xshape','p_fH','p_fH_valid',
          'label_valid','legacy_label_valid','future_missing_hours','future_log_min','y']


def pin(path):
    path = Path(path)
    with path.open('rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    return dict(path=str(path), size=path.stat().st_size, sha256=digest)


def compare(actual, expected, label, counters):
    if isinstance(expected, dict):
        assert set(actual) == set(expected), (label, set(actual) ^ set(expected))
        for key in expected:
            compare(actual[key], expected[key], label + '.' + key, counters)
    elif isinstance(expected, (str, bool)):
        assert actual == expected, label
    else:
        # Subject serializes undefined floating values as null; oracle uses NaN.
        a = np.asarray(actual, dtype=float)
        e = np.asarray(expected, dtype=float)
        np.testing.assert_allclose(a, e, rtol=5e-12, atol=5e-13, equal_nan=True, err_msg=label)
        counters['numeric_values_compared'] += a.size


def shape(x):
    x = np.asarray(x)
    if x.size == 0:
        return dict(n=0, mean=np.nan, sd=np.nan, quantiles=[np.nan]*9,
                    nonnegative_n=0, ratios=[np.nan, np.nan])
    q = np.quantile(x, QUANTILES, method='linear')
    denominator = q[5] - q[3]
    ratios = [(q[4]-q[j])/denominator if denominator > 0 else np.nan for j in (1,0)]
    return dict(n=x.size, mean=x.sum()/x.size, sd=np.sqrt(np.mean((x-x.mean())**2)),
                quantiles=q, nonnegative_n=np.count_nonzero(x >= 0), ratios=ratios)


def year_blocks(timestamps):
    days = np.asarray(timestamps) // 86400
    years = np.where(np.asarray(timestamps) < YEAR25, 2024, 2025)
    return years*1000000 + days//28


def memberships(d, cuts, sids):
    eligible = d['issue_eligible'] & (d['ts'] >= YEAR24) & (d['ts'] < END)
    effective_log = d['Xbase'][:,0].astype(float).copy()
    effective_log[d['fH_fallback']] = d['Xbase'][d['fH_fallback'],1].astype(float)
    values = [effective_log, d['Xshape'][:,3].astype(float), d['Xshape'][:,0].astype(float)]
    year_masks = {'pooled': np.ones(len(eligible), bool),
                  '2024': d['ts'] < YEAR25, '2025': d['ts'] >= YEAR25}
    views = [('calendar', year, eligible & mask) for year, mask in year_masks.items()]
    views += [('asset', str(sid), eligible & (d['sid'] == sid)) for sid in sids]
    for axis, x in zip(AXES, values):
        threshold = cuts[axis]['cut']
        for state in ['unknown', 'low', 'high']:
            if threshold is None:
                member = np.ones(len(x), bool) if state == 'unknown' else np.zeros(len(x), bool)
            elif state == 'unknown': member = ~np.isfinite(x)
            elif state == 'low': member = np.isfinite(x) & (x <= threshold)
            else: member = np.isfinite(x) & (x > threshold)
            for year, mask in year_masks.items():
                views.append((axis, state+'/'+year, eligible & member & mask))
    return views, effective_log


def standardized(depth, log_sigma, horizon):
    with np.errstate(over='ignore', under='ignore', invalid='ignore', divide='ignore'):
        denominator = np.exp(log_sigma) * (horizon/8760)**.5
        valid = np.isfinite(denominator) & (denominator > 0)
        quotient = depth/denominator
    quotient[~valid] = np.nan
    bad = np.isfinite(depth) & valid & ~np.isfinite(quotient)
    return quotient, valid, bad


def point_view(d, member, effective_z, scale_valid, bad_effective, har_z, har_valid, bad_har):
    p = d['p_fH']; y = d['y'].astype(np.float64); depth = d['future_log_min']
    probability_ok = np.all(np.isfinite(p) & (p >= 0) & (p <= 1), axis=1)
    available = member & probability_ok
    scored = available & d['label_valid']
    unknown = available & ~d['label_valid']
    matched = scored & scale_valid & np.isfinite(effective_z)
    har = scored & har_valid & np.isfinite(har_z)
    n = np.count_nonzero(scored); total = np.count_nonzero(available)
    pr = p[scored]; yy = y[scored]; positives = np.sum(yy, axis=0).astype(int)
    clipped = np.clip(pr, 1e-6, 1-1e-6)
    def avg(x): return np.mean(x, axis=0) if len(x) else np.full(5, np.nan)
    expected_count = pr.sum(axis=0)
    oe = np.full(5, np.nan)
    np.divide(positives, expected_count, out=oe, where=expected_count > 0)
    unknown_n = np.count_nonzero(unknown)
    bounds = [positives/total, (positives+unknown_n)/total] if total else np.full((2,5), np.nan)
    out = dict(issued_n=np.count_nonzero(member), baseline_unavailable_n=np.count_nonzero(member & ~probability_ok),
        scored_n=n, unknown_label_n=unknown_n,
        legacy_label_n=np.count_nonzero(member & d['legacy_label_valid']),
        future_missing_hours=int(d['future_missing_hours'][member].sum()),
        fallback_n=np.count_nonzero(available & d['fH_fallback']), positive_labels=positives,
        mean_probability=avg(pr), all_available_mean_probability=avg(p[available]),
        observed_frequency=positives/n if n else np.full(5,np.nan),
        predicted_minus_observed=avg(pr-yy), observed_over_expected=oe,
        brier=avg((pr-yy)**2), bounded_logloss=avg(-yy*np.log(clipped)-(1-yy)*np.log1p(-clipped)),
        logloss_clipped_n=np.sum(pr != clipped,axis=0), all_available_event_frequency_bounds=bounds,
        distinct_assets=len(set(d['sid'][member].tolist())), distinct_origins=len(set(d['ts'][member].tolist())),
        year_calendar_blocks=len(set(year_blocks(d['ts'][member]).tolist())),
        all_complete_raw_depth=shape(depth[member & d['label_valid']]),
        matched_effective_raw_depth=shape(depth[matched]), matched_effective_standardized_depth=shape(effective_z[matched]),
        matched_har_raw_depth=shape(depth[har]), matched_har_standardized_depth=shape(har_z[har]),
        scale_unavailable_scored_n=np.count_nonzero(scored & ~scale_valid),
        har_scale_unavailable_scored_n=np.count_nonzero(scored & ~har_valid),
        matched_effective_n=np.count_nonzero(matched), matched_effective_predicted_minus_observed=avg(p[matched]-y[matched]),
        nonfinite_effective_quotient_scored_n=np.count_nonzero(scored & bad_effective),
        nonfinite_har_quotient_scored_n=np.count_nonzero(scored & bad_har))
    return out, matched


def draw_weights():
    keys = np.array(sorted(set(year_blocks(np.arange(YEAR24,END,86400)).tolist())), dtype=np.int64)
    weights = np.zeros((500, len(keys)), dtype=np.int64)
    streams = np.random.SeedSequence(2026106000).spawn(2)
    for year, stream in zip([2024,2025], streams):
        columns = np.flatnonzero(keys//1000000 == year)
        rng = np.random.Generator(np.random.PCG64(stream))
        weights[:,columns] = rng.multinomial(len(columns), np.full(len(columns),1/len(columns)), size=500)
    return keys, weights


def summarize_replicates(values, denominators):
    values = np.asarray(values)
    defined = np.isfinite(values)
    count = defined.sum(axis=0)
    sd = np.full(values.shape[1], np.nan)
    intervals = np.full((values.shape[1],2), np.nan)
    for j in range(values.shape[1]):
        x = values[defined[:,j],j]
        if len(x) > 1: sd[j] = np.std(x, ddof=1)
        if len(x): intervals[j] = np.quantile(x,[.05,.95],method='linear')
    return dict(defined_replicates=count, undefined_replicates=500-count,
                sd=sd, quantiles05_95=intervals, weighted_denominators=denominators)


def repeat_row_bootstrap(d, mask, z, keys, weights):
    # Literal duplicated rows and ordinary NumPy quantile/mean; no weighted-CDF helper.
    origins = np.flatnonzero(mask)
    block = np.searchsorted(keys, year_blocks(d['ts'][origins]))
    error = d['p_fH'][origins] - d['y'][origins]
    values = np.full((500,5),np.nan); ratios = np.full((500,2),np.nan)
    denominator = np.zeros(500,dtype=np.int64)
    for b in range(500):
        duplicated = np.repeat(np.arange(len(origins)), weights[b,block])
        denominator[b] = len(duplicated)
        if len(duplicated):
            values[b] = np.mean(error[duplicated],axis=0)
            q = np.quantile(z[duplicated],[.01,.05,.25,.5,.75],method='linear')
            if q[4] > q[2]: ratios[b] = [(q[3]-q[1])/(q[4]-q[2]),(q[3]-q[0])/(q[4]-q[2])]
    return dict(event_error=summarize_replicates(values,denominator),
                shape_ratios=summarize_replicates(ratios,denominator))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approved-complete-result-sha256',required=True)
    args = parser.parse_args()
    start = time.monotonic(); counters = dict(numeric_values_compared=0, point_views=0, baseline_reference_cells=0, bootstrap_views=0)
    result_path=ROOT/'analysis-v2/result.json';request_path=ROOT/'analyze-v2.request.parent.json';cut_path=ROOT/'cuts-v1/result.json'
    assert pin(request_path)['sha256'] == REQUEST_SHA
    assert pin(cut_path)['sha256'] == CUT_SHA
    assert pin(ROOT/'conditional_depth_v2.py')['sha256'] == SOURCE_SHA
    assert args.approved_complete_result_sha256 == RESULT_SHA
    assert pin(result_path)['sha256'] == RESULT_SHA
    request=json.loads(request_path.read_text());result=json.loads(result_path.read_text());cuts=json.loads(cut_path.read_text())
    assert result['complete'] and result['phase']=='analyze' and cuts['complete']
    assert result['input_pins']==request['inputs'] and result['request_pins']==request['pins']
    assert result['cuts_pin']==pin(cut_path)
    for expected in list(request['pins'].values())+list(request['inputs'].values())+request['closure_pins']:
        assert pin(expected['path'])==expected,expected['path']
    assert pin(request['execution_source_pin']['path'])==request['execution_source_pin']
    assert pin(request['execution_tests_pin']['path'])==request['execution_tests_pin']
    reference=json.loads(Path(request['pins']['reference_result']['path']).read_text())
    keys,weights=draw_weights()
    assert result['resampling']['keys']==keys.tolist()
    assert result['resampling']['weights_sha256']==hashlib.sha256(weights.tobytes()).hexdigest()
    selections=[];view_membership_digests={};shape_boundaries=[]
    for horizon in [6,12,24,72,168]:
        with np.load(request['inputs'][str(horizon)]['path'],allow_pickle=False) as archive:
            d={field:archive[field] for field in FIELDS}
        labels=d['label_valid'];depth=d['future_log_min'];p=d['p_fH']
        assert np.array_equal(np.isfinite(depth),labels)
        assert np.array_equal(d['y'][labels],(depth[labels,None]<=np.log1p(BARRIERS)).astype(np.uint8))
        assert np.array_equal(d['p_fH_valid'],np.all(np.isfinite(p)&(p>=0)&(p<=1),axis=1))
        views,log_sigma=memberships(d,cuts['horizons'][str(horizon)],request['sids'])
        assert len(views)==54 and len(result['horizons'][str(horizon)])==54
        ez,ev,eb=standardized(depth,log_sigma,horizon)
        hz,hv,hb=standardized(depth,d['Xbase'][:,0].astype(float),horizon)
        ref={}
        for h in reference['horizons']:
            if h['horizon_hours']==horizon:
                ref={(v['group_type'],v['group'],float(v['barrier'])):v for v in h['scores'] if v['prediction']=='baseline_raw'}
        for (kind,name,member),actual in zip(views,result['horizons'][str(horizon)]):
            assert actual['view_type']==kind and actual['view']==name
            expected,matched=point_view(d,member,ez,ev,eb,hz,hv,hb)
            actual_point={k:v for k,v in actual.items() if k not in ['view_type','view','matched_effective_sensitivity']}
            compare(actual_point,expected,f'H{horizon}:{kind}:{name}',counters);counters['point_views']+=1
            view_membership_digests[f'{horizon}:{kind}:{name}']=hashlib.sha256(np.flatnonzero(member).astype('<i8').tobytes()).hexdigest()
            if kind in ['calendar','asset']:
                group_type='all' if name=='pooled' else ('year' if kind=='calendar' else 'asset')
                group='all' if group_type=='all' else name
                for j,barrier in enumerate(BARRIERS):
                    original=ref.pop((group_type,group,barrier))
                    assert expected['scored_n']==original['n'] and expected['positive_labels'][j]==original['events']
                    if original['n']:
                        for val,old in [(expected['brier'][j],original['brier']),
                                        (expected['bounded_logloss'][j],original['bounded_logloss']),
                                        (expected['mean_probability'][j],original['sum_probability']/original['n'])]:
                            np.testing.assert_allclose(val,old,rtol=2e-13,atol=2e-12)
                    counters['baseline_reference_cells']+=1
            chosen=kind in AXES and (horizon==24 or name.endswith('/pooled'))
            if chosen:
                oracle=repeat_row_bootstrap(d,matched,ez[matched],keys,weights)
                compare(actual['matched_effective_sensitivity'],oracle,f'bootstrap H{horizon}:{kind}:{name}',counters)
                counters['bootstrap_views']+=1;selections.append(dict(horizon=horizon,axis=kind,state_year=name,matched_rows=int(matched.sum())))
        assert not ref
        shape_boundaries.append(dict(horizon=horizon,complete_rows=int(labels.sum()),fallback_issued_rows=int(np.sum(d['fH_fallback']&d['issue_eligible'])),effective_valid_rows=int(ev.sum()),har_valid_rows=int(hv.sum())))
        del d
    assert counters['point_views']==270 and counters['baseline_reference_cells']==675 and counters['bootstrap_views']==63
    report={'status':'PASS','scope':'Independent retained-output audit, no subject analysis-helper imports or model fits. NPZ access follows parent complete-result authorization. Every point view/cell reconstructed; fixed63 bootstrap views checked with literal repeated rows for500 draws.',
            'pins':{'request':pin(request_path),'cuts':pin(cut_path),'result':pin(result_path),'subject_source':pin(ROOT/'conditional_depth_v2.py'),'verifier':pin(Path(__file__).resolve())},
            'checks':counters,'bootstrap_selected_views':selections,'membership_digest_sha256':hashlib.sha256(json.dumps(view_membership_digests,sort_keys=True).encode()).hexdigest(),
            'scale_boundary_counts':shape_boundaries,'uncertainty_scope':'Year-stratified global28-day calendar-block conditional resampling sensitivity. No latent truth, CI coverage validation, causal allocation, unseen-data claim or independent sampled-market claim.',
            'limitations':['Bootstrap oracle checks63 prespecified views, not all270. Point metrics/depth quantiles/ratios/support/bounds checked for all270.','Original675 baseline cells reconcile counts/events/Brier/bounded-logloss/mean-probability; this does not independently replay historical raw-fH forecasts.','Float32 issued-feature scale is retained; no reconstruction of float64 historical sigma or renewed untouched validation.'],
            'elapsed_seconds':time.monotonic()-start}
    (ROOT/'independent-result-review.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    print(json.dumps({'status':'PASS','checks':counters,'elapsed_seconds':report['elapsed_seconds'],'report_pin':pin(ROOT/'independent-result-review.json')}))


if __name__=='__main__': main()
