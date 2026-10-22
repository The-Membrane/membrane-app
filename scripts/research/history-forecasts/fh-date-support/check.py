"""Independent saved verifier for NEW fixed-pilot date-support reconstruction.

Uses the original pinned arithmetic, but separate loading, cohort construction and
scalar reductions. This cannot establish identity with unavailable bridge bytes.
No producer module is imported. Private arrays are read only after pin closure.
"""
import argparse
import contextlib
import datetime as dt
import hashlib
import importlib
import importlib.metadata
import importlib.util
import json
import os
import re
from pathlib import Path
import sys
import types
import zipfile
import numpy as np

FIELDS = {'main_index': '<i8', 'main_label_end': '<i8', 'main_state': 'i1',
          'D_original': '<f4', 'unknown_partition': 'i1'}
MODE = 'NEW_RECONSTRUCTION_FIXED_PILOT_DATE_SUPPORT'
REQUIRED_ROLES = {'ancestor_request', 'trial_request', 'staging_request', 'fit_scope',
                  'raw_authority', 'manifest', 'cuts', 'archive', 'census',
                  'staging_producer', 'audit', 'checker', 'private_lineage'}


def require(ok, why):
    if not ok:
        raise ValueError(why)


def no_links(path):
    p = Path(path)
    require(p.is_absolute(), 'absolute path required')
    require(not any(x.is_symlink() for x in (p, *p.parents)), 'symlink path refused')
    return p


def pin_bytes(pin):
    require(set(pin) == {'path', 'size', 'sha256'}, 'exact pin schema')
    p = no_links(pin['path'])
    require(p.is_file() and type(pin['size']) is int and pin['size'] >= 0, 'regular pinned file')
    digest = hashlib.sha256()
    total = 0
    with p.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            total += len(chunk)
            digest.update(chunk)
    require(total == pin['size'] and digest.hexdigest() == pin['sha256'], 'pin mismatch')
    return p


def read_json(path):
    # Reject duplicate object keys rather than silently choosing one authority.
    def obj(pairs):
        out = {}
        for key, value in pairs:
            require(key not in out, 'duplicate JSON key')
            out[key] = value
        return out
    return json.loads(Path(path).read_text(), object_pairs_hook=obj,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))


def predecessor(q):
    require(type(q) is int, 'integer quarter')
    t = dt.datetime.fromtimestamp(q, dt.timezone.utc)
    require(t.month in (1, 4, 7, 10) and t.day == 1 and
            (t.hour, t.minute, t.second, t.microsecond) == (0, 0, 0, 0), 'UTC quarter boundary')
    y, m = (t.year - 1, 10) if t.month == 1 else (t.year, t.month - 3)
    return int(dt.datetime(y, m, 1, tzinfo=dt.timezone.utc).timestamp())


def runtime_check(runtime):
    require(runtime['python_path'] == sys.executable, 'exact executable argv path')
    require(Path(sys.executable).resolve() == Path(runtime['executable']['path']), 'resolved executable identity')
    pin_bytes(runtime['executable'])
    require(sys.version.split()[0] == runtime['python_version'], 'Python version')
    require(set(runtime['packages']) == {'numpy', 'scipy', 'numba', 'llvmlite'}, 'runtime packages')
    for package, version in runtime['packages'].items():
        require(importlib.metadata.version(package) == version, 'package version')
    expected = {'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1',
                'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONOPTIMIZE': '0'}
    require(runtime['env'] == expected and all(os.environ.get(k) == v for k, v in expected.items()), 'runtime environment')
    require(not sys.flags.optimize and sys.dont_write_bytecode, 'interpreter flags')


def same_content(a, b):
    return a['sha256'] == b['sha256'] and a['size'] == b['size']


