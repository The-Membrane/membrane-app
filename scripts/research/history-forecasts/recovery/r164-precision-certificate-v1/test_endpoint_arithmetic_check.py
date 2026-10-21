import unittest
from fractions import Fraction as F
import numpy as np
from endpoint_arithmetic_check import check_endpoints, check_native_examples, reduction_error, fraction_bounds


class EndpointTests(unittest.TestCase):
    def test_exhaustive_grid_and_loss_endpoints(self):
        r=check_endpoints()
        self.assertEqual(r['nonnegative_float16_patterns_0_through_1'],15361)
        self.assertEqual(r['binary_label_loss_endpoints_checked'],61444)
        self.assertEqual(r['max_loss_integer_coefficient'],1<<50)
        self.assertEqual(r['signed_zero_representations_checked'],1)
        self.assertEqual(r['signed_zero_loss_endpoints_checked'],4)

    def test_generic_directed_rational_conversion(self):
        for x in [F(0),F(1),F(-1),F(1,3),F(-1,3),F(1,2**1075),F(-1,2**1075),
                  F(2**53+1),F(-(2**53+1)),reduction_error(1000000)]:
            lo,hi=fraction_bounds(x)
            self.assertLessEqual(F(*lo.as_integer_ratio()),x)
            self.assertGreaterEqual(F(*hi.as_integer_ratio()),x)
            if F(*lo.as_integer_ratio())==x:self.assertEqual(lo,hi)
        with self.assertRaises(ValueError):fraction_bounds(F(10)**400)

    def test_unequal_groups_signed_cancellation(self):
        r=check_native_examples()
        self.assertEqual(r['native_bincount_dtype'],'float64')
        self.assertEqual(r['synthetic_group_checks'],42)
        self.assertTrue(r['all_examples_within_conditional_bound'])

    def test_gamma_bound_is_exact_rational_not_epsilon(self):
        self.assertEqual(reduction_error(0),0);self.assertEqual(reduction_error(1),0)
        self.assertEqual(reduction_error(2),F(2,2**53-1))
        self.assertEqual(reduction_error(7),F(42,2**53-6))
        for n in [-1,True,1.5,2**53+1]:
            with self.assertRaises(ValueError):reduction_error(n)

    def test_structural_pair_difference_extremes(self):
        coefficients=[0,1,2**25-1,2**49+1,2**50]
        for a in coefficients:
            for b in coefficients:
                value=np.float64(a)*2.**-50-np.float64(b)*2.**-50
                self.assertEqual(F(*float(value).as_integer_ratio()),F(a-b,2**50))


if __name__=='__main__':unittest.main()
