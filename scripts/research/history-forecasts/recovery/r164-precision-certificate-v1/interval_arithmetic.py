"""Finite binary64 interval primitives. No payload I/O or statistical admission."""
from fractions import Fraction
import numpy as np


class IntervalError(ValueError):
    pass


class ZeroDenominator(IntervalError):
    """A denominator box includes zero: a finite ratio is not certified."""


def _validate_original_sequence(x):
    # Validate before NumPy can coerce a mixed int/float sequence to floats.
    if isinstance(x, (list, tuple)):
        for value in x:
            _validate_original_sequence(value)
    elif isinstance(x, np.ndarray):
        if x.dtype.kind not in 'biuf' or (x.dtype.kind == 'f' and x.dtype.itemsize > 8):
            raise IntervalError('nested array needs certified binary numeric conversion')
        if x.dtype.kind in 'iu':
            for value in x.flat:
                _validate_original_sequence(value)
    elif isinstance(x, (int, np.integer)) and not isinstance(x, (bool, np.bool_)):
        try:
            value = float(x)
        except OverflowError as e:
            raise IntervalError('integer endpoint outside binary64') from e
        if not np.isfinite(value) or int(value) != int(x):
            raise IntervalError('integer endpoint is not exactly binary64')


def _finite(x):
    _validate_original_sequence(x)
    raw = np.asarray(x)
    if raw.dtype.kind not in 'biuf':
        raise IntervalError('endpoints must be binary numeric values')
    try:
        with np.errstate(over='ignore', invalid='ignore'):
            a = np.asarray(x, dtype=np.float64)
    except (ValueError, OverflowError) as e:
        raise IntervalError('endpoint conversion failed') from e
    if not np.all(np.isfinite(a)):
        raise IntervalError('nonfinite endpoint or arithmetic overflow')
    if raw.dtype.kind in 'iu' and any(int(v) != int(w) for v, w in zip(raw.flat, a.flat)):
        raise IntervalError('integer endpoint is not exactly binary64')
    if raw.dtype.kind == 'f' and raw.dtype.itemsize > 8:
        raise IntervalError('wider endpoints need a separately certified conversion')
    return a


def _out(x, direction, exact=False):
    x = _finite(x)
    with np.errstate(over='ignore', invalid='ignore'):
        y = np.where(exact, x, np.nextafter(x, direction))
    return _finite(y)


