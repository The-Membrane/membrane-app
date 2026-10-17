import unittest

import numpy as np

import r72c_stress as M


class T(unittest.TestCase):
    def test_step_integral_and_mean(self):
        ts, v = [10, 20, 30], [1.0, 3.0, 0.0]
        self.assertEqual(list(M.step_integral(ts, v, [5, 10, 15, 25, 40])), [0, 0, 5, 25, 40])
        self.assertAlmostEqual(M.window_mean(ts, v, [30], width=20)[0], 2.0)

    def test_step_point_strict(self):
        ts, v = [10, 20], [1.0, 2.0]
        self.assertEqual(list(M.step_point(ts, v, [10, 11, 20, 21])), [0, 1, 1, 2])
        self.assertEqual(list(M.step_point(ts, v, [10, 20], strict=False)), [1, 2])

    def test_qrt_window_integral(self):
        legs = [(100, 50.0), (130, -20.0), (160, -30.0)]
        self.assertAlmostEqual(M.qrt_window_integral(legs, 0, 200), 50 * 30 + 30 * 30)
        self.assertAlmostEqual(M.qrt_window_integral(legs, 120, 140), 50 * 10 + 30 * 10)

    def test_hourly_subtract(self):
        W = np.array([10.0, 5.0])
        out = M.hourly_subtract(W, 0, [10, 3700, 99999], [4.0, 5.0, 1.0])
        self.assertEqual(list(out), [6.0, 0.0])
        self.assertEqual(list(W), [10.0, 5.0])


if __name__ == "__main__":
    unittest.main()
