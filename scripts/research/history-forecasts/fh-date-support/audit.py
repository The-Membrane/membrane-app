"""One fixed-pilot date-support reconstruction. No fits, forecasts or scores."""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import importlib
import importlib.abc
import importlib.machinery
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import types

MODE = 'NEW_RECONSTRUCTION_FIXED_PILOT_DATE_SUPPORT'
FIELDS = {'main_index': 'int64', 'main_label_end': 'int64', 'main_state': 'int8',
          'D_original': 'float32', 'unknown_partition': 'int8'}
ROLES = {'ancestor_request', 'trial_request', 'staging_request', 'fit_scope',
         'raw_authority', 'manifest', 'cuts', 'archive', 'census',
         'staging_producer', 'audit', 'checker', 'private_lineage'}
ENV = {'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1',
       'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONOPTIMIZE': '0'}


def need(ok, why):
    if not ok:
        raise ValueError(why)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def pin(path):
    p = Path(path)
    need(p.is_absolute() and p.resolve() == p and p.is_file() and not p.is_symlink(), 'canonical regular pin')
    data = p.read_bytes()
    return {'path': str(p), 'size': len(data), 'sha256': digest(data)}


def check(value):
    need(type(value) is dict and set(value) == {'path', 'size', 'sha256'}, 'exact pin schema')
    need(type(value['size']) is int and value['size'] >= 0, 'pin size')
    need(type(value['sha256']) is str and re.fullmatch('[0-9a-f]{64}', value['sha256']), 'pin SHA')
    need(pin(value['path']) == value, 'pin drift')


def read(value):
    check(value)
    return decode(Path(value['path']).read_bytes())


def decode(data):
    def object_pairs(pairs):
        value = {}
        for key, item in pairs:
            need(key not in value, 'duplicate JSON authority key')
            value[key] = item
        return value
    def nonfinite(value):
        raise ValueError('nonfinite JSON authority')
    return json.loads(data, object_pairs_hook=object_pairs, parse_constant=nonfinite)


def same_content(a, b):
    return a['size'] == b['size'] and a['sha256'] == b['sha256']


def previous_quarter(q):
    need(type(q) is int, 'integer cutoff')
    d = dt.datetime.fromtimestamp(q, dt.timezone.utc)
    need(d.month in (1, 4, 7, 10) and d.day == 1 and
         d.hour == d.minute == d.second == d.microsecond == 0, 'calendar quarter boundary')
    return int(dt.datetime(d.year - (d.month == 1), 10 if d.month == 1 else d.month - 3,
                           1, tzinfo=dt.timezone.utc).timestamp())


