"""Draft pure, in-memory historical A-only physical-cash evaluation.

No CLI, I/O, network, outcome collection or historical execution. Inject source-
reviewed base admission/kernel modules and a caller-authenticated path provider.
The caller must separately authenticate raw input descriptors, chain/source
proofs, and complete path history. Numeric checks cannot establish authenticity.
Results describe physical cash, not native holder exit ability. Historical
blindness, forecast validation and causal size/utilization effects are unproven.
"""
from datetime import datetime, timezone
from fractions import Fraction as F
from types import SimpleNamespace
import hashlib
import json

PHASE = 64800
CALENDAR_SHA256 = 'e6afd0620e250690fae98101910b5818bfe82b260367dbe06a71cce09b82e2f6'


def need(value, code):
    if not value:
        raise ValueError(code)


def frozen_calendar():
    start = int(datetime(2025, 6, 15, 18, tzinfo=timezone.utc).timestamp())
    return [{'issueAt': start + i * 86400, 'slot': 3,
             'split': 'TRAIN' if i < 59 else 'CAL' if i < 89 else 'DEV'}
            for i in range(120) if i not in (59, 89)]


def checked_calendar(calendar):
    expected = frozen_calendar()
    need(type(calendar) is list and len(calendar) == 118, 'fixed_calendar')
    need(all(type(r) is dict and set(r) == {'issueAt', 'slot', 'split'}
             and type(r['issueAt']) is int and type(r['slot']) is int for r in calendar)
         and calendar == expected, 'fixed_calendar')
    encoded = (json.dumps(calendar, sort_keys=True, separators=(',', ':')) + '\n').encode()
    need(len(encoded) == 5548 and hashlib.sha256(encoded).hexdigest() == CALENDAR_SHA256, 'calendar_pin')
    return expected


def checked_paths(index, states, horizons):
    """Snapshot at most 118x4 cells; reject incomplete or incoherent cash paths."""
    out = {}
    for state in states:
        previous_minimum = None
        for h in horizons:
            try:
                p = index(state['T'], h)
                values = (p.base, p.terminal, p.minimum, p.h, p.observedSeconds)
                need(all(type(v) is int and v >= 0 for v in values), 'path_integer_domain')
                need(p.fullWindow is True and p.h == h and p.observedSeconds == h, 'path_full_window')
                need(p.base == state['C'] and p.minimum <= min(p.base, p.terminal), 'path_cash_domain')
                need(previous_minimum is None or p.minimum <= previous_minimum, 'path_minimum_horizon')
                out[state['T'], h] = SimpleNamespace(base=p.base, terminal=p.terminal,
                                                      minimum=p.minimum, h=h,
                                                      fullWindow=True, observedSeconds=h)
                previous_minimum = p.minimum
            except (KeyError, AttributeError, TypeError) as error:
                raise ValueError('missing_or_invalid_path') from error
    return out


