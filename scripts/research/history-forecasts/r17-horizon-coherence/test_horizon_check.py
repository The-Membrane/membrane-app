"""Small synthetic mathematical certificates; no saved arrays or model jobs."""
import copy
from fractions import Fraction as F
import importlib.util
from pathlib import Path
import types
import unittest
import numpy as np

HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('independent_horizon_checker',HERE/'horizon_check.py')
C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)


def grid(values):return np.repeat(np.asarray(values,dtype=np.float64)[:,None],5,axis=1)


def certificate(original, blocks):
    """Hand-specified block partitions, not producer or PAV logic."""
    columns=[];represented=np.empty((5,5),dtype=np.float64)
    for j in range(5):
        exact=[None]*5;bs=[]
        for start,stop in blocks:
            mean=sum((F.from_float(float(original[i,j])) for i in range(start,stop)),F(0))/(stop-start)
            bs.append(types.SimpleNamespace(start=start,stop=stop,mean=mean))
            exact[start:stop]=[mean]*(stop-start)
        represented[:,j]=[float(q) for q in exact]
        error=[F.from_float(float(v))-q for v,q in zip(represented[:,j],exact)]
        columns.append(types.SimpleNamespace(exact_values=tuple(exact),blocks=tuple(bs),
            quantization_bound=sum((2*abs(e)+e*e for e in error),F(0))))
    return types.SimpleNamespace(probabilities=represented,columns=tuple(columns))


