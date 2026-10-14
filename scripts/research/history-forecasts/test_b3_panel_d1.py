#!/usr/bin/env python3
"""Unit tests for b3_panel_d1.py on synthetic data only (no dataset read).

  python3 -m unittest scripts/research/history-forecasts/test_b3_panel_d1.py -v
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b3_panel_d1 as D  # noqa: E402
import bg_gradient as G  # noqa: E402

H = {h: i for i, h in enumerate(G.HNAMES)}
X = {x: i for i, x in enumerate(G.SIZES)}


def synth_unit(segment, model_cells, rung_value, seg_pop, capped=()):
    """A results.json panel unit: model_cells {(x, h)} ship v2 with rung_value(x, h); every other x cell is a
    population cell with seg_pop(x, h) for the unit's segment. Returns (unit, asof_params)."""
    seg = D.S.SEG_IDS.index(segment)
    cells, ap = {}, {}
    for c in G.CELLS:
        pop = [0.0] * D.S.NSEG
        if c["kind"] == "x":
            pop[seg] = seg_pop(c["x"], c["h"])
            m = (c["x"], c["h"]) in model_cells
            cp = c["x"] in capped
            v = None if cp else rung_value(c["x"], c["h"])
            cells[c["id"]] = {"rung": "v2" if m else None, "capped": cp, "p": None,
                              "rung_values": {r: (v if m else 0.5) for r in D.S.RUNGS}}
        else:
            cells[c["id"]] = {"rung": None, "capped": False, "p": None, "rung_values": {}}
        ap[f"{c['id']}:v2"] = {"seg_pop": pop}
    return {"unit": 0, "rank": 1, "segment": segment, "cells": cells}, ap


class TestMaskedFix(unittest.TestCase):
    def test_cell_mask_equals_masked_fix_when_mask_is_per_x(self):
        rng = np.random.default_rng(7)
        for _ in range(200):
            P = rng.random((3, G.NH, G.NX))
            cap = rng.random((3, G.NX)) < 0.3
            ref = G.monotone_fix_masked(P, cap)
            got = D.monotone_fix_cells(P, np.broadcast_to(cap[:, None, :], P.shape))
            np.testing.assert_array_equal(np.isnan(ref), np.isnan(got))
            np.testing.assert_array_equal(np.nan_to_num(ref), np.nan_to_num(got))

    def test_masked_cells_take_no_part(self):
        P = np.full((G.NH, G.NX), 0.01)
        P[H["48h"], X[10]] = 0.9                       # left out: must not lift 7d x10
        P[H["7d"], X[25]] = 0.0001                     # left out: must not cap 7d x50
        mask = np.zeros_like(P, dtype=bool)
        mask[H["48h"], X[10]] = mask[H["7d"], X[25]] = True
        f = D.monotone_fix_cells(P[None], mask[None])[0]
        self.assertTrue(np.isnan(f[mask]).all())
        np.testing.assert_allclose(f[~mask], 0.01)


