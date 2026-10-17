"""Synthetic tests for r115_depositor_cash pure pieces (no real data)."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r115_depositor_cash as M  # noqa: E402


def test_frac_from_survival_marginals():
    rng = np.random.default_rng(1)
    P = np.array([[0.3, 0.2, 0.1, 0.05, 0.02], [0.0, 0.0, 0.0, 0.0, 0.0], [1.0, 1.0, 1.0, 1.0, 1.0]])
    s = rng.random((200_000, 3))
    f = M.frac_from_survival(s, P)
    for k, x in enumerate(M.XS):
        assert abs(np.mean(f[:, 0] >= x) - P[0, k]) < 0.004
    assert (f[:, 1] == 0).all()
    assert (f[:, 2] >= 0.9).all() and (f[:, 2] <= 1.0).all()
    # piecewise uniform: mean of f in [0.10, 0.25) bucket is the midpoint
    b = (f[:, 0] >= 0.10) & (f[:, 0] < 0.25)
    assert abs(f[b, 0].mean() - 0.175) < 0.003


def test_frac_ties():
    P = np.array([[0.2, 0.2, 0.1, 0.1, 0.0]])
    s = np.array([[0.15], [0.05], [0.5]]).reshape(3, 1)
    f = M.frac_from_survival(s, P)
    assert 0.25 <= f[0, 0] < 0.5
    assert 0.75 <= f[1, 0] < 0.9
    assert f[2, 0] == 0


def test_outflow_draws_equals_dense_map():
    from scipy.special import ndtr
    rng = np.random.default_rng(5)
    m = 40
    P = np.sort(rng.random((m, 5)) * 0.4, axis=1)[:, ::-1]
    P[3] = 0.0
    P[4] = [0.5, 0.5, 0.2, 0.2, 0.2]
    bal = rng.random(m) * 1e6
    top = np.zeros(m)
    top[:5] = 1
    U = np.sqrt(0.2) * rng.standard_normal(3000)[:, None] + np.sqrt(0.8) * rng.standard_normal((3000, m))
    f = M.frac_from_survival(ndtr(-U), P)
    O, Ot = M.outflow_draws(U, P, bal, top)
    assert np.allclose(O, f @ bal, rtol=1e-10, atol=1e-6)
    assert np.allclose(Ot, f[:, :5] @ bal[:5], rtol=1e-10, atol=1e-6)


def test_copula_var_grid():
    p = np.full(50, 0.1)
    v = M.copula_var_grid(p)
    assert abs(v[0] - 50 * 0.09) < 1e-9
    assert np.all(np.diff(v) > 0)
    # simulate at rho = 0.3
    rng = np.random.default_rng(2)
    Z = rng.standard_normal(40_000)
    E = rng.standard_normal((40_000, 50))
    U = np.sqrt(0.3) * Z[:, None] + np.sqrt(0.7) * E
    from scipy.special import ndtr
    N = (ndtr(-U) <= 0.1).sum(axis=1)
    j = int(np.argmin(np.abs(M.RHO_GRID - 0.3)))
    assert abs(N.var() / v[j] - 1) < 0.05
    assert abs(M.solve_rho(N.var(), v) - 0.3) < 0.03


def test_solve_rho_bounds():
    v = np.linspace(1, 10, len(M.RHO_GRID))
    assert M.solve_rho(0.5, v) == 0.0
    assert M.solve_rho(20, v) == M.RHO_GRID[-1]


def test_dm_hln():
    rng = np.random.default_rng(3)
    d = rng.standard_normal(900) - 0.3
    st, p = M.dm_hln(d)
    assert st < 0 and p < 1e-6
    st2, p2 = M.dm_hln(rng.standard_normal(900))
    assert 0 < p2 < 1


def test_emp_baseline():
    ratio = np.linspace(0.5, 1.0, 800)
    cash = np.full(800, 100.0)
    q = M.emp_baseline(ratio, cash, 799, 1)
    assert q is not None and q[0] < q[1] < q[2] <= 100.0


if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            f()
            print("ok", k)