def authenticate(plan_path, plan_sha256):
    """Hash external plan before JSON parsing; authenticate all metadata before imports/raw decoding."""
    ppin = pin(plan_path)
    need(ppin['sha256'] == plan_sha256, 'external plan SHA')
    plan = decode(Path(plan_path).read_bytes())
    need(set(plan) == {'schema', 'parent_admitted', 'mode', 'pilot', 'roles', 'files',
                       'legacy_sources', 'runtime', 'out', 'source_commit', 'row_capacity'}, 'exact plan schema')
    need(plan['schema'] == 'q26-fh-date-support-plan-v1' and plan['parent_admitted'] is True
         and plan['mode'] == MODE and plan['row_capacity'] == 200000, 'unadmitted or wrong scope')
    need(type(plan['source_commit']) is str and re.fullmatch('[0-9a-f]{40}', plan['source_commit']), 'source commit')
    pilot = plan['pilot']
    need(set(pilot) == {'sid', 'key', 'current_cutoff', 'previous_cutoff'} and
         type(pilot['sid']) is int and type(pilot['key']) is str, 'pilot schema')
    need(pilot['previous_cutoff'] == previous_quarter(pilot['current_cutoff']), 'immediate predecessor')
    need(set(plan['roles']) == ROLES and type(plan['files']) is list, 'role and closure schema')
    closure = {}
    for value in plan['files']:
        check(value)
        need(value['path'] not in closure, 'unique closure path')
        closure[value['path']] = value
    roles = plan['roles']
    for value in list(roles.values()) + list(plan['legacy_sources'].values()):
        need(closure.get(value['path']) == value, 'role/source belongs to closure')
    need(roles['audit'] == pin(Path(__file__).resolve()), 'executed audit source')
    ancestor, trial = read(roles['ancestor_request']), read(roles['trial_request'])
    need(ancestor['schema'] == 'q26-fh-state-census-request-v1' and
         trial['schema'] == 'q26-fh-missingness-trial-request-v1', 'original ancestor schemas')
    for body in (ancestor, trial):
        for old_role, new_role in [('archive', 'archive'), ('manifest', 'manifest'),
                                  ('producer', 'staging_producer'), ('staging_request', 'staging_request')]:
            need(body['pins'][old_role] == roles[new_role], 'ancestor pin binding')
        need(body['pins']['cuts'] == roles['cuts'], 'original cuts binding')
    need(same_content(trial['pins']['census_source'], roles['census']) and
         same_content(ancestor['pins']['runner'], roles['census']), 'relocated exact census identity')
    staging = read(roles['staging_request'])
    need(staging['schema'] == 'codex-r17-staging-request-v1' and
         staging['status'] == 'READY_PARENT_REVIEWED', 'original staging authority')
    for old, new in [('fit_scope', 'fit_scope'), ('raw_scope', 'raw_authority'), ('helper', 'staging_producer')]:
        need(staging['pins'][old] == roles[new], 'staging lineage')
    fit, raw = read(roles['fit_scope']), read(roles['raw_authority'])['base_scope']
    need(len(fit['source_sha256']) == 30 and set(plan['legacy_sources']) == set(fit['source_sha256']), 'all thirty source closure')
    for rel, expected_sha in fit['source_sha256'].items():
        need(plan['legacy_sources'][rel]['sha256'] == expected_sha and
             plan['legacy_sources'][rel]['path'].endswith('/' + rel), 'original scientific source pin')
    for value in fit['runtime_native_pins']:
        need(closure.get(value['path']) == value, 'all original runtime native pins')
    raw_pins = {v['path']: v for v in raw['price_inputs'] + raw['auxiliary_inputs']}
    need(len(staging['required_raw_paths']) == 30 and len(set(staging['required_raw_paths'])) == 30, 'thirty required raw inputs')
    for path in staging['required_raw_paths']:
        need(path in raw_pins and closure.get(path) == raw_pins[path], 'raw authority closure')
    manifest, cuts, lineage = read(roles['manifest']), read(roles['cuts']), read(roles['private_lineage'])
    need(manifest['schema'] == 'codex-r17-staged-inputs-v1' and manifest['complete'] is True, 'complete original manifest')
    need(roles['archive'] in manifest['outputs'] and manifest['request_protocol'] == staging['protocol'], 'manifest ancestry')
    need(manifest['canonical_mapping'] == staging['selected'] and manifest['canonical_mapping'][0] == [pilot['sid'], pilot['key']], 'fixed first canonical pilot')
    need(lineage['schema'] == 'q26-fh-private-input-lineage-v1', 'private selector lineage')
    need(lineage['private_pilot'] == dict(sid=pilot['sid'], key=pilot['key'],
         current_cutoff=pilot['current_cutoff'], predecessor_cutoff=pilot['previous_cutoff']), 'original fixed selector')
    need(cuts['schema'] == 'r17-conditional-depth-cuts-v1' and cuts['complete'] is True and
         cuts['phase'] == 'cuts' and cuts['input_pins']['24'] == roles['archive'] and
         cuts['request_pins']['manifest'] == roles['manifest'], 'frozen cut ancestry')
    cut = cuts['horizons']['24']['downside_imbalance_D']['cut']
    need(type(cut) is float and __import__('math').isfinite(cut), 'original finite D cut')
    groups = [g for g in manifest['series_horizons'] if g['sid'] == pilot['sid'] and g['horizon'] == 24]
    need(len(groups) == 1, 'unique H24 pilot metadata')
    selected = {}
    for key in ('current_cutoff', 'previous_cutoff'):
        records = [v for v in groups[0]['quarters'] if v['quarter_cutoff'] == pilot[key]]
        need(len(records) == 1, 'unique original current/predecessor record')
        selected[key] = records[0]
    runtime = plan['runtime']
    need(set(runtime) == {'python_path', 'executable', 'python_version', 'packages', 'env'}, 'runtime schema')
    need(runtime['python_path'] == sys.executable and runtime['executable'] == pin(Path(sys.executable).resolve())
         and closure.get(runtime['executable']['path']) == runtime['executable'] and
         runtime['python_version'] == sys.version.split()[0], 'interpreter identity')
    need(runtime['env'] == ENV and all(os.environ.get(k) == v for k, v in ENV.items()), 'one thread and no bytecode/optimization')
    need(not sys.flags.optimize and sys.dont_write_bytecode, 'interpreter flags')
    need(set(runtime['packages']) == {'numpy', 'scipy', 'numba', 'llvmlite'}, 'runtime dependency set')
    for package, version in runtime['packages'].items():
        need(importlib.metadata.version(package) == version, 'package version drift')
    out = Path(plan['out'])
    need(out.is_absolute() and out.resolve() == out and not out.exists() and not out.is_symlink()
         and out.parent.is_dir(), 'fresh canonical output')
    return plan, staging, raw, selected, cut


