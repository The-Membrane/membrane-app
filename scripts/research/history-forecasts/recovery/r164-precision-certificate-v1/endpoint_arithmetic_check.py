"""Synthetic finite-grid facts and explicitly conditional reduction-error proof.

No dataset/matrix I/O. Exhaustion verifies the stated grid and loss expressions;
synthetic bincount examples are not a proof of its undocumented implementation.
"""
import argparse
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import sys
import time
import numpy as np

GRID = 1 << 25
UNIT_ROUNDOFF_DENOMINATOR = 1 << 53


def fraction_bounds(value):
    """Finite binary64 lower/upper bounds proved by exact rational comparison."""
    value = Fraction(value)
    try:
        nearest = float(value)
    except OverflowError as e:
        raise ValueError('rational outside finite binary64') from e
    if not np.isfinite(nearest):
        raise ValueError('rational outside finite binary64')
    represented = Fraction(*nearest.as_integer_ratio())
    lo = float(np.nextafter(nearest, -np.inf)) if represented > value else nearest
    hi = float(np.nextafter(nearest, np.inf)) if represented < value else nearest
    if not np.isfinite(lo) or not np.isfinite(hi):
        raise ValueError('no finite rational enclosure')
    assert Fraction(*lo.as_integer_ratio()) <= value <= Fraction(*hi.as_integer_ratio())
    return lo, hi


def reduction_error(n):
    """Absolute error bound for n exact grid2^-50 terms of magnitude<=1.

    CONDITIONAL PROOF: n leaves and n-1 binary64 round-to-nearest additions,
    with each leaf-to-root path length<=n-1. Standard gamma_(n-1)*sumabs is
    <=n(n-1)/(2**53-n+1). Applies to signed terms as an absolute bound.
    Grid2^-50 leaves/intermediates are normal or exact zero, preventing an
    underflow exception to the usual relative-error addition model. No overflow,
    cancellation-relative bound or empirical native-order claim is assumed.
    """
    if isinstance(n, bool) or not isinstance(n, int) or not 0 <= n < (1 << 53) + 1:
        raise ValueError('n outside the proved reduction domain')
    return Fraction(n * (n - 1), UNIT_ROUNDOFF_DENOMINATOR - n + 1)


def check_endpoints():
    bits = np.arange(0x3c01, dtype=np.uint16)
    p = bits.view(np.float16)
    prev = np.nextafter(p, np.float16(-np.inf)).astype(np.float64)
    nxt = np.nextafter(p, np.float16(np.inf)).astype(np.float64)
    pf = p.astype(np.float64)
    lower = np.maximum(0., (prev + pf) / 2)
    upper = np.minimum(1., (pf + nxt) / 2)
    losses = {(y, side): (v - y) ** 2 for y in (0, 1)
              for side, v in [('lo', lower), ('hi', upper)]}
    max_coefficient = 0
    for i in range(len(p)):
        point = Fraction(*float(pf[i]).as_integer_ratio())
        # Independent rational adjacent-midpoint reference, not rounded float sums.
        a = max(Fraction(0), (Fraction(*float(prev[i]).as_integer_ratio()) + point) / 2)
        b = min(Fraction(1), (point + Fraction(*float(nxt[i]).as_integer_ratio())) / 2)
        for side, rational, endpoint in [('lo', a, lower[i]), ('hi', b, upper[i])]:
            assert Fraction(*float(endpoint).as_integer_ratio()) == rational
            coefficient = rational * GRID
            assert coefficient.denominator == 1 and 0 <= coefficient <= GRID
            for y in (0, 1):
                exact_loss = (rational - y) ** 2
                actual = Fraction(*float(losses[y, side][i]).as_integer_ratio())
                assert actual == exact_loss
                loss_coefficient = exact_loss * (1 << 50)
                assert loss_coefficient.denominator == 1
                assert 0 <= loss_coefficient <= (1 << 50)
                max_coefficient = max(max_coefficient, int(loss_coefficient))
    negative_zero = np.array([0x8000], dtype=np.uint16).view(np.float16)
    assert np.signbit(negative_zero[0]) and float(negative_zero[0]) == 0.
    previous = np.nextafter(negative_zero, np.float16(-np.inf)).astype(np.float64)
    following = np.nextafter(negative_zero, np.float16(np.inf)).astype(np.float64)
    neg_lo = float(np.maximum(0., (previous + negative_zero.astype(float)) / 2)[0])
    neg_hi = float(np.minimum(1., (negative_zero.astype(float) + following) / 2)[0])
    assert Fraction(*neg_lo.as_integer_ratio()) == 0
    assert Fraction(*neg_hi.as_integer_ratio()) == Fraction(1, GRID)
    for endpoint in [neg_lo, neg_hi]:
        for label in (0, 1):
            actual = float((np.array(endpoint) - label) ** 2)
            assert Fraction(*actual.as_integer_ratio()) == (Fraction(*endpoint.as_integer_ratio()) - label) ** 2
    return {'nonnegative_float16_patterns_0_through_1': len(p),
            'signed_zero_representations_checked': 1, 'signed_zero_loss_endpoints_checked': 4,
            'clamped_midpoints_checked': 2 * len(p), 'binary_label_loss_endpoints_checked': 4 * len(p),
            'endpoint_integer_grid_denominator': GRID, 'loss_integer_grid_denominator': 1 << 50,
            'max_loss_integer_coefficient': max_coefficient,
            'structural_difference_proof': 'Each loss is integer k*2^-50 with 0<=k<=2^50. Any pair difference has |k1-k2|<=2^50, at most51significand bits, hence exactly binary64. This is a structural proof, not pair enumeration.'}


