import importlib.util
import json
import tempfile
import types
import sys
import unittest
from pathlib import Path
import numpy as np

spec=importlib.util.spec_from_file_location('build_inputs',Path(__file__).with_name('build_inputs.py'))
B=importlib.util.module_from_spec(spec); spec.loader.exec_module(B)

class FakePrep:
    def __init__(self,ser,H,with_fbL=False):
        self.n=len(ser.spot); self.H=H; self.ser=ser; self.okH=np.ones(self.n,bool)
        valid=np.arange(self.n)+H<=len(ser.low)
        depth=np.full(self.n,np.nan); v=np.lib.stride_tricks.sliding_window_view(ser.low,H).min(1); depth[:len(v)]=np.log(v/100.)
        self.P=types.SimpleNamespace(lab_ok=valid,depth=depth,scale=1.,z={1.:depth},valid={1.:valid})
    def har_coef(self,qs): return np.array([1.+qs/100000]),{'n_reg':int(np.sum(np.arange(self.n)+self.H<=qs))}
    def sigma_H(self,c): return np.full(self.n,c[0])
    def z_of(self,s): return self.P.depth/s,self.P.lab_ok&np.isfinite(s)

class FakeM:
    @staticmethod
    def fhs_predict(z,t):
        a=np.full(t.shape,np.nan)
        if len(z):
            ok=np.all(np.isfinite(t),1); a[ok]=np.searchsorted(np.sort(z),t[ok],side='right')/len(z)
        return a

def fixture():
    start=B.START-365*86400; n=365*24+200*24
    return types.SimpleNamespace(base_ts=start,start_i=0,low=np.full(n,90.),spot=np.full(n+1,100.),sigma=np.ones(n+1))

def build(ser,H=24):
    n=len(ser.spot); f={k:np.zeros(n) for k in B.BASE[2:]}; shape=np.zeros((n,6))
    return B.build_horizon(ser,H,7,f,shape,types.SimpleNamespace(Prep6=FakePrep),FakeM)