class FrozenSources(importlib.abc.MetaPathFinder):
    def __init__(self, values):
        self.paths = {Path(v['path']).stem: v for v in values}

    def find_spec(self, fullname, path=None, target=None):
        if fullname not in self.paths:
            return None
        value = self.paths[fullname]
        check(value)
        class Loader(importlib.machinery.SourceFileLoader):
            def get_code(self, name):
                check(value)
                return self.source_to_code(Path(value['path']).read_bytes(), value['path'])
        return importlib.util.spec_from_loader(fullname, Loader(fullname, value['path']))


def source_module(name, value):
    check(value)
    module = types.ModuleType(name)
    module.__file__ = value['path']
    sys.modules[name] = module
    exec(compile(Path(value['path']).read_bytes(), value['path'], 'exec'), module.__dict__)
    return module


def grid_spec(paths, key):
    """The original blind-grid dev_specs constructor, without scanning other cohorts."""
    prefix, asset = key.split(':')
    need(re.fullmatch(r'blind[4-7]', prefix) is not None, 'fixed original blind-grid family')
    matches = [p for p in paths if Path(p).parent.name == prefix + '-prices' and
               Path(p).name == 'binance-' + asset + '-1h.json']
    need(len(matches) == 1, 'unique authenticated original grid path')
    return dict(key=key, kind='grid', path=matches[0])


@contextlib.contextmanager
def forbid_work(np, A6, M2):
    """Tripwires enclose original loading, preparation and reconstruction."""
    saved = []
    def forbidden(*args, **kwargs):
        raise RuntimeError('refit/prediction forbidden in date support audit')
    for obj, names in [(np.linalg, ('solve', 'lstsq')),
                       (A6.Prep6, ('har_coef', 'fh_w', 'asof_rows', 'map_rows', 'beta_maps')),
                       (M2, ('fhs_predict',))]:
        for name in names:
            if hasattr(obj, name):
                saved.append((obj, name, getattr(obj, name)))
                setattr(obj, name, forbidden)
    try:
        yield
    finally:
        for obj, name, value in reversed(saved):
            setattr(obj, name, value)


