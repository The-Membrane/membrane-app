"""Pure exact five-horizon isotonic projection — CODEX CONTINUATION.

Rows are H=(6,12,24,72,168); columns are barriers=(-.40,-.20,-.10,-.05,-.02).
This kernel supplies no eligibility, label, scoring, fitting or execution authority.
Exact projection and its once-rounded representation are distinct objects.
"""
from dataclasses import dataclass
from fractions import Fraction
from typing import Sequence

import numpy as np


HORIZONS = (6, 12, 24, 72, 168)
BARRIERS = (-.40, -.20, -.10, -.05, -.02)


@dataclass(frozen=True)
class PoolBlock:
    start: int
    stop: int
    mean: Fraction


@dataclass(frozen=True)
class ColumnProjection:
    exact_values: tuple[Fraction, ...]
    blocks: tuple[PoolBlock, ...]
    quantization_bound: Fraction


@dataclass(frozen=True)
class GridProjection:
    probabilities: np.ndarray
    columns: tuple[ColumnProjection, ...]


def project_column(values: Sequence[float]) -> ColumnProjection:
    """Equal-weight PAV on exactly five binary64 probabilities, without rounding means.

Adjacent equal-mean blocks are retained separately; only strict inversions pool.
Block boundaries are inclusive start/exclusive stop in ascending horizon order.
The error bound concerns exact loss of represented versus ideal probabilities,
not floating-point score accumulation or individual-horizon improvement.
"""
    if len(values) != 5:
        raise ValueError('five horizon probabilities required')
    original = []
    for value in values:
        if not isinstance(value, (float, np.float64)):
            raise ValueError('binary64 probability required')
        v = float(value)
        if not np.isfinite(v) or not 0.0 <= v <= 1.0:
            raise ValueError('finite probability in [0,1] required')
        original.append(Fraction.from_float(v))
    # Each stack member is (start, stop, exact sum). Unit weights are intentional.
    stack: list[tuple[int, int, Fraction]] = []
    for i, value in enumerate(original):
        stack.append((i, i + 1, value))
        while len(stack) >= 2:
            a, b = stack[-2:]
            if a[2] / (a[1] - a[0]) <= b[2] / (b[1] - b[0]):
                break
            stack[-2:] = [(a[0], b[1], a[2] + b[2])]
    blocks = tuple(PoolBlock(start, stop, total / (stop - start))
                   for start, stop, total in stack)
    exact = tuple(block.mean for block in blocks
                  for _ in range(block.start, block.stop))
    bound = Fraction(0)
    for value in exact:
        error = Fraction.from_float(float(value)) - value
        bound += 2 * abs(error) + error * error
    return ColumnProjection(exact, blocks, bound)


def project_grid(grid: np.ndarray) -> GridProjection:
    """Project horizon columns, preserving an already barrier-ordered 5×5 grid.

No coercion, clipping, tolerance-based repair or input mutation is performed.
Only final exact block means are rounded to binary64, once per output value.
"""
    if not isinstance(grid, np.ndarray) or grid.dtype != np.dtype('float64'):
        raise ValueError('float64 ndarray required')
    if grid.shape != (5, 5):
        raise ValueError('five-horizon by five-barrier grid required')
    if not np.isfinite(grid).all() or np.any(grid < 0) or np.any(grid > 1):
        raise ValueError('finite probabilities in [0,1] required')
    if np.any(grid[:, 1:] < grid[:, :-1]):
        raise ValueError('input barrier order violated')
    columns = tuple(project_column(grid[:, j]) for j in range(5))
    represented = np.empty((5, 5), dtype=np.float64)
    for j, column in enumerate(columns):
        represented[:, j] = [float(x) for x in column.exact_values]
    if (not np.isfinite(represented).all() or np.any(represented < 0)
            or np.any(represented > 1) or np.any(represented[1:] < represented[:-1])
            or np.any(represented[:, 1:] < represented[:, :-1])):
        raise AssertionError('represented projection structural invariant failed')
    return GridProjection(represented, columns)