class ExactOracle(unittest.TestCase):
    def test_known_multiple_blocks(self):
        p=grid([.75,.25,.875,.375,1.])
        q=certificate(p,[(0,2),(2,4),(4,5)])
        result=C.check_grid(p,q)
        self.assertEqual(result['ideal_columns'][0],(F(1,2),F(1,2),F(5,8),F(5,8),F(1)))
        self.assertEqual(result['quantization_bounds'],(F(0),)*5)

    def test_identity_ties_equal_values_and_endpoints(self):
        for values in ([0.,.25,.25,.75,1.],[.5]*5,[0.]*5,[1.]*5):
            p=grid(values);before=p.tobytes();q=certificate(p,[(i,i+1) for i in range(5)])
            C.check_grid(p,q)
            self.assertEqual(p.tobytes(),before)
            self.assertEqual(q.probabilities.tobytes(),p.tobytes())

    def test_column_specific_ordered_grid_preserves_both_axes(self):
        p=np.array([[.75,.75,.875,1.,1.],[.25,.375,.5,.75,1.],
                    [.875,.875,.875,1.,1.],[.375,.5,.625,.75,1.],[1.,1.,1.,1.,1.]])
        # Every severity column has the same hand-specified two pooling pairs.
        q=certificate(p,[(0,2),(2,4),(4,5)])
        C.check_grid(p,q)
        self.assertTrue(np.all(q.probabilities[1:]>=q.probabilities[:-1]))
        self.assertTrue(np.all(q.probabilities[:,1:]>=q.probabilities[:,:-1]))

    def test_primary_h24_can_worsen_while_total_ideal_improves(self):
        p=grid([.125,.875,.125,1.,1.]);q=certificate(p,[(0,1),(1,3),(3,4),(4,5)])
        losses=C.check_losses(p,q,np.zeros((5,5),dtype=np.uint8))
        self.assertTrue(losses['eligible'])
        self.assertGreater(F.from_float(float(q.probabilities[2,2]))**2,F.from_float(float(p[2,2]))**2)
        self.assertLess(losses['columns'][2]['ideal_loss'],losses['columns'][2]['original_loss'])

    def test_once_rounding_counterexample_retains_positive_represented_harm(self):
        u=float(np.spacing(np.float64(.5)));a=.5+2*u;b=.5+u
        p=grid([a,b,1.,1.,1.]);q=certificate(p,[(0,2),(2,3),(3,4),(4,5)])
        losses=C.check_losses(p,q,np.zeros((5,5),dtype=np.uint8))['columns'][0]
        self.assertLess(losses['ideal_loss'],losses['original_loss'])
        self.assertGreater(losses['represented_minus_original'],0)
        self.assertEqual(losses['represented_minus_original'],F.from_float(a)**2-F.from_float(b)**2)
        self.assertLessEqual(abs(losses['represented_loss']-losses['ideal_loss']),losses['quantization_bound'])

    def test_reject_missing_extra_or_changed_cells_means_and_float_bounds(self):
        p=grid([.75,.25,.875,.375,1.]);base=certificate(p,[(0,2),(2,4),(4,5)])
        for kind in ('missing','extra','cell','ideal','mean','coverage','bound','bound_float','extra_field','column_missing'):
            q=copy.deepcopy(base)
            if kind=='missing':q.probabilities=q.probabilities[:-1]
            elif kind=='extra':q.probabilities=np.c_[q.probabilities,q.probabilities[:,-1]]
            elif kind=='cell':q.probabilities[0,0]=np.nextafter(q.probabilities[0,0],0.)
            elif kind=='ideal':q.columns[0].exact_values=(F(0),)+q.columns[0].exact_values[1:]
            elif kind=='mean':q.columns[0].blocks[0].mean+=F(1,100)
            elif kind=='coverage':q.columns[0].blocks[0].start=1
            elif kind=='bound':q.columns[0].quantization_bound+=F(1,100)
            elif kind=='bound_float':q.columns[0].quantization_bound=float(q.columns[0].quantization_bound)
            elif kind=='extra_field':q.extra=True
            else:q.columns=q.columns[:-1]
            with self.subTest(kind=kind),self.assertRaises(ValueError):C.check_grid(p,q)

    def test_probability_dtype_range_barrier_order_and_alias_refusals(self):
        for kind in ('dtype','nan','range','barrier','alias'):
            p=grid([0.,.25,.5,.75,1.]);q=certificate(p,[(i,i+1) for i in range(5)])
            if kind=='dtype':p=p.astype('f4')
            elif kind=='nan':p[0,0]=np.nan
            elif kind=='range':p[-1,-1]=1.01
            elif kind=='barrier':p[0,0]=.5
            else:q.probabilities=p
            with self.subTest(kind=kind),self.assertRaises(ValueError):C.check_grid(p,q)

    def test_signed_zero_is_rounded_once_to_canonical_positive_zero(self):
        p=grid([-0.,0.,.5,.75,1.]);q=certificate(p,[(i,i+1) for i in range(5)])
        C.check_grid(p,q)
        self.assertFalse(np.signbit(q.probabilities[0,0]))
        q.probabilities[0,0]=-0.
        with self.assertRaisesRegex(ValueError,'once-rounded'):C.check_grid(p,q)

    def test_nonnested_labels_are_errors_incomplete_vectors_ineligible(self):
        y=np.zeros((5,5),dtype=np.uint8);y[3:]=1
        self.assertTrue(C.theorem_eligible(y))
        valid=np.array([True,False,True,True,True])
        self.assertFalse(C.theorem_eligible(y,valid))
        y[1]=1
        with self.assertRaisesRegex(ValueError,'nonnested'):C.theorem_eligible(y)
        # A missing intermediate row cannot hide two observed reversed outcomes.
        y=np.zeros((5,5),dtype=np.uint8);y[0]=1
        with self.assertRaisesRegex(ValueError,'nonnested'):C.theorem_eligible(y,valid)
        y=np.zeros((5,5),dtype=np.uint8);y[2,2]=2
        with self.assertRaises(ValueError):C.theorem_eligible(y)

    def test_all_ideal_nested_binary_vectors_satisfy_theorem(self):
        p=grid([.75,.25,.875,.375,1.]);q=certificate(p,[(0,2),(2,4),(4,5)])
        for first_hit in range(6):
            y=np.zeros((5,5),dtype=np.uint8);y[first_hit:]=1
            proof=C.check_losses(p,q,y)
            self.assertTrue(proof['eligible'])
            for row in proof['columns']:
                self.assertLessEqual(row['ideal_loss'],row['original_loss']-row['ideal_projection_displacement'])

    def test_producer_boundary_integration_without_checker_importing_producer(self):
        # Test-only integration. The checker module itself never imports PAV.
        import importlib.util,sys
        spec=importlib.util.spec_from_file_location('horizon_producer_test_boundary',HERE/'horizon_coherence.py')
        producer=importlib.util.module_from_spec(spec);sys.modules[spec.name]=producer
        try:
            spec.loader.exec_module(producer)
            p=grid([.75,.25,.875,.375,1.]);snapshot=p.tobytes()
            q=producer.project_grid(p)
            C.check_grid(p,q)
            self.assertEqual(p.tobytes(),snapshot)
        finally:sys.modules.pop(spec.name,None)


if __name__=='__main__':unittest.main()
