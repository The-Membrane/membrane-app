#!/usr/bin/env python3
"""Exact rational CDF oracle: synthetic mathematics only, no subject/data imports."""
from collections import Counter
from fractions import Fraction as F
import hashlib
import json
from pathlib import Path


def require(values):
    # An unavailable observation is an error, never an implicit zero.
    if not values or any(not isinstance(x, F) for x in values):
        raise ValueError('nonempty explicit Fraction observations required')


def median_absolute(values):
    require(values)
    a = sorted(abs(x) for x in values)
    n = len(a)
    return a[n//2] if n % 2 else (a[n//2-1] + a[n//2])/2


def ecdf(values, query):
    require(values)
    if not isinstance(query, F):
        raise ValueError('Fraction query required')
    return F(sum(x <= query for x in values), len(values))


def normalized(states):
    medians = {g: median_absolute(rows) for g, rows in states.items()}
    if any(m <= 0 for m in medians.values()):
        raise ValueError('strictly positive state median absolute depth required')
    return medians, {g: [z/medians[g] for z in rows] for g, rows in states.items()}


def predictions(states, query):
    medians, scaled = normalized(states)
    raw_pool = [x for rows in states.values() for x in rows]
    scaled_pool = [x for rows in scaled.values() for x in rows]
    rows = []
    for g in sorted(states):
        threshold = query/medians[g]
        a = ecdf(raw_pool, query)
        b = ecdf(scaled_pool, threshold)
        c = ecdf(scaled[g], threshold)
        # Within-state normalization cancels, including ties and positive depths.
        assert c == ecdf(states[g], query)
        rows.append(dict(state=g, query=str(query), median_abs=str(medians[g]),
                         A=str(a), B=str(b), C=str(c)))
    return rows


def distribution(values):
    return {x:F(n,len(values)) for x,n in Counter(values).items()}


def main():
    base = [F(-4),F(-2),F(-1),F(0),F(1,2)]
    null = {0:base, 1:[2*x for x in base]*3}
    medians, scaled = normalized(null)
    assert medians == {0:F(1),1:F(2)}
    # Equality of the full discrete distributions proves B=C for EVERY rational
    # query, not merely the printed grid; unequal sample counts do not change it.
    pool = [x for rows in scaled.values() for x in rows]
    for g in null:
        assert distribution(scaled[g]) == distribution(pool)
        assert sum(x > 0 for x in null[g]) == sum(x > 0 for x in scaled[g])
        assert sum(x == 0 for x in null[g]) == sum(x == 0 for x in scaled[g])
    null_table = []
    for query in [F(-9),F(-6),F(-4),F(-2),F(-3,2),F(-1),F(0),F(1,2),F(1),F(2)]:
        rows = predictions(null, query)
        assert all(r['B'] == r['C'] for r in rows)
        null_table.extend(rows)
    at = predictions(null,F(-3,2))
    assert [(r['A'],r['B'],r['C']) for r in at] == [('11/20','2/5','2/5'),('11/20','3/5','3/5')]
    # Inclusive ties are distinguishable from strict CDF values.
    assert ecdf(base,F(-2)) == F(2,5)
    assert ecdf(base,F(0)) == F(4,5)
    assert ecdf(base,F(1,2)) == F(1)
    assert ecdf([F(-1),F(-1),F(2)],F(-1)) == F(2,3)
    # Reject absent values instead of inventing observations or a zero scale.
    for invalid in [[],[F(-1),None],[F(0),F(0)]]:
        try:
            normalized({0:invalid})
        except ValueError:
            pass
        else:
            raise AssertionError('invalid or zero-scale library accepted')
    alternative = {0:[F(-4),F(-2),F(-1),F(1,2)],
                   1:[F(-8),F(-2),F(-1),F(1,2)]}
    assert normalized(alternative)[0] == {0:F(3,2),1:F(3,2)}
    alternative_table = predictions(alternative,F(-6))
    assert [(r['A'],r['B'],r['C']) for r in alternative_table] == [('1/8','1/8','0'),('1/8','1/8','1/4')]
    # Exact cancellation holds for any positive rational scale, beyond MAD.
    for g, values in alternative.items():
        for scale in [F(1,7),F(3,2),F(100)]:
            for query in [F(-8),F(-6),F(-2),F(0),F(1,2)]:
                assert ecdf([x/scale for x in values],query/scale) == ecdf(values,query)
    report = dict(status='EXACT_FRACTION_CHECKS_PASS',
                  scope='Only handcrafted rational libraries. No real data, random draws, fits, subject imports, or files written.',
                  null_counts={g:len(rows) for g,rows in null.items()},
                  null_all_queries_distribution_identity=True,
                  null_table=null_table, equal_MAD_shape_alternative=alternative_table,
                  script_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    print(json.dumps(report,indent=2))


if __name__ == '__main__':
    main()
