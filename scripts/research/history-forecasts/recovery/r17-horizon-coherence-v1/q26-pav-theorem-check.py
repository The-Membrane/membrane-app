"""Exact Fraction checks for five-horizon equal-weight isotonic projection.
Synthetic mathematics only; no historical data or production source imports.
"""
from fractions import Fraction as F
from itertools import product
import hashlib
import json
from pathlib import Path
import time

GRID = tuple(F(k, 4) for k in range(5))

def pav(p):
    blocks = []
    for value in p:
        blocks.append([F(value), 1])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            s, n = blocks.pop()
            blocks[-1][0] += s
            blocks[-1][1] += n
    return tuple(max(F(0), min(F(1), s / n)) for s, n in blocks for _ in range(n))

def loss(p, y):
    return sum(((a-b)**2 for a, b in zip(p, y)), F(0))

def main():
    started = time.monotonic()
    inputs = tuple(product(GRID, repeat=5))
    projected = {p: pav(p) for p in inputs}
    labels = tuple((F(0),) * k + (F(1),) * (5-k) for k in range(6))
    brier_checks = 0
    projection_checks = 0
    for p, q in projected.items():
        assert all(F(0) <= x <= F(1) for x in q)
        assert all(a <= b for a, b in zip(q, q[1:]))
        assert pav(q) == q
        # Exact residual prefix KKT conditions: nonnegative prefix sums,
        # total zero, with complementary slackness at strict increases.
        prefix = F(0)
        for i, (a, b) in enumerate(zip(p, q)):
            prefix += a-b
            assert prefix >= 0
            if i == 4 or q[i] < q[i+1]:
                assert prefix == 0
        projection_checks += 1
        for y in labels:
            # Stronger projection inequality, not just nonincrease.
            assert loss(q, y) + loss(p, q) <= loss(p, y)
            brier_checks += 1
    # Exhaust EVERY coordinatewise-comparable ordered pair on the same grid.
    coordinate_pairs = tuple((a, b) for a in GRID for b in GRID if a <= b)
    order_checks = 0
    for pairs in product(coordinate_pairs, repeat=5):
        severe, mild = tuple(x[0] for x in pairs), tuple(x[1] for x in pairs)
        assert all(a <= b for a, b in zip(projected[severe], projected[mild]))
        order_checks += 1
    p = tuple(map(F, (0, 1, 0, 1, 1)))
    y = tuple(map(F, (0, 0, 0, 1, 1)))
    q = pav(p)
    assert q == (F(0), F(1, 2), F(1, 2), F(1), F(1))
    assert (p[2]-y[2])**2 == 0 and (q[2]-y[2])**2 == F(1, 4)
    assert loss(p, y) == 1 and loss(q, y) == F(1, 2)
    result = dict(complete=True, arithmetic='fractions.Fraction', grid=[str(x) for x in GRID],
                  vectors=projection_checks, nested_label_brier_checks=brier_checks,
                  all_coordinatewise_ordered_pairs=order_checks,
                  individual_H24_harm=dict(p=list(map(str,p)), labels=list(map(str,y)), projected=list(map(str,q)),
                                          H24_before='0', H24_after='1/4', total_before='1', total_after='1/2'),
                  elapsed_seconds=time.monotonic()-started,
                  source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()