def check_native_examples():
    """Finite examples only. The addition/reduction contract remains an assumption."""
    examples = []
    for n in [0, 1, 2, 7, 31, 257, 4096]:
        i = np.arange(n, dtype=np.int64)
        groups = (i * 7) % 5
        # Signed exact grid terms, unequal and empty group support.
        coefficients = (((i * 104729) % (1 << 25)) ** 2) * np.where(i % 2, -1, 1)
        values = coefficients.astype(np.float64) * 2.**-50
        summed = np.bincount(groups, weights=values, minlength=6)
        if n:
            assert summed.dtype == np.dtype(np.float64)
        else:
            # NumPy's empty weighted input returns integer zeros on this runtime.
            empty_dtype = str(summed.dtype)
            assert np.all(summed == 0)
        for g in range(6):
            take = groups == g
            count = int(take.sum())
            exact = Fraction(sum(int(x) for x in coefficients[take]), 1 << 50)
            error = abs(Fraction(*float(summed[g]).as_integer_ratio()) - exact)
            bound = reduction_error(count)
            assert error <= bound
            examples.append({'n': count, 'exact_error': str(error), 'proved_conditional_bound': str(bound)})
    return {'native_bincount_dtype': str(summed.dtype), 'empty_input_native_dtype': empty_dtype, 'empty_input_exact_zero': True,
            'synthetic_group_checks': len(examples),
            'all_examples_within_conditional_bound': True,
            'contract_required': 'nonempty weighted-input results binary64 (empty input is exact integer zero or must be explicitly normalized); exact leaves lie on grid2^-50, magnitude<=1 (no underflow); each output reduces its admitted leaves using no more than n-1 round-to-nearest binary64 additions, no wider-to-narrower hidden transform, no overflow; addition paths length<=n-1. Native examples do not establish that implementation contract.',
            'documentation_scope': 'NumPy weighted bincount semantics are used; no stronger reduction-order guarantee is attributed to NumPy documentation.'}


def pin(path):
    path = Path(path).resolve(); b = path.read_bytes()
    return {'path': str(path), 'size': len(b), 'sha256': hashlib.sha256(b).hexdigest()}


def self_check():
    started = time.monotonic()
    if np.dtype(np.float64).itemsize != 8 or np.finfo(np.float64).nmant != 52 or sys.float_info.rounds != 1:
        raise ValueError('requires binary64 and reported round-to-nearest runtime')
    # A finite check of tie-to-even and default scalar rounding, not a platform proof.
    assert np.float64(1) + np.float64(2.**-53) == 1
    result = {'schema': 'synthetic-r164-endpoint-arithmetic-v1', 'complete': True,
              'scope': 'Synthetic finite domain only. No matrices or historical rows inspected.',
              'endpoints': check_endpoints(), 'native_examples': check_native_examples(),
              'binary64_contract': 'IEEE754 correctly rounded basic add/subtract/multiply/divide in round-to-nearest mode; no overflow. This requirement is explicit, not proved solely by synthetic testing.',
              'runtime': {'python': sys.version, 'numpy': np.__version__, 'reported_rounding_mode': sys.float_info.rounds,
                          'executable': pin(sys.executable), 'numpy_init': pin(np.__file__)},
              'source': pin(__file__),
              'source_pins': {name: pin(Path(__file__).with_name(name)) for name in
                              ['endpoint_arithmetic_check.py', 'test_endpoint_arithmetic_check.py',
                               'interval_arithmetic.py', 'test_interval_arithmetic.py']}}
    result['elapsed_seconds'] = time.monotonic() - started
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--self-check', action='store_true', required=True)
    parser.parse_args()
    print(json.dumps(self_check(), sort_keys=True, allow_nan=False))
