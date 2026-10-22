import math
import os
import resource
import time
import unittest
from unittest import mock
import numpy as np
import support_audit as S

class Counts(unittest.TestCase):
    def test_ties_unknown(self):
        z=np.array([-3.,-2.,-2.,-1.,-.5]);states=np.array([0,1,-1,0,1],np.int8)
        v=S.support(z,states,-2.,0,3/5);self.assertEqual(v['inclusive_count'],3);self.assertEqual(v['unknown_count'],1)
        self.assertEqual(v['own_count'],1);self.assertEqual(v['C'],.6)
    def test_unknown_and_fallback(self):
        z=[-3.,-2.];states=[0,1]
        self.assertEqual(S.support(z,states,-2.,-1,1.)['C'],1.)
        self.assertEqual(S.support(z,[0,0],-2.,0,1.,fallback=True)['C'],1.)
        with self.assertRaises(ValueError):S.support(z,[0,0],-2.,-1,1.)
    def test_zero_median(self):
        with self.assertRaises(ValueError):S.support([-1.,0.],[0,1],0.,-1,1.)
    def test_beyond_min(self):
        v=S.support([-3.,-2.],[0,1],-4.,0,0.);self.assertTrue(v['query_below_min']);self.assertEqual(v['query_min_ratio'],4/3)
    def test_allfive(self):
        def predict(lib,q):
            if not len(lib) or not np.isfinite(q).all():return np.full_like(q,np.nan)
            return np.ones_like(q)
        fb,p=S.selected([-1.],[-1.],[np.nan,1,1,1,1],[1]*5,predict);self.assertTrue(fb);self.assertTrue(np.isfinite(p).all())
        self.assertTrue(S.selected([],[-1.],[1]*5,[1]*5,predict)[0])
    def test_legacy_pin_order(self):
        import types
        p=dict(path='/generated/source.py',size=1,sha256='a');seen=[]
        R=types.SimpleNamespace(read=lambda _:dict(source_sha256={'source.py':'a'}),checked=lambda pin:seen.append(pin))
        old=dict(pins={'legacy_scope':{}},files=[p]);self.assertEqual(S.legacy_sources(R,old),[p]);self.assertEqual(seen,[p])
        R.checked=lambda _:(_ for _ in ()).throw(ValueError('stale source'))
        with self.assertRaisesRegex(ValueError,'stale source'):S.legacy_sources(R,old)
    def test_draft(self):
        with self.assertRaisesRegex(ValueError,'DRAFT'):S.run('/absent','x')

@unittest.skipUnless(os.environ.get('Q26_SUPPORT_SIX_YEAR')=='1','explicit generated-only original-science qualification')
class OriginalScience(unittest.TestCase):
    def test_six_year(self):
        import test_adapter as T
        science,_=T.sources()
        import json,hashlib,types
        from pathlib import Path
        fit=json.loads(Path(os.environ['Q26_FIXED_C_LEGACY_SOURCE_SCOPE']).read_text())
        pins=[]
        for relative,digest in fit['source_sha256'].items():
            path=Path(science.producer.SOURCE)/relative;pins.append(dict(path=str(path),size=path.stat().st_size,sha256=digest))
        def checked(pin):
            data=Path(pin['path']).read_bytes();self.assertEqual(hashlib.sha256(data).hexdigest(),pin['sha256']);self.assertEqual(len(data),pin['size'])
        S.legacy_sources(types.SimpleNamespace(read=lambda _:fit,checked=checked),dict(pins={'legacy_scope':{}},files=pins))
        M3,A6,M2,D=T.legacy(science)
        start=time.monotonic();n=6*366*24;i=np.arange(n);base=1577836800
        returns=.006*np.sin(i/5.)+.003*np.cos(i/29.)
        close=100*np.exp(np.cumsum(returns));low=close*(.97+.01*np.sin(i/53.));high=close*1.03
        ser=M3.S3('generated:sixyear','ETH','synthetic',close,low,science.core.BARRIERS.copy(),base,base);A6.attach_high(ser,high)
        realized=D.realized(ser);feature=science.census_source.downside_feature(realized,science.producer.sanitize);states=science.census_source.states_of(feature,science.runner.CUT);del realized
        qa=1735689600;ts=qa+86400*10;idx=(ts-base)//3600
        coef=np.array([math.log(.5),0.,0.,0.])  # Explicit generated retained coefficients; never fitted.
        with mock.patch.object(A6.Prep6,'har_coef',side_effect=AssertionError('fit forbidden')),mock.patch('numpy.linalg.solve',side_effect=AssertionError('solve forbidden')),mock.patch('numpy.linalg.lstsq',side_effect=AssertionError('lstsq forbidden')):
            p=A6.Prep6(ser,24,with_fbL=False);sig=p.sigma_H(coef);z,v=p.z_of(sig);mature=np.arange(p.n)+24<=(qa-base)//3600;mi=np.flatnonzero(v&mature);fi=np.flatnonzero(p.P.valid[1.]&mature);reg=np.flatnonzero(p.okH&mature)
            end=lambda a:None if not len(a) else int(base+3600*(int(a[-1])+24))
            record=dict(quarter_cutoff=qa,coef=coef.tolist(),n_reg=len(reg),har_label_end_max=end(reg),library_label_end_max=end(mi),fallback_library_label_end_max=end(fi),har_label_end_min=int(base+3600*(int(reg[0])+24)))
            mq=np.log1p(science.core.BARRIERS)/(sig[idx]*p.P.scale);fq=np.log1p(science.core.BARRIERS)/(ser.sigma[idx]*p.P.scale)
            fb,probs=S.selected(z[mi],p.P.z[1.][fi],mq,fq,M2.fhs_predict);current=int(states[idx])
            mix=science.mixture.missingness_mixture(z[mi],states[mi],mq.reshape(1,5),np.array([current],np.int8),probs.reshape(1,5))
            archive=dict(ts=np.array([ts],np.int64),Xshape=np.zeros((1,6),np.float32),fH_fallback=np.array([fb]),p_fH=probs.reshape(1,5));archive['Xshape'][0,3]=feature[idx]
            cases=[dict(sid=0,ts=ts,kind='C_high',quarter_cutoff=qa)];private={(0,ts):dict(A=float(probs[2]),C=float(mix['C_conditional'][0,2]),fallback=fb,issuance_state=current)}
            del p,z,v,sig
            rows=S.series(science,A6,M2,D,ser,dict(quarters=[record]),cases,archive,private,status=S.READY)
        self.assertEqual(len(rows),1);self.assertTrue(rows[0]['C_parity'])
        print({'scope':'GENERATED_SIX_YEAR_ONLY','seconds':time.monotonic()-start,'ru_maxrss_native':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'hourly_n':n,'fits':0},flush=True)
if __name__=='__main__':unittest.main()
