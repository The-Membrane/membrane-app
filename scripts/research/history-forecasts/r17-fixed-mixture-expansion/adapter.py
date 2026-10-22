"""Source-qualified fixed O111 C expansion seams; NO empirical CLI or admission.

Public wiring imports exact private science from caller-pinned source paths.
It neither contains the original private cohort fingerprint nor changes science.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sys
import types
import numpy as np

HORIZONS = (6, 12, 24, 72, 168)
SOURCE_SHA = {
    'producer': '6086f3369dc4264b4e06987163a1389c90a19ed08b51db9213c892ec63928793',
    'runner': '7626b283a0e6294dc0542821dbe0fa84fcefc1d17bb2590fb605c575d1c038a3',
    'core': 'c0e4652717006aaf8b3978840fab9c498e4cdfa44fa05de703a8c6c2e4e68d77',
    'mixture': 'f3b62a30db72842947d80b864c11b4976baf919d302831476826be5f54c86ee1',
    'inverse': '9f651546beb28088e4f14bf2830c47e44002332edce2e65b0b0d6f0c168294c3',
    'reference_runner': '6ebfaccf5c5d496c6c9af3e100fc777fb6f40b48f8249eba154f72a3a5c1b3d0',
    'census_source': 'aa101dba71b25bb892854e45a9fdcdfe35bbad8ac43ee2c4083b8b143b029194',
    'joint_driver': 'e2375fb5836ab5f000f785624d94450e6ba931f4993e494ae60df91f11597f3b',
    'joint_kernel': '6f3eb9d56f17a06cf9aa517fce6f58d2b79ed19f167ac81ae748bbcae3682e5a',
    'reporter': 'd363625e463172bc10c32e289cd93be22bb29a050287f8fc7401b1efe2997097',
}


def need(ok, message):
    if not ok: raise ValueError(message)


def pin(path):
    path = Path(path)
    need(path.is_absolute() and str(path.resolve()) == str(path) and not path.is_symlink(), 'canonical source path')
    b = path.read_bytes()
    return dict(path=str(path), size=len(b), sha256=hashlib.sha256(b).hexdigest())


def load_science(request):
    """Source-only qualification, not an empirical run interface. DRAFT refuses first.

    All ten sources authenticate BEFORE the first exec. No stale pycache is used.
    The only implemented ready status is synthetic source qualification.
    """
    need(request.get('status', 'DRAFT') == 'READY_SYNTHETIC_SOURCE_QUALIFICATION', 'DRAFT/no empirical admission')
    need(request.get('schema') == 'q26-fixed-mixture-expansion-source-v1', 'source qualification schema')
    pins = request['science']; need(set(pins) == set(SOURCE_SHA), 'complete ten-source closure')
    raw = {}
    for role, expected_sha in SOURCE_SHA.items():
        record = pins[role]
        need(set(record) == {'path', 'size', 'sha256'} and record['sha256'] == expected_sha, 'accepted science identity')
        need(pin(record['path']) == record, 'science pin mismatch')
        raw[role] = Path(record['path']).read_bytes()
        need(hashlib.sha256(raw[role]).hexdigest() == expected_sha, 'science changed before compile')
    modules = {}; aliases = {k: sys.modules.get(k) for k in ('kernel', 'driver')}
    try:
        for role in ('joint_kernel', 'joint_driver', 'reporter', 'producer', 'core', 'inverse',
                     'reference_runner', 'census_source', 'mixture', 'runner'):
            name = '_q26_fixed_expansion_' + role
            module = types.ModuleType(name); module.__file__ = pins[role]['path']; sys.modules[name] = module
            exec(compile(raw[role], module.__file__, 'exec'), module.__dict__)
            modules[role] = module
            if role == 'joint_kernel': sys.modules['kernel'] = module
            if role == 'joint_driver': sys.modules['driver'] = module
    finally:
        for key, previous in aliases.items():
            if previous is None: sys.modules.pop(key, None)
            else: sys.modules[key] = previous
    need(modules['runner'].CUT == 0.0181248988956213, 'original fixed D cut')
    return types.SimpleNamespace(**modules, pins=pins)


def validate_universe(science, mapping, raw_keys, original_selection):
    need(len(mapping) == len(raw_keys) == 277 and mapping == [[i, k] for i, k in enumerate(raw_keys)],
         'exact canonical277 enumeration')
    need(len(set(raw_keys)) == 277 and len(original_selection) == 24, 'canonical and original selection cardinality')
    need(original_selection == [list(v) for v in science.producer.choose(raw_keys)], 'original deterministic selection')
    need(len({s for s, k in original_selection}) == 24 and
         all(mapping[s] == [s, k] for s, k in original_selection), 'original24 identity regression map')


def stage_series(science, ser, sid, features, shape, A6, M2, checkpoint=lambda: None):
    """Faithful upstream baseline preparation. HAR fits here are explicitly separate.

    Caller must qualify raw/runtime/legacy closure before supplying these objects.
    This does not call the old builder.authenticate or weaken its selected24 guard.
    """
    arrays, metadata = {}, {}
    for h in HORIZONS:
        checkpoint()
        arrays[h], metadata[h] = science.producer.build_horizon(ser, h, sid, features, shape, A6, M2, checkpoint)
    return arrays, metadata


def attach_joint(science, archives):
    """Map original five-way prediction-only J back onto the FULL H24 saved grid."""
    need(set(archives) == set(HORIZONS), 'exact five-horizon closure')
    # Preserve the original schemas and ledger semantics when an empty horizon
    # makes the full intersection empty. Original assemble's empty membership
    # arrays have float dtype and cannot be inverted; no predictions exist here.
    if any(len(archives[h]['sid']) == 0 for h in HORIZONS):
        driver = science.joint_driver
        keys = {h: driver.validate_archive(archives[h]) for h in HORIZONS}
        maps = {h: {key: i for i, key in enumerate(keys[h])} for h in HORIZONS}
        for hi, h in enumerate(HORIZONS):
            for longer in HORIZONS[hi+1:]:
                for key in maps[h].keys() & maps[longer].keys():
                    need(not archives[longer]['label_valid'][maps[longer][key]] or
                         archives[h]['label_valid'][maps[h][key]], 'complete longer path contradicts incomplete prefix')
        saved = {k: v.copy() for k, v in archives[24].items()}
        need(saved['Xbase'].dtype == np.float32 and saved['Xbase'].shape == (len(saved['sid']), 12), 'H24 feature schema')
        saved['on_J'] = np.zeros(len(saved['sid']), bool)
        ledger = {}
        for h, data in archives.items():
            issue, valid, known = data['issue_eligible'], data['p_fH_valid'], data['label_valid']
            scopes = {}
            calendar = (data['ts'] >= driver.EVAL_START) & (data['ts'] < driver.EVAL_END)
            for scope, base in (('all_history', np.ones(len(issue), bool)), ('evaluation', calendar)):
                masks = dict(rows=base, issued=base & issue, baseline_unavailable=base & issue & ~valid,
                    available=base & issue & valid, label_unknown=base & issue & ~known,
                    available_label_unknown=base & issue & valid & ~known, scored=base & issue & valid & known,
                    not_in_common=base, issued_outside_J=base & issue, scored_outside_J=base & issue & valid & known)
                scopes[scope] = {name: driver._summary(data['sid'], data['ts'], mask) for name, mask in masks.items()}
            ledger[str(h)] = scopes
        summary = driver._summary(np.empty(0, np.int32), np.empty(0, np.int64), np.empty(0, bool))
        joint_ledger = {k: summary.copy() for k in ('common', 'available', 'complete', 'J', 'L', 'J_unknown')}
        return saved, dict(J_n=0, L24_n=0, L5_n=0, original_joint_ledger=joint_ledger, per_horizon=ledger)
    joint = science.joint_driver.assemble(archives)
    keys = list(zip(map(int, joint['sid']), map(int, joint['ts'])))
    jkeys = {keys[i] for i in np.flatnonzero(joint['J'])}
    h24 = {k: v.copy() for k, v in archives[24].items()}
    saved_keys = list(zip(map(int, h24['sid']), map(int, h24['ts'])))
    need(len(set(saved_keys)) == len(saved_keys), 'unique H24 source keys')
    h24['on_J'] = np.array([key in jkeys for key in saved_keys], bool)
    need(int(h24['on_J'].sum()) == len(jkeys), 'full J maps into H24')
    # L5 is a diagnostic only. Never assert J=L5 or use L5 for H24 scoring.
    l24 = h24['on_J'] & h24['label_valid']
    return h24, dict(J_n=len(jkeys), L24_n=int(l24.sum()), L5_n=int(joint['L'].sum()),
                     original_joint_ledger=joint['joint_ledger'], per_horizon=joint['per_horizon'])


def require_exact_regression(fresh, retained):
    """Original24 controls: exact dtypes, shapes and bytes, not approximate parity."""
    need(set(fresh) == set(retained), 'original24 field inventory')
    for key, value in fresh.items():
        old = retained[key]
        need(value.dtype == old.dtype and value.shape == old.shape and value.tobytes() == old.tobytes(),
             'original24 byte regression: ' + key)


@dataclass
class SeriesResult:
    saved: dict
    predictions: dict
    quarters: list
    persistence: list
    joint_ledger: dict
    status: str


def evaluate_series(science, A6, M2, D, ser, sid, metadata, saved, ledger, root, checkpoint=lambda: None):
    """Exact original trial_series/predict_quarter/persistence, with one empty edge.

    Any original support failure propagates, refusing the whole C comparison.
    In particular unknown-only nonfallback J still invokes original strict support.
    """
    root = Path(root); need(root.is_absolute() and str(root.resolve()) == str(root) and not root.is_symlink(), 'canonical private root')
    need(root.is_dir() and root.stat().st_mode & 0o777 == 0o700, 'private0700 persistence root')
    need(metadata['sid'] == sid and metadata['horizon'] == 24 and
         metadata['counts']['rows'] == len(saved['sid']) and np.all(saved['sid'] == sid), 'series source closure')
    quarters = metadata['quarters']; cuts = [q['quarter_cutoff'] for q in quarters]
    need(cuts == sorted(set(cuts)) and set(saved['quarter_cutoff'].tolist()) == set(cuts), 'all source quarter metadata retained')
    evaluation = [q for q in quarters if science.runner.EVAL0 <= q['quarter_cutoff'] < science.runner.END]
    if not evaluation:
        need(not saved['on_J'].any(), 'no evaluation quarters cannot have J')
        empty = dict(sid=np.empty(0, np.int32), ts=np.empty(0, np.int64),
                     **{a: np.empty((0, 5), np.float64) for a in science.runner.ARMS})
        return SeriesResult(saved, empty, [], [], ledger, 'NO_EVALUATION_QUARTERS_ZERO_J')
    persisted = []
    def persist(s, q, state, support):
        result = science.runner.persist_quarter(root, s, q, state, support)
        persisted.extend([pin(root/f'sid-{s}-q-{q}.private.npz'), pin(root/f'sid-{s}-q-{q}.private.json')])
        return result
    predictions, records = science.runner.trial_series(
        science.reference_runner, science.core, science.census_source, science.mixture, science.inverse,
        A6, M2, D, science.producer, ser, sid, metadata, saved, science.runner.CUT, persist, checkpoint)
    need(len(records) == len(evaluation) and len(persisted) == 2*len(evaluation), 'all calendar quarters persisted')
    return SeriesResult(saved, predictions, records, persisted, ledger, 'CALENDAR_PARITY_AND_PERSISTENCE_COMPLETE')


def report(science, series, cuts, mapping):
    """Original E.views/metric/calibration/paired, generalized to L24 and all J.

    Every private quarter readback and final hash must precede loss calculations.
    Existing paired helper supplies BOTH proper-loss binary endpoint bounds.
    """
    need(len(mapping) == 277 and mapping == [[i, row[1]] for i, row in enumerate(mapping)] and len({row[1] for row in mapping}) == 277, 'exact canonical277 report geometry')
    need(len(series) == len(mapping) and [int(s.saved['sid'][0]) if len(s.saved['sid']) else mapping[i][0]
         for i, s in enumerate(series)] == [v[0] for v in mapping], 'complete canonical report sequence')
    need(cuts['downside_imbalance_D']['cut'] == science.runner.CUT, 'original frozen reporting D cut')
    for result in series:
        restored = {k: [] for k in result.predictions}
        need(len(result.persistence) == 2*len(result.quarters), 'private quarter pair inventory')
        for index, quarter in enumerate(result.quarters):
            npin, jpin = result.persistence[2*index:2*index+2]
            for record in (npin, jpin):
                need(pin(record['path']) == record, 'private quarter changed before reporting')
            receipt = json.loads(Path(jpin['path']).read_bytes())
            need(receipt['sid'] == quarter['sid'] and receipt['quarter_cutoff'] == quarter['quarter_cutoff'] and
                 receipt['file'] == Path(npin['path']).name and receipt['size'] == npin['size'] and
                 receipt['sha256'] == npin['sha256'] and receipt['rows'] == quarter['J_n'], 'private receipt binding')
            with np.load(npin['path'], allow_pickle=False) as archive:
                need(set(archive.files) == set(restored) | {'on_J', 'candidate_prediction_valid', 'fH_fallback', 'issuance_state'}, 'persisted candidate field inventory')
                for flag in ('on_J', 'candidate_prediction_valid'):
                    need(archive[flag].dtype == bool and archive[flag].shape == (receipt['rows'],) and archive[flag].all(), 'private J prediction flags')
                for key in restored: restored[key].append(archive[key])
        for key, live in result.predictions.items():
            stored = np.concatenate(restored[key]) if restored[key] else live[:0]
            need(stored.dtype == live.dtype and stored.shape == live.shape and stored.tobytes() == live.tobytes(), 'persisted candidate byte binding')
    fields = ('sid', 'ts', 'y', 'label_valid', 'issue_eligible', 'p_fH_valid', 'fH_fallback', 'p_fH', 'Xbase', 'Xshape', 'on_J')
    saved = {k: np.concatenate([s.saved[k] for s in series]) for k in fields}
    # Align candidate J keys explicitly instead of assuming source or quarter order.
    predictions = {}; expected = list(zip(map(int, saved['sid'][saved['on_J']]), map(int, saved['ts'][saved['on_J']])))
    for arm in science.runner.ARMS:
        keyed = {}
        for result in series:
            p = result.predictions
            for i, key in enumerate(zip(map(int, p['sid']), map(int, p['ts']))):
                need(key not in keyed, 'duplicate persisted prediction key'); keyed[key] = p[arm][i]
        need(set(keyed) == set(expected), 'all and only J candidate keys')
        predictions[arm] = np.array([keyed[k] for k in expected], dtype=np.float64).reshape(-1, 5)
    need(np.array_equal(predictions['A_raw_fH'], saved['p_fH'][saved['on_J']]), 'unchanged full-J A')
    J = saved['on_J']; known = saved['label_valid'][J]; y = saved['y'][J].astype(float)
    views = science.reporter.views(saved, cuts, [v[0] for v in mapping]); need(len(views) == 30+len(mapping), 'all dynamic views')
    rows = []
    for kind, name, mask in views:
        take = mask[J]; observed = take & known
        arms = {a: science.reporter.metric(p[observed], y[observed]) for a, p in predictions.items()}
        if kind == 'calendar':
            for a in arms: arms[a]['calibration_bins'] = science.reporter.calibration(predictions[a][observed], y[observed])
        paired = {left+'_minus_'+right: science.reporter.paired(predictions[left][take], predictions[right][take],
                  y[take], known[take]) for left, right in science.runner.PAIRS}
        rows.append(dict(view_type=kind, view=name, issued_n=int(mask.sum()), forecast_J_n=int(take.sum()),
                         scored_L24_n=int(observed.sum()), J_unknown_label_n=int((take & ~known).sum()),
                         issued_outside_J_n=int(mask.sum())-int(take.sum()),
                         source_baseline_unavailable_n=int(np.sum(mask & ~saved['p_fH_valid'])),
                         source_available_unknown_label_n=int(np.sum(mask & saved['p_fH_valid'] & ~saved['label_valid'])),
                         source_fallback_n=int(np.sum(mask & saved['p_fH_valid'] & saved['fH_fallback'])), arms=arms, paired=paired))
    calendars = {r['view']: r for r in rows if r['view_type'] == 'calendar'}
    primary = all(calendars[yr]['arms']['C_conditional'][loss][2] is not None and
                  calendars[yr]['arms']['C_conditional'][loss][2] < calendars[yr]['arms']['A_raw_fH'][loss][2]
                  for yr in ('2024', '2025') for loss in ('brier', 'bounded_logloss'))
    return dict(schema='q26-full277-fixed-C-report-v1', label='CODEX CONTINUATION', calculations_complete=True,
                primary='H24/-10%; observed both proper losses both years', primary_candidate_passed=primary,
                original24_regression_status='NOT_ESTABLISHED_BY_THIS_COMPONENT',
                empirical_admission_status='NOT_ADMITTED', source_synthetic_component=True,
                J_n=int(J.sum()), L24_n=int(known.sum()), L5_n=sum(s.joint_ledger['L5_n'] for s in series),
                views=rows, series_ledger=[dict(sid=i, source_rows=len(s.saved['sid']), evaluation_quarters=len(s.quarters), status=s.status, **s.joint_ledger) for i, s in enumerate(series)],
                quarter_records=[q for s in series for q in s.quarters], unseen_validation=False,
                bounds='Original binary endpoint bounds over all J. Not confidence intervals, MAR or imputed-zero scores.',
                qualification='Source/synthetic seams only. Full277 metadata/raw/runtime admission, original24 regression and independent checking remain required.')
