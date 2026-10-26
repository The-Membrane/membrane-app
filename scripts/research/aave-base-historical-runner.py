"""Explicit one-attempt Linux runner; inert without reviewed execution flag/config.

Physical-cash research only: not native holder exit, blindness or validation proof.
No network, retry, acquisition, scheduler or pin override. Source/input authenticity
and external evidence qualification remain necessary. No config is supplied here.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import resource
import signal
import sys
import time
import types
from fractions import Fraction

MiB = 2**20
FIXED = {
 'kernel': (9515, 'e4ebd12b206e66c700c1065adbf56088fe1bb231c70f464975a078e4f56602f3'),
 'admission': (8496, 'c8e4e471d0d8960d5549943ac927cdb000407218f3334c75bd20296940842474'),
 'evaluator': (7795, 'd5d2b4053e3d1515afb02babebd3341ac6f1cc9ca7e5bb292464000b52d00a19'),
 'pilot': (16369, '86a80f565012584de72dc3750518b964110e717344852365d0950a9146cac772'),
 'threshold': (3572, 'e4e0de111e7d96b53b87bf05208254f730273be023b6be25da4730b6ddd32cad')}
CACHE = {'bytes': 55020818, 'sha256': '1d3d46360eff4b9f5e8e398372e5aa47aa665015878e099abbbfba7f92ed8345'}
CAPS = {'cache': CACHE['bytes'], 'features': MiB, 'proof': MiB // 2, 'audit': MiB}


def need(ok, code):
    if not ok:
        raise ValueError(code)


def sha64(x):
    return type(x) is str and len(x) == 64 and all(c in '0123456789abcdef' for c in x)


def state(path):
    path = Path(path)
    need(path.is_absolute() and path.is_file() and not any(p.is_symlink() for p in (path, *path.parents)), 'safe_file')
    st = path.stat()
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def descriptor(desc):
    need(type(desc) is dict and set(desc) == {'path', 'bytes', 'sha256'}
         and type(desc['path']) is str and type(desc['bytes']) is int
         and desc['bytes'] >= 0 and sha64(desc['sha256']), 'descriptor')


def read(desc, cap):
    descriptor(desc); path = Path(desc['path']); before = state(path)
    need(before[2] == desc['bytes'] <= cap, 'input_size')
    with path.open('rb') as stream:
        body = stream.read(cap + 1)
    need(len(body) == desc['bytes'] and hashlib.sha256(body).hexdigest() == desc['sha256']
         and state(path) == before, 'served_pin')
    return body, before


def bookend(desc, before, cap):
    need(state(Path(desc['path'])) == before, 'stat_bookend')
    _, after = read(desc, cap)
    need(after == before, 'byte_bookend')


def strict_json(body):
    def pairs(items):
        out = {}
        for key, value in items:
            need(key not in out, 'duplicate_json_key'); out[key] = value
        return out
    def constant(_):
        raise ValueError('nonfinite_json')
    result = json.loads(body, object_pairs_hook=pairs, parse_constant=constant)
    def finite(value):
        if type(value) is float:
            need(value == value and abs(value) != float('inf'), 'nonfinite_json')
        elif type(value) is dict:
            for v in value.values(): finite(v)
        elif type(value) is list:
            for v in value: finite(v)
    finite(result)
    return result


def module(body, path, name):
    result = types.ModuleType(name); result.__file__ = str(path)
    sys.modules[name] = result
    exec(compile(body, str(path), 'exec'), result.__dict__)
    return result


def make_path_provider(P, Index, ts, cash):
    def provider(t, h):
        points, observed, full = P.path(ts, cash, t, h)
        need(full is True and type(observed) is int and observed == h, 'incomplete_path')
        need(type(points) is list and points and points[0][0] == 0, 'path_anchor')
        previous = -1
        for elapsed, amount in points:
            need(type(elapsed) is int and previous < elapsed <= h and type(amount) is int and amount >= 0, 'path_domain')
            previous = elapsed
        ix = Index(points, h)
        need(ix.base == points[0][1] and ix.terminal == points[-1][1]
             and ix.minimum == min(c for _, c in points), 'index_path_join')
        return types.SimpleNamespace(base=ix.base, terminal=ix.terminal, minimum=ix.minimum,
                                     h=h, fullWindow=True, observedSeconds=observed)
    return provider


def run_evaluation(admission, kernel, evaluator, P, Index, bodies, inputs, cache_loader):
    """Pure orchestration boundary; production supplies exact-pinned dependencies."""
    descriptor(inputs['cache'])
    need({k: inputs['cache'][k] for k in ('bytes', 'sha256')} == CACHE, 'fixed_cache_pin')
    for name in ('features', 'proof', 'audit'):
        descriptor(inputs[name])
        need(len(bodies[name]) == inputs[name]['bytes']
             and hashlib.sha256(bodies[name]).hexdigest() == inputs[name]['sha256'], 'evaluation_input_pin')
    bundle, proof, audit = (strict_json(bodies[k]) for k in ('features', 'proof', 'audit'))
    ts, cash, metadata = cache_loader()
    need(len(ts) == len(cash) == 969263 and ts[0] == 1674808907 and ts[-1] == 1791932579, 'cache_clock_count')
    provider = make_path_provider(P, Index, ts, cash)
    report = evaluator.evaluate(admission, kernel, bundle, proof, audit,
                                {k: inputs[k] for k in ('cache', 'features', 'proof')}, provider)
    return report, metadata


def json_value(value):
    """Normalize mapping keys deterministically; preserve exact rational values."""
    if isinstance(value, Fraction):
        return {'numerator': str(value.numerator), 'denominator': str(value.denominator)}
    if type(value) is dict:
        out = {}
        for key, item in value.items():
            need(type(key) in (str, int, float), 'unsupported_report_key')
            if type(key) is float:
                need(key == key and abs(key) != float('inf'), 'nonfinite_report_key')
            normalized = str(key)
            need(normalized not in out, 'report_key_collision')
            out[normalized] = json_value(item)
        return out
    if type(value) in (tuple, list):
        return [json_value(item) for item in value]
    need(value is None or type(value) in (str, int, float, bool), 'unsupported_report_value')
    return value


def encode(obj, cap):
    normalized = json_value(obj)
    chunks = []; size = 0
    for chunk in json.JSONEncoder(sort_keys=True, separators=(',', ':'), allow_nan=False).iterencode(normalized):
        encoded = chunk.encode(); size += len(encoded); need(size + 1 <= cap, 'serialized_cap'); chunks.append(encoded)
    return b''.join(chunks) + b'\n'


def serialize_report(report):
    raw = encode(report, 32 * MiB); compressed = gzip.compress(raw, mtime=0)
    need(len(compressed) <= 8 * MiB, 'compressed_cap')
    summary = encode({'target': 'physical_cash_research_not_holder_exit_or_blind_validation',
                      'primary24hMinimum': report['primary24hMinimum']}, MiB)
    need(len(compressed) + len(summary) + 65536 <= 12 * MiB, 'total_output_cap')
    return compressed, summary


def resources(start):
    usage = resource.getrusage(resource.RUSAGE_SELF)
    result = {'CPUSeconds': time.process_time(), 'wallSeconds': time.monotonic() - start,
              'RSSKiB': usage.ru_maxrss}
    need(result['CPUSeconds'] <= 120 and result['wallSeconds'] <= 180
         and result['RSSKiB'] <= 512 * 1024, 'final_resources')
    return result


def output_directory(value):
    need(type(value) is str, 'output_path'); candidate = Path(value)
    # Inspect the original traversal before resolving away symlink components.
    need(candidate.is_absolute() and not candidate.is_symlink()
         and not any(p.is_symlink() for p in candidate.parents), 'fresh_output_path')
    path = candidate.resolve(strict=False)
    app_data = (Path(__file__).resolve().parents[2] / 'data').resolve(strict=False)
    adjacent_app_data = any(path.parts[i:i + 2] == ('membrane-app', 'data')
                            for i in range(len(path.parts) - 1))
    need(candidate == path and not path.is_relative_to(app_data) and not adjacent_app_data
         and not path.exists() and path.parent.is_dir(), 'fresh_output_path')
    path.mkdir()
    return path


def write(path, body):
    with path.open('xb') as stream:
        stream.write(body); stream.flush(); os.fsync(stream.fileno())


def execute(config_desc):
    start = time.monotonic()
    config_bytes, config_state = read(config_desc, 65536); config = strict_json(config_bytes)
    need(type(config) is dict and config.get('executionAuthorized') is True, 'execution_not_authorized')
    need(set(config) == {'executionAuthorized', 'sources', 'inputs', 'outputPath'}, 'config_shape')
    sources, inputs = config['sources'], config['inputs']
    need(type(sources) is dict and set(sources) == set(FIXED) | {'runner'}, 'source_set')
    need(type(inputs) is dict and set(inputs) == set(CAPS), 'input_set')
    descriptor(sources['runner'])
    need(Path(sources['runner']['path']) == Path(__file__).absolute(), 'runner_path')
    source_bodies, source_states = {}, {}
    for name, desc in sources.items():
        if name != 'runner':
            descriptor(desc); need((desc['bytes'], desc['sha256']) == FIXED[name], 'fixed_source_pin')
        source_bodies[name], source_states[name] = read(desc, 65536)
    need(Path(sources['threshold']['path']) == Path(sources['pilot']['path']).with_name('threshold.py'), 'threshold_sibling')
    for name, desc in inputs.items():
        descriptor(desc); need(desc['bytes'] <= CAPS[name], 'input_cap')
    need({k: inputs['cache'][k] for k in ('bytes', 'sha256')} == CACHE, 'fixed_cache_pin')
    bodies, input_states = {}, {}
    for name in ('features', 'proof', 'audit'):
        bodies[name], input_states[name] = read(inputs[name], CAPS[name])
    input_states['cache'] = state(Path(inputs['cache']['path']))
    need(input_states['cache'][2] == CACHE['bytes'], 'cache_size')
    loaded = {name: module(source_bodies[name], sources[name]['path'], '_reviewed_base_' + name)
              for name in FIXED}
    output = output_directory(config['outputPath'])
    # One served-byte hash/parse pass inside pinned P.load_cache; final stat only.
    loader = lambda: loaded['pilot'].load_cache(Path(inputs['cache']['path']), CACHE, 969263)
    report, metadata = run_evaluation(loaded['admission'], loaded['kernel'], loaded['evaluator'],
                                      loaded['pilot'], loaded['threshold'].Index, bodies, inputs, loader)
    compressed, summary = serialize_report(report)
    write(output / 'report.json.gz', compressed); write(output / 'summary.json', summary)
    for name, desc in sources.items(): bookend(desc, source_states[name], 65536)
    for name, desc in inputs.items():
        if name == 'cache':
            need(state(Path(desc['path'])) == input_states[name], 'cache_final_stat')
        else:
            bookend(desc, input_states[name], CAPS[name])
    bookend(config_desc, config_state, 65536)
    receipt = {'status': 'complete', 'target': 'physical_cash_research_not_holder_exit_or_blind_validation',
               'configPin': config_desc, 'cache': metadata, 'cacheBytePasses': 1, 'cacheParsedLoads': 1,
               'cacheFinalCheck': 'stat_after_served_pin', 'sourcePins': sources, 'inputPins': inputs,
               'postSerializationResources': resources(start), 'bookends': 'small_source_input_config_bytes_and_stat_cache_stat_passed',
               'artifacts': {'report.json.gz': {'bytes': len(compressed), 'sha256': hashlib.sha256(compressed).hexdigest()},
                             'summary.json': {'bytes': len(summary), 'sha256': hashlib.sha256(summary).hexdigest()}}}
    receipt_bytes = encode(receipt, 65536)
    need(len(compressed) + len(summary) + len(receipt_bytes) <= 12 * MiB, 'total_output_cap')
    write(output / 'receipt.json', receipt_bytes)
    for name, desc in sources.items():
        need(state(Path(desc['path'])) == source_states[name], 'final_source_stat')
    for name, desc in inputs.items():
        need(state(Path(desc['path'])) == input_states[name], 'final_input_stat')
    need(state(Path(config_desc['path'])) == config_state, 'final_config_stat')
    final = resources(start)
    return {'status': 'complete', 'finalPostArtifactResources': final, 'artifacts': receipt['artifacts']}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Explicit reviewed Linux physical-cash research only')
    parser.add_argument('--execute-reviewed-historical-once', action='store_true')
    parser.add_argument('--config'); parser.add_argument('--config-sha256')
    args = parser.parse_args(argv)
    need(args.execute_reviewed_historical_once and args.config and sha64(args.config_sha256), 'inert_requires_reviewed_execution')
    need(sys.platform == 'linux', 'cloud_linux_only')
    # Hard limits apply before any config/source/data read. No retries or background work.
    resource.setrlimit(resource.RLIMIT_CPU, (120, 122))
    resource.setrlimit(resource.RLIMIT_AS, (768 * MiB, 768 * MiB))
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(ValueError('wall_timeout')))
    signal.alarm(180)
    config_path = Path(args.config); st = state(config_path)
    result = execute({'path': str(config_path), 'bytes': st[2], 'sha256': args.config_sha256})
    signal.alarm(0)
    print(encode(result, 65536).decode().strip())
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('historical_runner_failed', file=sys.stderr)
        sys.exit(1)