def authenticate(plan, external_sha):
    require(set(plan) == {'schema', 'parent_admitted', 'mode', 'pilot', 'roles', 'files',
                          'legacy_sources', 'runtime', 'out', 'source_commit', 'row_capacity'}, 'exact plan schema')
    require(type(plan['source_commit']) is str and re.fullmatch('[0-9a-f]{40}', plan['source_commit']), 'new source commit identity')
    require(plan['schema'] == 'q26-fh-date-support-plan-v1' and plan['parent_admitted'] is True,
            'parent admitted plan required')
    require(plan['mode'] == MODE and plan['row_capacity'] == 200000, 'fixed reconstruction contract')
    roles = plan['roles']
    require(REQUIRED_ROLES <= set(roles), 'role closure')
    files = plan['files']
    require(len({p['path'] for p in files}) == len(files), 'unique file pins')
    for p in files:
        pin_bytes(p)
    bypath = {p['path']: p for p in files}
    require(all(bypath.get(p['path']) == p for p in roles.values()), 'roles bound to files')
    require(Path(roles['checker']['path']) == Path(__file__).absolute(), 'checker source identity')
    for p in plan['legacy_sources'].values():
        require(bypath.get(p['path']) == p, 'legacy closure membership')
    require(bypath.get(plan['runtime']['executable']['path']) == plan['runtime']['executable'], 'executable file closure')
    runtime_check(plan['runtime'])
    pilot = plan['pilot']
    require(type(pilot['sid']) is int and type(pilot['key']) is str and
            predecessor(pilot['current_cutoff']) == pilot['previous_cutoff'], 'fixed pilot predecessor')
    lineage = read_json(roles['private_lineage']['path'])['private_pilot']
    require(lineage['sid'] == pilot['sid'] and lineage['key'] == pilot['key'] and
            lineage['current_cutoff'] == pilot['current_cutoff'] and
            lineage['predecessor_cutoff'] == pilot['previous_cutoff'], 'private pilot lineage')
    stage = read_json(roles['staging_request']['path'])
    fit = read_json(roles['fit_scope']['path'])
    raw = read_json(roles['raw_authority']['path'])['base_scope']
    manifest = read_json(roles['manifest']['path'])
    cuts = read_json(roles['cuts']['path'])
    require(stage['pins']['fit_scope'] == roles['fit_scope'] and
            stage['pins']['raw_scope'] == roles['raw_authority'] and
            stage['pins']['helper'] == roles['staging_producer'], 'staging ancestry')
    require(stage['schema'] == 'codex-r17-staging-request-v1' and stage['status'] == 'READY_PARENT_REVIEWED', 'original staging identity')
    require(manifest['schema'] == 'codex-r17-staged-inputs-v1', 'original manifest schema')
    require(manifest['complete'] is True and manifest['canonical_mapping'] == stage['selected'] and
            manifest['canonical_mapping'][0] == [pilot['sid'], pilot['key']], 'original first-pilot selector')
    require(roles['archive'] in manifest['outputs'] and manifest['request_protocol'] == stage['protocol'], 'manifest ancestry')
    for role in ('ancestor_request', 'trial_request'):
        body = read_json(roles[role]['path'])
        require(body['schema'] == ('q26-fh-state-census-request-v1' if role == 'ancestor_request'
                                  else 'q26-fh-missingness-trial-request-v1'), 'ancestor schema')
        ancestor = body['pins']
        require(ancestor['cuts'] == roles['cuts'], 'ancestor frozen cut identity')
        if role == 'ancestor_request':
            require(same_content(ancestor['runner'], roles['census']), 'original census ancestor binding')
        for key in ('archive', 'manifest', 'staging_request'):
            require(ancestor[key] == roles[key], 'ancestor input mismatch')
        require(ancestor['producer'] == roles['staging_producer'], 'ancestor producer mismatch')
    trial = read_json(roles['trial_request']['path'])['pins']
    require(trial['cuts'] == roles['cuts'] and same_content(trial['census_source'], roles['census']), 'trial cut/census ancestry')
    require(cuts['schema'] == 'r17-conditional-depth-cuts-v1' and cuts['complete'] is True and
            cuts['phase'] == 'cuts' and cuts['input_pins']['24'] == roles['archive'] and
            cuts['request_pins']['manifest'] == roles['manifest'], 'frozen cut ancestry')
    cut = cuts['horizons']['24']['downside_imbalance_D']['cut']
    require(type(cut) is float and np.isfinite(cut), 'finite original cut')
    originals = fit['source_sha256']
    require(len(originals) == 30 and set(plan['legacy_sources']) == set(originals), 'complete thirty-source map')
    require(all(plan['legacy_sources'][k]['sha256'] == v for k, v in originals.items()), 'original scientific source hashes')
    # Raw authorities also retain descriptive fields such as relative. Only
    # these three fields form a byte pin; retain raw itself for loader metadata.
    allowedraw = {p['path']: {k: p[k] for k in ('path', 'size', 'sha256')}
                  for p in raw['price_inputs'] + raw['auxiliary_inputs']}
    require(len(stage['required_raw_paths']) == 30 and len(set(stage['required_raw_paths'])) == 30, 'thirty unique raw paths')
    for path in stage['required_raw_paths']:
        require(path in allowedraw and bypath.get(path) == allowedraw[path], 'required raw closure')
    for p in fit['runtime_native_pins']:
        require(bypath.get(p['path']) == p, 'native runtime closure')
    require(type(external_sha) is str and len(external_sha) == 64, 'external plan authority')
    # Metadata only through this point: no np.load, raw-grid parser or legacy import.
    return stage, raw, manifest, cut