def evaluate(admission, kernel, bundle, proof, audit, expectedPins, index, calendar=None):
    """Return exact-Fraction research scores, samples and amount/horizon marginals."""
    calendar = checked_calendar(frozen_calendar() if calendar is None else calendar)
    times = tuple(r['issueAt'] for r in calendar)
    qualified, exceptions = admission.qualified_features(bundle, proof, expectedPins['features'], times, PHASE)
    need(not exceptions and set(qualified) == set(times), 'qualification_exceptions')
    audited = admission.audited_states(audit, qualified, times, PHASE, expectedPins, kernel)
    states = [{'T': r['issueAt'], 'split': r['split'], 'C': qualified[r['issueAt']]['featureCash'],
               'S': qualified[r['issueAt']]['claims'], 'x': kernel.coordinates(audited[r['issueAt']])}
              for r in calendar]
    need(all(s['C'] > 0 for s in states), 'positive_origin_cash')
    paths = checked_paths(index, states, kernel.H)
    cached_index = lambda t, h: paths[t, h]
    train = [s for s in states if s['split'] == 'TRAIN']
    need(len(train) == 59, 'fixed_train')
    cv = kernel.cv_select(train, cached_index)
    prep = kernel.preprocessing([s['x'] for s in train])
    bandwidth = cv['selected']
    outcomes = []
    for target in states:
        if target['split'] == 'TRAIN':
            continue
        weights = kernel.weights([s['x'] for s in train], target['x'], prep, bandwidth)
        result = {'issueAt': target['T'], 'split': target['split'], 'claims': target['S'], 'horizons': {}}
        for h in kernel.H:
            truth = cached_index(target['T'], h)
            values = [kernel.scenario_values(cached_index(d['T'], h), d, target, 'claims_bounded') for d in train]
            cell = {'truthEndpoint': truth.terminal, 'truthMinimum': truth.minimum,
                    'zeroMinimumCRPSOverClaims': F(truth.minimum, target['S']), 'methods': {}}
            for method, ws in (('kernel_base', weights), ('bounded_uniform', [1] * len(train))):
                endpoint, minimum = [v[0] for v in values], [v[1] for v in values]
                cell['methods'][method] = {
                    'endpointCRPSOverClaims': kernel.crps(endpoint, ws, truth.terminal) / target['S'],
                    'minimumCRPSOverClaims': kernel.crps(minimum, ws, truth.minimum) / target['S'],
                    'endpointSamples': tuple(endpoint), 'minimumSamples': tuple(minimum),
                    'weights': tuple(ws), 'amountMarginals': {
                        q: {'endpointShortageProbability': kernel.cdf_less(endpoint, ws, q),
                            'minimumShortageProbability': kernel.cdf_less(minimum, ws, q)} for q in kernel.Q}}
            result['horizons'][h] = cell
        outcomes.append(result)
    primary = {}
    for split in ('CAL', 'DEV', 'POOLED_CAL_DEV'):
        selected = [r for r in outcomes if split == 'POOLED_CAL_DEV' or r['split'] == split]
        cells = [r['horizons'][86400] for r in selected]
        a = [c['methods']['kernel_base']['minimumCRPSOverClaims'] for c in cells]
        zero = [c['zeroMinimumCRPSOverClaims'] for c in cells]
        uniform = [c['methods']['bounded_uniform']['minimumCRPSOverClaims'] for c in cells]
        zero_deltas, uniform_deltas = [z - x for z, x in zip(zero, a)], [u - x for u, x in zip(uniform, a)]
        mean = lambda values: sum(values, F(0)) / len(values)
        primary[split] = {'n': len(cells), 'kernelCRPSOverClaims': mean(a),
                          'zeroMinimumCRPSOverClaims': mean(zero), 'uniformCRPSOverClaims': mean(uniform),
                          'pairedZeroMinusKernel': tuple(zero_deltas), 'pairedUniformMinusKernel': tuple(uniform_deltas),
                          'meanZeroMinusKernel': mean(zero_deltas), 'meanUniformMinusKernel': mean(uniform_deltas),
                          'strictImprovementOverZero': mean(zero_deltas) > 0,
                          'strictImprovementOverUniform': mean(uniform_deltas) > 0}
    return {'schema': 'aave-base-historical-research-evaluation-v1',
            'forecastTarget': 'physical_cash_not_native_holder_exit', 'calendarSHA256': CALENDAR_SHA256,
            'calendar': calendar, 'counts': {'TRAIN': 59, 'CAL': 29, 'DEV': 30},
            'CV': cv, 'frozenTrainingPreprocessing': prep, 'selectedBandwidth': bandwidth,
            'pathCellCount': len(paths), 'donorIssueTimes': tuple(d['T'] for d in train),
            'outcomes': outcomes, 'primary24hMinimum': primary,
            'zeroControlScope': 'minimum_marginal_only_no_endpoint_duration_or_path',
            'referenceStatus': 'other_2026_saved_references_unavailable_not_substituted',
            'supplementaryControlsStatus': 'raw_native_persistence_90day_empirical_deferred_not_data_unavailable',
            'evidenceStatus': 'research_development_no_blindness_validation_or_causal_claim'}