class Tests(unittest.TestCase):
    def test_selection_key_stability(self):
        keys=['a','b','c']; chosen=[k for _,k in B.choose(keys,2)]
        self.assertEqual(chosen,[k for _,k in B.choose(list(reversed(keys)),2)])
        with self.assertRaises(ValueError): B.choose(['a','a'])
    def test_log1p_barrier_and_complete_label(self):
        s=types.SimpleNamespace(low=np.array([90.,79.,95.]),spot=np.array([100.,100.,100.,100.]))
        y,valid,missing,depth=B.complete_labels(s,2,np.array([0,1,2]),np.array([np.log(.79),np.log(.79),np.nan]),np.array([1,1,0],bool))
        np.testing.assert_array_equal(y[0],[0,1,1,1,1]); np.testing.assert_array_equal(valid,[1,1,0]); self.assertEqual(missing[2],1)
    def test_partial_future_not_nohit_or_issue_gate(self):
        s=fixture(); original,_=build(s); s.low[-2]=np.nan; changed,m=build(s)
        np.testing.assert_array_equal(original['issue_eligible'],changed['issue_eligible'])
        self.assertFalse(changed['label_valid'][-1]); self.assertTrue(changed['issue_eligible'][-1])
        self.assertTrue(np.all(changed['y'][-1]==0)); self.assertGreater(changed['future_missing_hours'][-1],0)
    def test_own_quarter_and_mature_library(self):
        a,m=build(fixture())
        for q in m['quarters']:
            at=a['quarter_cutoff']==q['quarter_cutoff']; qs=(q['quarter_cutoff']-fixture().base_ts)//3600
            np.testing.assert_allclose(a['Xbase'][at,0],np.log(1.+qs/100000),rtol=1e-6)
            self.assertLessEqual(q['har_label_end_max'],q['quarter_cutoff']); self.assertLessEqual(q['library_label_end_max'],q['quarter_cutoff'])
        self.assertGreater(len(m['quarters']),1)
    def test_future_tail_no_overwrite_earlier_quarter(self):
        s=fixture(); a,_=build(s); s.low[-100:]=75.; b,_=build(s)
        early=a['ts']<B.quarters()[1]
        np.testing.assert_array_equal(a['Xbase'][early],b['Xbase'][early]); np.testing.assert_array_equal(a['p_fH'][early],b['p_fH'][early])
    def test_margin_raw_and_missing(self):
        p=np.array([[0,.01,.1,.9,1],[np.nan,.1,.2,.3,.4]])
        self.assertEqual(B.MARGIN_EPS,1e-6)
        copy=p.copy(); m,c,v=B.margins(p)
        self.assertAlmostEqual(m[0,0],np.log(1e-6/(1-1e-6)))
        np.testing.assert_array_equal(p,copy); self.assertTrue(c[0,0] and c[0,-1]); self.assertFalse(v[1]); self.assertTrue(np.isnan(m[1]).all())
    def test_missing_features_serialization(self):
        s=fixture(); n=len(s.spot); f={k:np.zeros(n) for k in B.BASE[2:]}; f['lvol'][:]=np.nan
        sh=np.zeros((n,6)); sh[:,0]=np.inf
        a,_=B.build_horizon(s,6,7,f,sh,types.SimpleNamespace(Prep6=FakePrep),FakeM)
        self.assertTrue(a['Xbase_missing'][:,9].all()); self.assertTrue(a['Xshape_missing'][:,0].all()); self.assertFalse(np.isinf(a['Xshape']).any())
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'horizon-6.npz'; np.savez_compressed(p,**a)
            with np.load(p,allow_pickle=False) as z: np.testing.assert_array_equal(z['label_valid'],a['label_valid'])
    def test_actual_legacy_primitives_synthetic_cutoff_and_missing(self):
        sys.path.insert(0,str(B.SOURCE/'scripts/research/history-forecasts'))
        import a3_touch as M3
        import a6_touch as A6
        import a2_touch as M2
        n=240*24; i=np.arange(n); close=100*np.exp(np.cumsum(.001*np.sin(i/13)+.0003*np.cos(i/7)))
        base=B.START-120*86400
        def ser(missing=False,perturb=False):
            lo=close*.997; hi=close*1.003
            if missing: lo[120*24+2]=np.nan
            if perturb: lo[121*24:]*=.9
            x=M3.S3('synthetic','ETH','synthetic',close,lo,np.array([-.1,-.05]),base,base)
            A6.attach_high(x,hi); return x
        a=ser(); z=ser(perturb=True); qs=120*24
        ca,_=A6.Prep6(a,24,with_fbL=False).har_coef(qs)
        cz,_=A6.Prep6(z,24,with_fbL=False).har_coef(qs)
        np.testing.assert_array_equal(ca,cz)
        x=ser(missing=True); N=len(x.spot); f={k:np.zeros(N) for k in B.BASE[2:]}
        rows,meta=B.build_horizon(x,24,9,f,np.zeros((N,6)),A6,M2)
        j=np.flatnonzero(rows['ts']==B.START)[0]
        self.assertTrue(rows['legacy_label_valid'][j]); self.assertFalse(rows['label_valid'][j]); self.assertTrue(rows['issue_eligible'][j])
        self.assertEqual(rows['future_missing_hours'][j],1)
        self.assertLessEqual(meta['quarters'][0]['har_label_end_max'],B.START)

    def test_raw_extrema_and_volume_null_semantics(self):
        # Legacy extrema ignore partial gaps; only an all-invalid history is undefined.
        n=800; x=np.arange(n,dtype=float); s=types.SimpleNamespace(close=np.ones(n),spot=np.ones(n+1)*100,high=np.ones(n)*110,low=np.ones(n)*90,start_i=0,base_ts=0)
        s.high[10:35]=np.nan; s.high[790:]=np.nan
        A=types.SimpleNamespace(har_of=lambda s:np.ones((n+1,3)))
        def mean(v,w,st):
            a=np.full(n+1,np.nan)
            for i in range(w,n+1):
                z=v[i-w:i]
                if np.sum(~np.isfinite(z))<=int(.05*w): a[i]=np.nanmean(z)
            return a
        def realized(s):
            return {k+w:np.ones(n+1) for k in ('RV','J','RSm','RSp') for w in 'DWM'}
        v=np.ones(n); v[-3:]=np.nan
        D=types.SimpleNamespace(load_volume=lambda spec:v,roll_mean=mean,btc_lookup=lambda ts:(np.full(len(ts),np.nan),np.full(len(ts),np.nan)),realized=realized)
        f,shape,m=B.raw_features(s,{},D,A)
        self.assertTrue(np.isnan(f['rng24'][35])) # all24 highs missing
        self.assertTrue(np.isfinite(f['rng24'][36])) # one valid high is enough for legacy extrema
        self.assertTrue(np.isnan(f['lvol'][-1])) # three missing24h volumes exceed original5% rule
        self.assertFalse(m['volume_loader_returned_none'])

    def test_label_only_continuous_depth_retained(self):
        a,_=build(fixture()); valid=a['label_valid']; depth=a['future_log_min']
        self.assertEqual(depth.dtype,np.float64)
        self.assertTrue(np.isnan(depth[~valid]).all()); self.assertTrue(np.isfinite(depth[valid]).all())
        np.testing.assert_allclose(depth[valid],np.log(.9),rtol=0,atol=1e-15)
        np.testing.assert_array_equal(a['y'][valid],depth[valid,None]<=np.log1p(B.BARRIERS)[None,:])
        self.assertNotIn('future_log_min',B.BASE+B.SHAPE)
        self.assertEqual(a['Xbase'].shape[1],12);self.assertEqual(a['Xshape'].shape[1],6)

    def test_draft_refusal_before_inputs(self):
        with self.assertRaisesRegex(ValueError,'DRAFT'): B.authenticate({'status':'DRAFT'})
    def test_pin_tamper(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'x'; p.write_text('one'); q=B.pin(p); p.write_text('two')
            with self.assertRaises(ValueError): B.check(q)
    def test_guard_exact_reads_and_output(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'allowed'; p.write_text('ok'); x=Path(t)/'outside'; x.write_text('no'); out=Path(t)/'out'; out.mkdir()
            with B.guard([p],out):
                self.assertEqual(p.read_text(),'ok')
                with self.assertRaises(PermissionError): x.read_text()
                with self.assertRaises(PermissionError): p.write_text('bad')
                (out/'new').write_text('yes')

if __name__=='__main__': unittest.main()