def load_source(pin, name):
    data = pin_bytes(pin).read_bytes()
    module = types.ModuleType(name)
    module.__file__ = pin['path']
    exec(compile(data, pin['path'], 'exec'), module.__dict__)
    return module


@contextlib.contextmanager
def prohibit_models(A6, M2):
    def forbidden(*args, **kwargs):
        raise RuntimeError('fitting/prediction path prohibited')
    targets = [(np.linalg, 'solve'), (np.linalg, 'lstsq'),
               (A6.Prep6, 'har_coef'), (A6.Prep6, 'fh_w'), (M2, 'fhs_predict')]
    saved = [(obj, key, getattr(obj, key)) for obj, key in targets]
    for obj, key, _ in saved:
        setattr(obj, key, forbidden)
    try:
        require(all(getattr(obj, key) is forbidden for obj, key, _ in saved), 'model guards installed')
        yield
    finally:
        for obj, key, value in saved:
            setattr(obj, key, value)


def reconstruct(plan, metadata):
    """Separate checker wiring over the full original raw-grid cohort, no fit."""
    stage, raw, manifest, cut = metadata
    roles = plan['roles']
    staging = load_source(roles['staging_producer'], 'checker_original_staging')
    census = load_source(roles['census'], 'checker_original_census')
    paths = [p['path'] for p in plan['legacy_sources'].values()]
    finder = staging.FrozenSources(paths)
    require(not (set(finder.paths) & set(sys.modules)), 'legacy module preloaded')
    sys.meta_path.insert(0, finder)
    oldpath = list(sys.path)
    try:
        # Imported original modules only resolve through authenticated source bytes.
        with staging.guard([p['path'] for p in plan['files']], Path(plan['out'])):
            R12 = importlib.import_module('r12_tail')
            A6 = importlib.import_module('a6_touch')
            D = importlib.import_module('r16_dev')
            M2 = importlib.import_module('a2_touch')
            R12._CHAIN.clear()
            D._BTC.clear()
            pilot = plan['pilot']
            require(pilot['key'] in raw['canonical_keys'] and pilot['key'].startswith('blind6:'), 'fixed original raw-grid key')
            candidates = [p for p in raw['price_inputs']
                          if Path(p['path']).parent == Path(raw['datasets']) / 'blind6-prices'
                          and Path(p['path']).name.endswith('-1h.json')
                          and 'blind6:' + Path(p['path']).name.split('-')[1] == pilot['key']]
            require(len(candidates) == 1 and candidates[0]['path'] in stage['required_raw_paths'], 'unique original grid path')
            spec = {'key': pilot['key'], 'kind': 'grid', 'path': candidates[0]['path']}
            with prohibit_models(A6, M2):
                ser, _, _ = R12.load_series(spec)
                require(len(ser.close) + 1 <= plan['row_capacity'], 'raw grid capacity exceeded')
                prep = A6.Prep6(ser, 24, with_fbL=False)
                require(prep.n == len(ser.close) + 1 and prep.n <= plan['row_capacity'], 'full raw grid shape')
                records = [m for m in manifest['series_horizons'] if m['sid'] == pilot['sid'] and m['horizon'] == 24]
                require(len(records) == 1, 'unique retained H24 metadata')
                qs = {r['quarter_cutoff']: r for r in records[0]['quarters']}
                require(len(qs) == len(records[0]['quarters']) and
                        pilot['previous_cutoff'] in qs and pilot['current_cutoff'] in qs, 'current/predecessor retained records')
                coef = qs[pilot['current_cutoff']]['coef']
                if coef is not None:
                    coef = np.asarray(coef, dtype=np.float64)
                    require(coef.shape == (4,) and np.isfinite(coef).all(), 'retained coefficient shape')
                sigma = prep.sigma_H(coef)
                _, valid = prep.z_of(sigma)
                require(np.asarray(valid).dtype == bool and valid.shape == (prep.n,), 'original validity shape')
                feature = census.downside_feature(D.realized(ser), staging.sanitize)
                require(feature.dtype == np.dtype('float32') and feature.shape == (prep.n,), 'original float32 D shape')
                states = census.states_of(feature, cut)
                q = pilot['current_cutoff']
                require(type(ser.base_ts) is int and (q - ser.base_ts) % 3600 == 0, 'raw clock alignment')
                limit = (q - ser.base_ts) // 3600
                # Explicit loop establishes completeness, without producer masks/reducers.
                indices, ends, state, feats = [], [], [], []
                for i in range(prep.n):
                    if bool(valid[i]) and i + 24 <= limit:
                        indices.append(i)
                        ends.append(ser.base_ts + 3600 * (i + 24))
                        state.append(int(states[i]))
                        feats.append(feature[i])
                require(len(indices) <= plan['row_capacity'], 'main cohort capacity')
                return {'main_index': np.asarray(indices, dtype='<i8'),
                        'main_label_end': np.asarray(ends, dtype='<i8'),
                        'main_state': np.asarray(state, dtype='i1'),
                        'D_original': np.asarray(feats, dtype='<f4')}, int(ser.base_ts), cut
    finally:
        sys.meta_path.remove(finder)
        sys.path[:] = oldpath