class TestD1Composite(unittest.TestCase):
    def setUp(self):
        # w3-like unit: v2 ships at 7d for x10, x25, x75, x90; x50_7d and every shorter horizon are population cells
        self.model_cells = {(x, "7d") for x in (10, 25, 75, 90)}
        mv = {10: 0.007, 25: 0.0053, 75: 0.0053, 90: 0.0053}
        pop = {10: 0.0648, 25: 0.0499, 50: 0.1115, 75: 0.0334, 90: 0.0288}
        self.unit, self.ap = synth_unit("w3", self.model_cells, lambda x, h: mv.get(x, 0.5),
                                        lambda x, h: pop[x] * (0.5 if h != "48h" else 1.0) if h != "7d" else pop[x])

    def test_population_lifts_model_under_old_rule_not_under_d1(self):
        comp, model, capx, _ = D.unit_grids(self.unit, self.ap)
        self.assertEqual(int(model.sum()), 4)
        self.assertAlmostEqual(comp[H["7d"], X[10]], 0.007)
        old = D.old_fix(comp, capx)
        new = D.d1_fix(comp, model, capx)
        self.assertAlmostEqual(old[H["7d"], X[10]], 0.0648)          # lifted by the 48h x10 population rate
        self.assertAlmostEqual(new[H["7d"], X[10]], 0.007)           # D1: model cells only
        self.assertAlmostEqual(old[H["7d"], X[50]], 0.0499)          # capped by model x25_7d, then lifted by 48h
        self.assertAlmostEqual(new[H["7d"], X[50]], 0.1115)          # D1: population cells only
        np.testing.assert_allclose(new[model], comp[model])          # model grid already monotone
        self.assertEqual(D.monotone_violations(new, model), 0)
        self.assertEqual(D.monotone_violations(new, ~model), 0)

    def test_population_capping_model_removed(self):
        # model x75_7d above the population x50_7d: the old rule caps it, D1 does not
        u, ap = synth_unit("w3", self.model_cells, lambda x, h: {10: 0.5, 25: 0.4, 75: 0.316, 90: 0.229}.get(x, 0.9),
                           lambda x, h: {10: 0.06, 25: 0.05, 50: 0.1115, 75: 0.03, 90: 0.02}[x])
        comp, model, capx, _ = D.unit_grids(u, ap)
        old = D.old_fix(comp, capx)
        new = D.d1_fix(comp, model, capx)
        self.assertAlmostEqual(old[H["7d"], X[75]], 0.1115)
        self.assertAlmostEqual(old[H["7d"], X[90]], 0.1115)
        self.assertAlmostEqual(new[H["7d"], X[75]], 0.316)
        self.assertAlmostEqual(new[H["7d"], X[90]], 0.229)

    def test_population_fixed_among_themselves_and_equal_to_old_without_model(self):
        pop = lambda x, h: 0.001 if (x, h) == (75, "6h") else 0.0008 - x * 1e-6   # noqa: E731  x75_6h too high
        u, ap = synth_unit("c3", set(), lambda x, h: 0.5, pop)
        comp, model, capx, _ = D.unit_grids(u, ap)
        old = D.old_fix(comp, capx)
        new = D.d1_fix(comp, model, capx)
        np.testing.assert_array_equal(old, new)
        self.assertAlmostEqual(new[H["6h"], X[75]], 0.0008 - 50e-6)
        self.assertEqual(D.monotone_violations(new, ~model), 0)

    def test_capped_cells_left_out(self):
        u, ap = synth_unit("w3", self.model_cells, lambda x, h: 0.01, lambda x, h: 0.02, capped=(90,))
        comp, model, capx, _ = D.unit_grids(u, ap)
        self.assertEqual(list(capx), [False, False, False, False, True])
        new = D.d1_fix(comp, model, capx)
        self.assertTrue(np.isnan(new[:, X[90]]).all())
        self.assertFalse(np.isnan(new[:, :X[90]]).any())

    def test_cap_must_be_per_x(self):
        self.unit["cells"]["x90_1h"]["capped"] = True
        with self.assertRaises(SystemExit):
            D.unit_grids(self.unit, self.ap)


class TestDisplayLabel(unittest.TestCase):
    def test_tie_route(self):
        for cell, seg in D.TIE_ROUTE:
            self.assertEqual(D.display_label(cell, seg, "HIGH"), ("MEDIUM", "tie with v2"))
            self.assertEqual(D.display_label(cell, seg, "MEDIUM"), ("MEDIUM", ""))
        for cell, seg in D.HIGH_SHOWN:
            self.assertEqual(D.display_label(cell, seg, "HIGH"), ("HIGH", ""))
        self.assertEqual(D.display_label("x10_24h", "w3", "HIGH"), ("HIGH", ""))   # label is per (cell, segment)

    def test_tie_route_from_results(self):
        lab = {("a", "w1"): "HIGH", ("b", "w1"): "HIGH", ("c", "w2"): "HIGH", ("d", "w2"): "MEDIUM"}
        cells = {"a": {"w1": {"shipped": "v2", "flags": {"v2": {}}}},
                 "b": {"w1": {"shipped": "v3", "flags": {"v3": {"v2": False}}}},
                 "c": {"w2": {"shipped": "v3s", "flags": {"v3s": {"v2": True}}}},
                 "d": {"w2": {"shipped": "v3s", "flags": {"v3s": {"v2": False}}}}}
        self.assertEqual(D.tie_route_from_results(cells, lab), [("b", "w1")])


if __name__ == "__main__":
    unittest.main()
