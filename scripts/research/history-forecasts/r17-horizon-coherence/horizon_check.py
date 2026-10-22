"""Independent exact five-horizon certificate checks; no producer/PAV import.

The oracle is the isotonic min/max interval-mean characterization. Inputs are
small, complete 5x5 grids only; saved-data transport and cohort selection are
outside this pure checker. No empirical arrays are decoded here.
"""
from fractions import Fraction
import math
import numpy as np


def need(ok, why):
    if not ok:
        raise ValueError(why)


def binary64_grid(grid):
    need(type(grid) is np.ndarray and grid.dtype == np.dtype('float64') and grid.shape == (5,5), 'exact binary64 5x5 grid')
    need(np.isfinite(grid).all() and np.all((grid >= 0) & (grid <= 1)), 'finite probability range')
    need(np.all(grid[:,1:] >= grid[:,:-1]), 'original barrier order')


def minmax_column(values):
    """q_i=max_{a<=i} min_{b>=i} average(p_a,...,p_b), independently."""
    need(len(values) == 5 and all(type(v) is float and math.isfinite(v) and 0 <= v <= 1 for v in values), 'five native binary64 probabilities')
    exact = tuple(Fraction.from_float(v) for v in values)
    means = {(a,b):sum(exact[a:b+1], Fraction(0))/(b-a+1) for a in range(5) for b in range(a,5)}
    return tuple(max(min(means[a,b] for b in range(i,5)) for a in range(i+1)) for i in range(5))


def fields(value, required):
    # Plain dataclasses and test certificates have explicit field dictionaries.
    need(hasattr(value, '__dict__') and set(vars(value)) == set(required), 'exact certificate fields')


def check_grid(original, candidate_result):
    """Refute altered cells, means, rounding, bounds, partitions or aliasing.

    This verifies checking leaves input untouched. A caller must separately
    retain a pre-producer snapshot to establish producer-side input immutability.
    """
    binary64_grid(original)
    before = original.tobytes()
    fields(candidate_result, ('probabilities','columns'))
    probabilities = candidate_result.probabilities
    need(type(probabilities) is np.ndarray and probabilities.dtype == np.dtype('float64') and
         probabilities.shape == (5,5) and not np.shares_memory(original, probabilities), 'fresh represented full grid')
    need(np.isfinite(probabilities).all() and np.all((probabilities >= 0) & (probabilities <= 1)), 'represented probability range')
    need(np.all(probabilities[1:,:] >= probabilities[:-1,:]) and
         np.all(probabilities[:,1:] >= probabilities[:,:-1]), 'both represented coordinate orders')
    need(type(candidate_result.columns) is tuple and len(candidate_result.columns) == 5, 'all five column certificates')
    ideals = []
    bounds = []
    for j,column in enumerate(candidate_result.columns):
        fields(column, ('exact_values','blocks','quantization_bound'))
        ideal = minmax_column([float(v) for v in original[:,j]])
        need(type(column.exact_values) is tuple and len(column.exact_values) == 5 and
             all(type(v) is Fraction for v in column.exact_values) and column.exact_values == ideal, 'independent exact ideal values')
        need(type(column.blocks) is tuple and 1 <= len(column.blocks) <= 5, 'complete block partition')
        position = 0
        for block in column.blocks:
            fields(block, ('start','stop','mean'))
            need(type(block.start) is int and type(block.stop) is int and block.start == position and
                 block.start < block.stop <= 5 and type(block.mean) is Fraction, 'ordered contiguous block')
            actual_mean = sum((Fraction.from_float(float(original[i,j])) for i in range(block.start,block.stop)), Fraction(0))/(block.stop-block.start)
            need(block.mean == actual_mean and all(ideal[i] == block.mean for i in range(block.start,block.stop)), 'block mean and original members')
            position = block.stop
        need(position == 5, 'all original cells covered once')
        expected = np.array([float(v) for v in ideal], dtype=np.float64)
        need(probabilities[:,j].tobytes() == expected.tobytes(), 'once-rounded represented cells')
        errors = tuple(Fraction.from_float(float(probabilities[i,j])) - ideal[i] for i in range(5))
        bound = sum((2*abs(e)+e*e for e in errors), Fraction(0))
        need(type(column.quantization_bound) is Fraction and column.quantization_bound == bound, 'exact quantization bound')
        ideals.append(ideal)
        bounds.append(bound)
    need(all(ideals[j][i] <= ideals[j+1][i] for j in range(4) for i in range(5)), 'ideal barrier order')
    need(original.tobytes() == before, 'checker input immutability')
    return {'verified':True,'ideal_columns':tuple(ideals),'quantization_bounds':tuple(bounds)}


def theorem_eligible(labels, valid=None):
    """Incomplete vectors are ineligible; nonnested observed labels are errors."""
    need(type(labels) is np.ndarray and labels.shape == (5,5) and labels.dtype.kind in 'biuf', 'five-horizon label grid')
    if valid is None:
        valid = np.ones(5,dtype=bool)
    need(type(valid) is np.ndarray and valid.shape == (5,) and valid.dtype == np.dtype('bool'), 'horizon label-valid flags')
    observed = labels[valid]
    need(np.isfinite(observed).all() and np.isin(observed,(0,1)).all() and
         np.all(observed[:,1:] >= observed[:,:-1]), 'observed binary barrier-ordered labels')
    for i in range(5):
        for j in range(i+1,5):
            if valid[i] and valid[j]:
                need(np.all(labels[i] <= labels[j]), 'observed nonnested first-hit labels')
    return bool(valid.all())


def check_losses(original, candidate_result, labels, valid=None):
    """Exact ideal theorem and represented-output bound, never clamp harm."""
    certificate = check_grid(original,candidate_result)
    if not theorem_eligible(labels,valid):
        return {'eligible':False,'columns':None}
    reports = []
    for j in range(5):
        p = tuple(Fraction.from_float(float(v)) for v in original[:,j])
        ideal = certificate['ideal_columns'][j]
        represented = tuple(Fraction.from_float(float(v)) for v in candidate_result.probabilities[:,j])
        y = tuple(Fraction(int(v)) for v in labels[:,j])
        original_loss = sum(((x-t)**2 for x,t in zip(p,y)),Fraction(0))
        ideal_loss = sum(((x-t)**2 for x,t in zip(ideal,y)),Fraction(0))
        represented_loss = sum(((x-t)**2 for x,t in zip(represented,y)),Fraction(0))
        displacement = sum(((x-q)**2 for x,q in zip(p,ideal)),Fraction(0))
        bound = certificate['quantization_bounds'][j]
        need(ideal_loss <= original_loss-displacement, 'exact ideal projection theorem')
        need(abs(represented_loss-ideal_loss) <= bound, 'represented quantization loss bound')
        reports.append({'original_loss':original_loss,'ideal_loss':ideal_loss,
                        'represented_loss':represented_loss,'represented_minus_original':represented_loss-original_loss,
                        'ideal_projection_displacement':displacement,'quantization_bound':bound})
    return {'eligible':True,'columns':tuple(reports)}