def reconstruct(np, R12, A6, D, M2, census, producer, spec, record, pilot, cut, row_capacity=200000):
    """Whole original arrays first; only then select all current-main indices."""
    need(spec['kind'] == 'grid' and spec['key'] == pilot['key'], 'fixed grid-only source')
    with forbid_work(np, A6, M2):
        ser, _, _ = R12.load_series(spec)
        need(type(ser.base_ts) is int and (pilot['current_cutoff'] - ser.base_ts) % 3600 == 0, 'own cutoff grid')
        need(len(ser.close) + 1 <= row_capacity, 'full raw history capacity; never crop')
        prep = A6.Prep6(ser, 24, with_fbL=False)
        need(type(prep.n) is int and prep.n == len(ser.close) + 1 and 0 <= prep.n <= row_capacity, 'whole-history capacity; never crop')
        i = np.arange(prep.n, dtype=np.int64)
        mature = i + 24 <= (pilot['current_cutoff'] - ser.base_ts) // 3600
        reg = np.flatnonzero(prep.okH & mature)
        need(type(record['n_reg']) is int and record['n_reg'] == len(reg), 'retained regression membership')
        coef = record['coef']
        need((coef is None) == (len(reg) < 4), 'original retained None rule')
        if coef is not None:
            coef = np.asarray(coef, np.float64)
            need(coef.shape == (4,) and np.isfinite(coef).all(), 'retained coefficient schema')
        sigma = prep.sigma_H(coef)
        _, valid = prep.z_of(sigma)
        need(valid.dtype == np.dtype('bool') and valid.shape == (prep.n,), 'whole original valid vector')
        main = np.flatnonzero(valid & mature).astype(np.int64)
        end = lambda ix: None if not len(ix) else int(ser.base_ts + 3600 * (int(ix[-1]) + 24))
        fallback = np.flatnonzero(prep.P.valid[1.] & mature)
        expected = dict(har_label_end_max=end(reg), har_label_end_min=None if not len(reg) else
                        int(ser.base_ts + 3600 * (int(reg[0]) + 24)), library_label_end_max=end(main),
                        fallback_library_label_end_max=end(fallback))
        need(all(record[k] == v for k, v in expected.items()), 'original maturity metadata')
        feature = census.downside_feature(D.realized(ser), producer.sanitize)
        need(feature.dtype == np.dtype('float32') and feature.shape == (prep.n,),
             'original full D float32 representation')
        states = census.states_of(feature, cut)
        return witness(np, main, ser.base_ts + 3600 * (main + 24), states[main], feature[main],
                       pilot['previous_cutoff'], pilot['current_cutoff'], row_capacity)


def witness(np, indices, ends, states, feature, p, q, row_capacity=200000):
    need(p == previous_quarter(q), 'witness predecessor')
    values = dict(main_index=indices, main_label_end=ends, main_state=states, D_original=feature)
    n = len(indices)
    need(n <= row_capacity, 'complete main capacity')
    for name, value in values.items():
        need(value.dtype == np.dtype(FIELDS[name]) and value.shape == (n,), 'typed aligned ' + name)
    need(np.all(indices >= 0) and np.all(np.diff(indices) > 0), 'ordered unique whole membership')
    need(np.all(ends <= q) and np.all((ends - q) % 3600 == 0), 'full maturity and hourly labels')
    need(np.all(np.isin(states, [-1, 0, 1])) and not np.isinf(feature).any(), 'original state/D domain')
    need(np.array_equal(states == -1, ~np.isfinite(feature)), 'original unknown rows retained')
    part = np.full(n, -1, np.int8)
    unknown = states == -1
    part[unknown & (ends < p)] = 0
    part[unknown & (ends == p)] = 1
    part[unknown & (ends > p)] = 2
    return dict(values, unknown_partition=part)


