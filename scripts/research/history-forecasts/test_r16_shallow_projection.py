"""Tiny synthetic dependencies only; no real fits, parity runs or downloads."""
import ast
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
import r16_dev as D
import r16_shallow_projection as P
import r16_shallow_reconstruction as A


class FakePrep:
    calls=[]
    def __init__(self,ser,horizon,with_fbL):
        if with_fbL is not False:
            raise AssertionError('must preserve original Prep6 mode')
        n=len(ser.close)+1
        self.n=n
        lab=np.ones(n,bool);lab[756]=False
        depth=np.full(n,-.03);depth[762]=np.nan
        self.P=SimpleNamespace(lab_ok=lab,depth=depth,scale=1.,
            z={1.:np.linspace(-.2,.05,n)},valid={1.:np.ones(n,bool)})
        self.lfut=np.zeros(n);self.okH=np.ones(n,bool)
        self.horizon=horizon
    def har_coef(self,qs):
        self.calls.append((self.horizon,qs))
        return np.array([1.,0.,0.,0.]),{}
    def sigma_H(self,coefficient):
        out=np.full(self.n,.7);out[750]=np.nan
        return out
    def z_of(self,sigma):
        valid=self.P.lab_ok & np.isfinite(sigma)
        return np.where(valid,self.P.depth/sigma,np.nan),valid


def fixture(volume=None):
    n=800
    close=100*np.exp(np.arange(n)*.0001)
    sigma=np.full(n+1,.6);sigma[774]=np.nan
    ser=SimpleNamespace(close=close,high=close*1.01,low=close*.99,
        spot=np.r_[np.nan,close],sigma=sigma,start_i=0,base_ts=0)
    folds=[dict(qs_i=740,qe_i=783)]
    caps=dict(full=800*D.STEP,primary=780*D.STEP)
    stack=ExitStack()
    stack.enter_context(patch.object(D.R12,'load_series',return_value=(ser,folds,caps)))
    stack.enter_context(patch.object(D.R12,'Q2_START',767*D.STEP))
    stack.enter_context(patch.object(D.R12,'Q2_END',770*D.STEP))
    stack.enter_context(patch.object(D.A6,'har_of',return_value=np.tile([.2,.3,.4],(n+1,1))))
    stack.enter_context(patch.object(D.A6,'Prep6',FakePrep))
    stack.enter_context(patch.object(D.A6,'_clear'))
    stack.enter_context(patch.object(D,'load_volume',return_value=volume))
    stack.enter_context(patch.object(D,'btc_lookup',side_effect=lambda ts:(ts.astype(float)/1e7,np.full(len(ts),.2))))
    # Discarded family fits are disabled only in this synthetic reference fixture.
    stack.enter_context(patch.object(D,'fit_arch',return_value=None))
    stack.enter_context(patch.object(D,'ols_scale',return_value=None))
    return stack,ser


class ProjectionTests(unittest.TestCase):
    def test_tiny_reference_retained_fields_exact_bytes_and_masks(self):
        for volume in (None,np.linspace(2.,3.,800),np.ones(5)):
            with self.subTest(volume=None if volume is None else len(volume)):
                stack,_=fixture(volume)
                with stack:
                    reference=D.task(dict(key='fixture'))
                    projected=P.task(dict(key='fixture'))
                self.assertEqual(set(projected['rows']),{1,3,12})
                for horizon in P.HORIZONS:
                    expected=reference['rows'][horizon]
                    actual=projected['rows'][horizon]
                    self.assertEqual(set(actual),set(P.RETAINED))
                    np.testing.assert_array_equal(actual['ts'],np.array([744,750])*D.STEP)
                    for key in P.RETAINED:
                        self.assertEqual(actual[key].shape,expected[key].shape)
                        self.assertEqual(actual[key].dtype,expected[key].dtype)
                        self.assertEqual(actual[key].tobytes(),expected[key].tobytes(),(horizon,key))
                    # fH fallback preserves NaN lsH, and the common mask drops bad f.
                    self.assertTrue(np.isnan(actual['lsH'][1]))
                    np.testing.assert_array_equal(actual['fH'][1],actual['f'][1])
                    self.assertEqual(projected['fallback'][horizon],dict(f=0,fH=0))
                self.assertIn('not executed',projected['fits']['status'])

    def test_no_rng_or_unretained_fitting_dependency(self):
        stack,_=fixture()
        with stack, patch.object(np.random,'default_rng',side_effect=AssertionError('RNG forbidden')), \
             patch.object(D,'realized',side_effect=AssertionError('unused realized measures forbidden')), \
             patch.object(D,'fit_arch',side_effect=AssertionError('unretained fits forbidden')), \
             patch.object(D,'ms_fit',side_effect=AssertionError('unretained MS forbidden')), \
             patch.object(D,'ols_scale',side_effect=AssertionError('discarded scale fits forbidden')):
            projected=P.task(dict(key='fixture'))
        self.assertEqual(set(projected['rows']),{1,3,12})

    def test_probability_accumulate_is_before_float32_cast(self):
        def nonmonotone(z,threshold):
            result=np.tile(np.array([.200000005,.5,.1,.4,.05])[:threshold.shape[1]],(len(threshold),1))
            result[~np.isfinite(threshold).all(axis=1)]=np.nan
            return result
        stack,_=fixture()
        with stack,patch.object(D.M2,'fhs_predict',side_effect=nonmonotone):
            output=P.task(dict(key='fixture'))
        for horizon,values in output['rows'].items():
            expected=np.minimum.accumulate([.200000005,.5,.1,.4,.05][:len(D.LV[horizon])]).astype(np.float32)
            np.testing.assert_array_equal(values['f'][0],expected)
            np.testing.assert_array_equal(values['fH'][0],expected)

    def test_missing_horizon_preserved_when_no_test_origins(self):
        stack,ser=fixture()
        with stack,patch.object(D.R12,'load_series',return_value=(ser,[],dict(full=1,primary=1))):
            output=P.task(dict(key='fixture'))
        self.assertEqual(output['rows'],{})
        self.assertEqual(set(output['fallback']),{1,3,12})

    def test_original_task_ast_and_configuration_unchanged(self):
        before=A.verify_task_ast()
        configuration=(D.TS,D.SIM,D.ALL_ROW_MODELS,D.FEATS)
        stack,_=fixture()
        with stack:
            P.task(dict(key='fixture'))
        self.assertEqual(A.verify_task_ast(),before)
        self.assertEqual((D.TS,D.SIM,D.ALL_ROW_MODELS,D.FEATS),configuration)
        tree=ast.parse(Path(P.__file__).read_text())
        for node in ast.walk(tree):
            if isinstance(node,ast.Attribute) and isinstance(node.ctx,ast.Store):
                self.fail('projection must not assign module attributes')


if __name__=='__main__': unittest.main()