def recount(witness, pilot, base_ts, cut, capacity):
    require(set(witness) == set(FIELDS), 'exact witness field inventory')
    n = None
    for key, dtype in FIELDS.items():
        a = witness[key]
        require(type(a) is np.ndarray and a.ndim == 1 and a.dtype == np.dtype(dtype), 'typed witness field')
        if n is None:
            n = len(a)
        require(len(a) == n, 'witness field length')
    require(n <= capacity and predecessor(pilot['current_cutoff']) == pilot['previous_cutoff'], 'capacity/predecessor')
    q, p = pilot['current_cutoff'], pilot['previous_cutoff']
    states = {'0': 0, '1': 0, '-1': 0}
    buckets = {k: {'count': 0, 'min': None, 'max': None} for k in ('before', 'equal', 'after', 'all')}
    last = -1
    for i in range(n):
        ix, end = int(witness['main_index'][i]), int(witness['main_label_end'][i])
        state, code = int(witness['main_state'][i]), int(witness['unknown_partition'][i])
        value = witness['D_original'][i]
        require(ix > last and ix >= 0, 'duplicate/reordered main index')
        last = ix
        require(end == base_ts + 3600 * (ix + 24) and end % 3600 == 0 and end <= q, 'label alignment/maturity')
        require(not np.isinf(value), 'infinite D refused')
        expected = -1 if np.isnan(value) else (0 if float(value) <= cut else 1)
        require(state in (-1, 0, 1) and state == expected, 'original float32 state rule')
        states[str(state)] += 1
        if state == -1:
            want = 0 if end < p else 1 if end == p else 2
            require(code == want, 'unknown date partition')
            for name in (('before', 'equal', 'after')[want], 'all'):
                b = buckets[name]
                b['count'] += 1
                b['min'] = end if b['min'] is None else min(end, b['min'])
                b['max'] = end if b['max'] is None else max(end, b['max'])
        else:
            require(code == -1, 'known-state partition sentinel')
    digests = {key: hashlib.sha256(witness[key].tobytes(order='C')).hexdigest() for key in FIELDS}
    return {'rows': n, 'state_counts': states, 'unknown': {'total': states['-1'], **buckets},
            'array_sha256': digests}


def verify_saved(plan, result, witness, reconstructed, base_ts, cut):
    require(result['schema'] == 'q26-fh-date-support-result-v1' and result['complete'] is True and
            result['reconstruction'] is True and result['historical_bridge_parity'] == 'UNAVAILABLE', 'result reconstruction attribution')
    require(set(reconstructed) == set(FIELDS) - {'unknown_partition'}, 'reconstruction fields')
    for key, expected in reconstructed.items():
        require(witness[key].dtype == expected.dtype and witness[key].shape == expected.shape and
                witness[key].tobytes() == expected.tobytes(), 'complete reconstructed membership/bit mismatch')
    summary = recount(witness, plan['pilot'], base_ts, cut, plan['row_capacity'])
    require(result['summary'] == summary, 'saved summary mismatch')
    require(result['membership_sha256'] == summary['array_sha256']['main_index'], 'membership digest')
    return summary


