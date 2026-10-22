"""Pure checkpoint views of decoded, externally authenticated published reports.

This creates derived views, never original checkpoint bytes or fitted states.
No file I/O, fitting, prediction, filtering or probability substitution occurs.
"""
from copy import deepcopy
import math


def _integer(value, name, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(name)
    return value


def derive_history_view(intraday, step, *, expected_series=42,
                        expected_rows=104310, expected_origins=2619,
                        expected_quarter_fits=806):
    """Join intraday cluster to step series; retain each series' source order.

    Counts are configurable only for source qualification fixtures. Callers must
    authenticate both original reports before invoking this in historical work.
    Unique replay keys use the original row's (series, i0, T, k).
    """
    for value, name in ((expected_series, 'expected_series'),
                        (expected_rows, 'expected_rows'),
                        (expected_origins, 'expected_origins'),
                        (expected_quarter_fits, 'expected_quarter_fits')):
        _integer(value, name, 1)
    if not isinstance(intraday, dict) or not isinstance(step, dict):
        raise ValueError('report_object_required')
    rows, series = intraday.get('rows'), step.get('series')
    if not isinstance(rows, list) or not isinstance(series, list):
        raise ValueError('report_lists_required')
    quarter_counts = {}
    for entry in series:
        if not isinstance(entry, dict):
            raise ValueError('step_entry_required')
        identity = entry.get('series')
        if not isinstance(identity, str) or not identity or identity in quarter_counts:
            raise ValueError('step_identity_invalid_or_duplicate')
        quarter_counts[identity] = _integer(entry.get('quarter_fits'), 'quarter_fits', 1)
    if len(quarter_counts) != expected_series:
        raise ValueError('series_count_mismatch')
    if sum(quarter_counts.values()) != expected_quarter_fits:
        raise ValueError('quarter_count_mismatch')
    if len(rows) != expected_rows:
        raise ValueError('row_count_mismatch')
    grouped = {identity: [] for identity in quarter_counts}
    keys, origins, row_identities, cluster_identities = set(), set(), {}, {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('row_object_required')
        cluster, identity = row.get('cluster'), row.get('series')
        if not isinstance(cluster, str) or cluster not in grouped:
            raise ValueError('row_cluster_mismatch')
        if not isinstance(identity, str) or not identity:
            raise ValueError('row_series_required')
        if row_identities.setdefault(identity, cluster) != cluster or cluster_identities.setdefault(cluster, identity) != identity:
            raise ValueError('ambiguous_series_cluster_mapping')
        origin = _integer(row.get('i0'), 'i0')
        horizon = _integer(row.get('T'), 'T', 1)
        level = _integer(row.get('k'), 'k')
        if horizon not in (24, 72, 168, 720) or not 0 <= level <= 9:
            raise ValueError('original_cell_domain_required')
        for field in ('p_garch', 'p_fH', 'p_rec12', 'p_base12'):
            probability = row.get(field)
            if type(probability) not in (int, float):
                raise ValueError(field + '_numeric_required')
            try:
                valid = math.isfinite(probability) and 0 <= probability <= 1
            except OverflowError:
                valid = False
            if not valid:
                raise ValueError(field + '_invalid')
        if type(row.get('y')) not in (int, float) or row['y'] not in (0, 1):
            raise ValueError('binary_label_required')
        key = (identity, origin, horizon, level)
        if key in keys:
            raise ValueError('duplicate_replay_key')
        keys.add(key)
        origins.add((identity, origin))
        grouped[cluster].append(deepcopy(row))
    if any(not group for group in grouped.values()):
        raise ValueError('identity_set_mismatch')
    if len(origins) != expected_origins:
        raise ValueError('origin_count_mismatch')
    provenance = dict(kind='derived_published_report_checkpoint_view',
                      original_checkpoint_bytes_recovered=False,
                      fitted_states_recovered=False,
                      external_input_authentication_required=True,
                      no_fitting_or_probability_substitution=True)
    return dict(provenance=provenance, checkpoints={
        identity: dict(result=dict(rows=grouped[identity], quarter_fits=count))
        for identity, count in quarter_counts.items()})
