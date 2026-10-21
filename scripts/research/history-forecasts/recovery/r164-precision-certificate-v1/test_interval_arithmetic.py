import unittest
from fractions import Fraction as F
import numpy as np
from interval_arithmetic import Interval as I, IntervalError, ZeroDenominator, sample_sd


def q(x):
    return F(*float(x).as_integer_ratio())


def encloses(test, box, exact):
    test.assertLessEqual(q(box.lo), exact)
    test.assertGreaterEqual(q(box.hi), exact)


class CoreTests(unittest.TestCase):
    def test_four_corner_fraction_oracles(self):
        boxes = [(-2., -0.5), (-1., 3.), (0., 0.), (0.25, 0.75),
                 (np.nextafter(1., 0.), np.nextafter(1., 2.)), (1e-300, 2e-300)]
        for al, ah in boxes:
            for bl, bh in boxes:
                a, b = I(al, ah), I(bl, bh)
                for x in [q(al), q(ah)]:
                    for y in [q(bl), q(bh)]:
                        encloses(self, a+b, x+y)
                        encloses(self, a-b, x-y)
                        encloses(self, a*b, x*y)
                        if not bl <= 0 <= bh:
                            encloses(self, a/b, x/y)

    def test_broadcast_identities_and_nonpoint_dependency(self):
        x = I([-2., 0., 2.], [-1., 1., 3.])
        for z in [x+0, x*1, x/1, -(-x), 0+x]:
            np.testing.assert_array_equal(z.lo, x.lo)
            np.testing.assert_array_equal(z.hi, x.hi)
        z = x*0
        np.testing.assert_array_equal(z.lo, 0)
        np.testing.assert_array_equal(z.hi, 0)
        # x-x is not zero for independent nonpoint boxes.
        z = I(1., 2.)-I(1., 2.)
        self.assertLess(z.lo, 0); self.assertGreater(z.hi, 0)
        p = I(3.)-3.
        self.assertEqual(float(p.lo), 0); self.assertEqual(float(p.hi), 0)
        self.assertEqual((I([1., 2.])+np.array([[1.],[2.]])).lo.shape, (2,2))

    def test_subnormal_and_signed_underflow(self):
        tiny = np.nextafter(0., 1.)
        for x, y in [(tiny, .5), (-tiny, .5), (tiny, tiny)]:
            encloses(self, I(x)*y, q(x)*q(y))
        encloses(self, I(tiny)/2, q(tiny)/2)
        z = I(-tiny, tiny).square()
        self.assertEqual(float(z.lo), 0)
        encloses(self, z, q(tiny)**2)

    def test_sequential_cancellation_not_sum_one_ulp(self):
        values = [1e16, 1., -1e16, 2.**-100, -2.**-101]
        encloses(self, I(values).sum(), sum(map(q, values), F(0)))
        v = np.array([values, list(reversed(values))]).T
        z = I(v).sum(axis=0)
        for j in range(2):
            encloses(self, I(z.lo[j], z.hi[j]), sum(map(q, v[:,j]), F(0)))
        self.assertEqual(float(I([]).sum().lo), 0)

    def test_square_crossing_and_same_sign(self):
        for a,b in [(-3.,2.),(-3.,-2.),(2.,3.),(0.,0.),(-1.,1.)]:
            z=I(a,b).square()
            for x in [a,b,(a+b)/2]: encloses(self,z,q(x)**2)
            self.assertGreaterEqual(float(z.lo),0)
        self.assertEqual(float(I(-3.,2.).square().lo),0)

    def test_sqrt_exact_proof(self):
        for v in [0.,np.nextafter(0.,1.),1e-300,2.,np.nextafter(4.,0.),4.,1e300]:
            z=I(v).sqrt()
            self.assertLessEqual(q(z.lo)**2,q(v))
            self.assertGreaterEqual(q(z.hi)**2,q(v))
        self.assertEqual(float(I(0.).sqrt().hi),0)
        with self.assertRaises(IntervalError): I(-1.,2.).sqrt()

    def test_sample_sd_fraction_truth_and_unequal_values(self):
        for vals in [[0.,1.,2.],[1e12,1e12+1,1e12+3],[-2.,-1.,4.,8.]]:
            x=list(map(q,vals));n=len(x);v=(sum((a*a for a in x),F(0))-sum(x,F(0))**2/n)/(n-1)
            for c in [0., vals[0]]:
                s=sample_sd(I(vals),center=c)
                self.assertLessEqual(q(s.lo)**2,v);self.assertGreaterEqual(q(s.hi)**2,v)
        # Exact true variances at all corners of a small nonpoint box.
        z=sample_sd(I([0.,2.,4.],[1.,3.,5.]),center=2.)
        import itertools
        for vals in itertools.product([0.,1.],[2.,3.],[4.,5.]):
            x=list(map(q,vals));v=(sum((a*a for a in x),F(0))-sum(x,F(0))**2/3)/2
            self.assertLessEqual(q(z.lo)**2,v);self.assertGreaterEqual(q(z.hi)**2,v)

    def test_known_constant_and_zero_not_false_dependency(self):
        for v in [0.,1.,-1.,1e308]:
            z=sample_sd(I([v,v,v]))
            self.assertEqual(float(z.lo),0);self.assertEqual(float(z.hi),0)
        z=sample_sd(I([1.,1.,1.],[2.,2.,2.]))
        self.assertGreater(float(z.hi),0)
        z=sample_sd(I([[0.,1.],[0.,2.],[0.,3.]]))
        self.assertEqual(z.hi[0],0);encloses(self,I(z.lo[1],z.hi[1]),F(1))

    def test_signed_cgm_zero_crossing_not_clipped(self):
        z=I(1.,2.)+I(1.,2.)-I(3.)
        self.assertLess(float(z.lo),0);self.assertGreater(float(z.hi),0)
        neg=I(1.)+I(1.)-I(3.)
        self.assertLess(float(neg.hi),0)

    def test_input_conversion_is_not_an_unproved_rounding(self):
        for x in [2**53+1, np.uint64(2**63+1), F(1,3)]:
            with self.assertRaises(IntervalError): I(x)
        if np.dtype(np.longdouble).itemsize > 8:
            with self.assertRaises(IntervalError): I(np.longdouble(1.1))
        encloses(self, 1/I(3.), F(1,3))
        self.assertEqual(float(I(2**53).lo), 2**53)

    def test_mixed_sequences_validate_before_numpy_coercion(self):
        for x in [[2**53+1, 0.], (0., -(2**53+1)), [[0., 1.], [2**53+1, 0.]],
                  ((np.uint64(2**63+1), 0.),), [10**400, 0.]]:
            with self.assertRaises(IntervalError): I(x)
        with self.assertRaises(IntervalError): I([0., 1.], [2**53+1, 2.])
        self.assertEqual(I([[2**53, 0.], [1., -2**53]]).lo[0,0], 2**53)

    def test_nested_ndarrays_validate_before_outer_coercion(self):
        bads=[[np.array([2**53+1],dtype=np.int64),np.array([0.])],
              (np.array([-(2**53+1)],dtype=np.int64),np.array([0.])),
              ((np.array([np.iinfo(np.uint64).max],dtype=np.uint64),), (np.array([0.]),))]
        for x in bads:
            with self.assertRaises(IntervalError): I(x)
        with self.assertRaises(IntervalError): I(np.zeros((2,1)),bads[0])
        with self.assertRaises(IntervalError): I([np.array([F(1,3)],dtype=object),np.array([0.])])
        self.assertEqual(I([np.array([2**53],dtype=np.int64),np.array([0.])]).lo[0,0],2**53)

    def test_zero_ratio_domains_and_nonfinite_refusal(self):
        for b in [I(0.),I(-1.,0.),I(0.,1.),I(-1.,1.)]:
            with self.assertRaises(ZeroDenominator): I(0.)/b
        for op in [lambda:I(np.nan),lambda:I(np.inf),lambda:I(2.,1.),
                   lambda:I(1e308)*2.,lambda:I(1e308)+1e308,
                   lambda:I(np.finfo(float).max)*1.0000000000000002,
                   lambda:sample_sd(I([1.])),lambda:sample_sd(I(1.))]:
            with self.assertRaises(IntervalError):op()
        self.assertEqual(float((I(0.)/I(-3.,-2.)).hi),0)


if __name__=='__main__':unittest.main()