class Interval:
    """Closed box. Separate occurrences are independent unless a proof says otherwise."""
    def __init__(self, lo, hi=None):
        lo, hi = np.broadcast_arrays(_finite(lo), _finite(lo if hi is None else hi))
        if np.any(lo > hi):
            raise IntervalError('reversed interval')
        self.lo, self.hi = lo.copy(), hi.copy()

    @staticmethod
    def cast(x):
        return x if isinstance(x, Interval) else Interval(x)

    def __neg__(self):
        return Interval(-self.hi, -self.lo)

    def __add__(self, other):
        b = self.cast(other)
        al, ah, bl, bh = np.broadcast_arrays(self.lo, self.hi, b.lo, b.hi)
        # Adding exact zero and cancelling two exact opposite points are proofs.
        ident = ((al == 0) & (ah == 0)) | ((bl == 0) & (bh == 0))
        cancel = (al == ah) & (bl == bh) & (al == -bl)
        with np.errstate(over='ignore', invalid='ignore'):
            lo, hi = al + bl, ah + bh
        return Interval(_out(lo, -np.inf, ident | cancel),
                        _out(hi, np.inf, ident | cancel))

    __radd__ = __add__

    def __sub__(self, other):
        return self + (-self.cast(other))

    def __rsub__(self, other):
        return self.cast(other) - self

    def __mul__(self, other):
        b = self.cast(other)
        al, ah, bl, bh = np.broadcast_arrays(self.lo, self.hi, b.lo, b.hi)
        az, bz = (al == 0) & (ah == 0), (bl == 0) & (bh == 0)
        aunit = (al == ah) & (np.abs(al) == 1)
        bunit = (bl == bh) & (np.abs(bl) == 1)
        exact = az | bz | aunit | bunit
        with np.errstate(over='ignore', invalid='ignore', under='ignore'):
            products = np.stack([al * bl, al * bh, ah * bl, ah * bh])
        _finite(products)
        return Interval(_out(products.min(axis=0), -np.inf, exact),
                        _out(products.max(axis=0), np.inf, exact))

    __rmul__ = __mul__

    def __truediv__(self, other):
        b = self.cast(other)
        al, ah, bl, bh = np.broadcast_arrays(self.lo, self.hi, b.lo, b.hi)
        if np.any((bl <= 0) & (bh >= 0)):
            raise ZeroDenominator('denominator interval includes zero')
        exact = ((al == 0) & (ah == 0)) | ((bl == bh) & (np.abs(bl) == 1))
        with np.errstate(over='ignore', invalid='ignore', under='ignore', divide='ignore'):
            values = np.stack([al / bl, al / bh, ah / bl, ah / bh])
        _finite(values)
        return Interval(_out(values.min(axis=0), -np.inf, exact),
                        _out(values.max(axis=0), np.inf, exact))

    def __rtruediv__(self, other):
        return self.cast(other) / self

    def square(self):
        """Dependency-aware square, not independent multiplication of a box by itself."""
        cross = (self.lo <= 0) & (self.hi >= 0)
        amin = np.minimum(np.abs(self.lo), np.abs(self.hi))
        amax = np.maximum(np.abs(self.lo), np.abs(self.hi))
        with np.errstate(over='ignore', invalid='ignore', under='ignore'):
            lo, hi = amin * amin, amax * amax
        lo = np.where(cross, 0.0, lo)
        exactlo = cross | (amin == 0) | (amin == 1)
        exacthi = (amax == 0) | (amax == 1)
        return Interval(np.maximum(0, _out(lo, -np.inf, exactlo)),
                        _out(hi, np.inf, exacthi))

    def sum(self, axis=None):
        """Every accumulation is outward, never np.sum followed by one ulp."""
        lo, hi = self.lo, self.hi
        if axis is None:
            lo, hi = lo.ravel(), hi.ravel()
            axis = 0
        lo, hi = np.moveaxis(lo, axis, 0), np.moveaxis(hi, axis, 0)
        total = Interval(np.zeros(lo.shape[1:]))
        for i in range(lo.shape[0]):
            total = total + Interval(lo[i], hi[i])
        return total

    def sqrt(self):
        if np.any(self.lo < 0):
            raise IntervalError('sqrt of negative interval')
        lo = np.empty(self.lo.shape)
        hi = np.empty(self.hi.shape)
        for index in np.ndindex(self.lo.shape):
            lo[index] = _sqrt_bound(float(self.lo[index]), False)
            hi[index] = _sqrt_bound(float(self.hi[index]), True)
        return Interval(lo, hi)


def _fraction(x):
    return Fraction(*float(x).as_integer_ratio())


def _sqrt_bound(x, upper):
    """Prove the endpoint square inequality exactly; fail if adjustment exceeds8 ulps."""
    if x == 0:
        return 0.0
    target = _fraction(x)
    y = float(np.sqrt(x))
    for _ in range(9):
        q = _fraction(y) ** 2
        if (q >= target) if upper else (q <= target):
            return y
        y = float(np.nextafter(y, np.inf if upper else -np.inf))
        _finite(y)
    raise IntervalError('sqrt inequality not proved within adjustment limit')


def sample_sd(values, axis=0, center=0.0):
    """Enclose sample SD using an exact-real fixed-center identity.

    Only this known variance is intersected with [0,infinity). Signed covariance
    combinations must use ordinary interval arithmetic, with no such clipping.
    """
    x = Interval.cast(values)
    center = float(_finite(center))
    if x.lo.ndim == 0:
        raise IntervalError('sample SD needs a replicate axis')
    axis = int(axis)
    if not -x.lo.ndim <= axis < x.lo.ndim:
        raise IntervalError('invalid replicate axis')
    axis %= x.lo.ndim
    n = x.lo.shape[axis]
    if n < 2:
        raise IntervalError('sample SD needs at least two replicates')
    # A constant point vector is a proved zero; constant nonpoint boxes are not.
    first = np.take(x.lo, 0, axis=axis)
    constant = np.all(x.lo == x.hi, axis=axis) & np.all(
        x.lo == np.expand_dims(first, axis), axis=axis)
    c = np.expand_dims(constant, axis)
    # Remove proved constant columns before arithmetic, avoiding spurious overflow.
    work = Interval(np.where(c, center, x.lo), np.where(c, center, x.hi))
    y = work - center
    v = (y.square().sum(axis) - y.sum(axis).square() / n) / (n - 1)
    if np.any(v.hi < 0):
        raise IntervalError('negative upper bound for a known variance')
    lo = np.where(constant, 0.0, np.maximum(v.lo, 0.0))
    hi = np.where(constant, 0.0, v.hi)
    return Interval(lo, hi).sqrt()