def witness_header_check(path, capacity):
    """Reject compressed bombs or hostile shape metadata before ndarray allocation."""
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        require(len(members) == len(FIELDS) and
                {m.filename for m in members} == {k + '.npy' for k in FIELDS}, 'typed archive members')
        require(sum(m.file_size for m in members) <= 67108864, 'witness expanded size')
        for member in members:
            key = member.filename[:-4]
            with archive.open(member) as stream:
                version = np.lib.format.read_magic(stream)
                require(version in ((1, 0), (2, 0)), 'NPY version')
                reader = (np.lib.format.read_array_header_1_0 if version == (1, 0)
                          else np.lib.format.read_array_header_2_0)
                shape, fortran, dtype = reader(stream)
                require(len(shape) == 1 and type(shape[0]) is int and 0 <= shape[0] <= capacity
                        and dtype == np.dtype(FIELDS[key]) and not fortran, 'NPY schema/capacity')
                require(member.file_size == stream.tell() + shape[0] * dtype.itemsize, 'NPY exact payload')


def run(plan_path, expected_sha, result_path, receipt_path):
    p = no_links(plan_path)
    require(hashlib.sha256(p.read_bytes()).hexdigest() == expected_sha, 'external plan SHA mismatch')
    plan = read_json(p)
    receipt = no_links(receipt_path)
    require(not receipt.exists() and receipt.parent.is_dir(), 'exclusive fresh receipt')
    require(not receipt.is_relative_to(Path(plan['out'])), 'receipt outside producer inventory')
    metadata = authenticate(plan, expected_sha)
    root = no_links(plan['out'])
    require(root.is_dir() and Path(result_path) == root / 'result.json', 'exact result path')
    require({x.name for x in root.iterdir()} == {'started.json', 'witness.npz', 'result.json'}, 'exact output inventory')
    for child in root.iterdir():
        require(not child.is_symlink() and child.is_file(), 'regular output files')
    result_file = no_links(result_path)
    result_initial_sha = hashlib.sha256(result_file.read_bytes()).hexdigest()
    result = read_json(result_file)
    require(set(result) == {'schema', 'plan_sha256', 'reconstruction', 'historical_bridge_parity',
                           'summary', 'witness', 'started', 'membership_sha256', 'complete', 'source'}, 'exact result schema')
    require(result['plan_sha256'] == expected_sha, 'result plan binding')
    require(result['source'] == plan['roles']['audit'], 'producer source binding')
    require(result['witness']['path'] == str(root / 'witness.npz') and
            result['started']['path'] == str(root / 'started.json'), 'output pin paths')
    pin_bytes(result['witness'])
    pin_bytes(result['started'])
    started = read_json(root / 'started.json')
    require(started['schema'] == 'q26-fh-date-support-started-v1' and
            started['plan_sha256'] == expected_sha and started['reconstruction'] is True, 'started authority')
    # All pinned inputs, runtime, ancestry, source and output inventory are authenticated.
    witness_header_check(root / 'witness.npz', plan['row_capacity'])
    with np.load(root / 'witness.npz', allow_pickle=False) as saved:
        require(len(saved.files) == len(FIELDS) and set(saved.files) == set(FIELDS), 'witness archive inventory')
        witness = {key: saved[key] for key in FIELDS}
    cohort, base_ts, cut = reconstruct(plan, metadata)
    summary = verify_saved(plan, result, witness, cohort, base_ts, cut)
    for pin in plan['files']:
        pin_bytes(pin)
    pin_bytes(result['witness'])
    pin_bytes(result['started'])
    require(hashlib.sha256(p.read_bytes()).hexdigest() == expected_sha, 'final plan rehash')
    require(hashlib.sha256(result_file.read_bytes()).hexdigest() == result_initial_sha, 'result changed during check')
    require({x.name for x in root.iterdir()} == {'started.json', 'witness.npz', 'result.json'}, 'final output inventory')
    payload = {'schema': 'q26-fh-date-support-acceptance-v1', 'complete': True,
               'label': 'CODEX CONTINUATION', 'plan_sha256': expected_sha,
               'result_sha256': hashlib.sha256(Path(result_path).read_bytes()).hexdigest(),
               'checker_source': plan['roles']['checker'], 'reconstruction': True,
               'historical_bridge_parity': 'UNAVAILABLE', 'summary': summary,
               'scope': 'Independent wiring and recount using shared pinned original scientific arithmetic; not independent original arithmetic or recovered historical bridge identity.'}
    fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(payload, stream, sort_keys=True, allow_nan=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    return payload


def main():
    parser = argparse.ArgumentParser()
    for name in ('plan', 'plan-sha256', 'result', 'receipt'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    run(args.plan, args.plan_sha256, args.result, args.receipt)


if __name__ == '__main__':
    main()