def summarize(np, arrays):
    need(set(arrays) == set(FIELDS), 'exact witness fields')
    n = len(arrays['main_index'])
    for key, dtype in FIELDS.items():
        need(arrays[key].dtype == np.dtype(dtype) and arrays[key].shape == (n,), 'summary schema')
    def extent(mask):
        a = arrays['main_label_end'][mask]
        return dict(count=len(a), min=None if not len(a) else int(a.min()), max=None if not len(a) else int(a.max()))
    part, state = arrays['unknown_partition'], arrays['main_state']
    unknown = dict(total=int((state == -1).sum()), before=extent(part == 0), equal=extent(part == 1),
                   after=extent(part == 2), all=extent(state == -1))
    need(sum(unknown[k]['count'] for k in ('before', 'equal', 'after')) == unknown['total'], 'unknown count reconciliation')
    return dict(rows=n, state_counts={str(k): int((state == k).sum()) for k in (0, 1, -1)},
                unknown=unknown, array_sha256={key: digest(value.astype(np.dtype(FIELDS[key]).newbyteorder('<'), copy=False).tobytes())
                                               for key, value in arrays.items()})


def write_json(path, value):
    with path.open('xb') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write((json.dumps(value, indent=2, allow_nan=False) + '\n').encode())
        stream.flush()
        os.fsync(stream.fileno())


def run(plan_path, plan_sha256):
    plan, staging, raw, records, cut = authenticate(plan_path, plan_sha256)
    out = Path(plan['out'])
    out.mkdir(mode=0o700)
    write_json(out / 'started.json', dict(schema='q26-fh-date-support-started-v1', plan_sha256=plan_sha256, reconstruction=True))
    import numpy as np
    finder = FrozenSources(plan['legacy_sources'].values())
    need(not (set(finder.paths) & set(sys.modules)), 'no preloaded legacy module bypass')
    sys.meta_path.insert(0, finder)
    try:
        producer = source_module('_fh_date_support_original_producer', plan['roles']['staging_producer'])
        census = source_module('_fh_date_support_original_census', plan['roles']['census'])
        allowed = [v['path'] for v in plan['files']]
        with producer.guard(allowed, out):
            R12, A6, D, M2 = [importlib.import_module(k) for k in ('r12_tail', 'a6_touch', 'r16_dev', 'a2_touch')]
            spec = grid_spec(staging['required_raw_paths'], plan['pilot']['key'])
            need(spec['kind'] == 'grid' and str(Path(spec['path']).resolve()) in staging['required_raw_paths'], 'admitted grid source')
            arrays = reconstruct(np, R12, A6, D, M2, census, producer, spec, records['current_cutoff'], plan['pilot'], cut, plan['row_capacity'])
            summary = summarize(np, arrays)
            with (out / 'witness.npz').open('xb') as stream:
                os.fchmod(stream.fileno(), 0o600)
                np.savez_compressed(stream, **arrays)
                stream.flush()
                os.fsync(stream.fileno())
        for value in plan['files']:
            check(value)
        need(pin(plan_path)['sha256'] == plan_sha256, 'final plan unchanged')
        result = dict(schema='q26-fh-date-support-result-v1', plan_sha256=plan_sha256,
                      reconstruction=True, historical_bridge_parity='UNAVAILABLE', summary=summary,
                      witness=pin(out / 'witness.npz'), started=pin(out / 'started.json'),
                      membership_sha256=digest(arrays['main_index'].astype('<i8', copy=False).tobytes()),
                      complete=True, source=plan['roles']['audit'])
        write_json(out / 'result.json', result)
        need({p.name for p in out.iterdir()} == {'started.json', 'witness.npz', 'result.json'}, 'exact final inventory')
        return {'complete': True, 'reconstruction': True, 'historical_bridge_parity': 'UNAVAILABLE'}
    finally:
        sys.meta_path.remove(finder)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', required=True)
    parser.add_argument('--plan-sha256', required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.plan, args.plan_sha256)))
