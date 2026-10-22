import math
import os
import resource
import time
import unittest
from unittest import mock
import numpy as np
import ewma_reference as E

class Bounds(unittest.TestCase):
    def calc(self,p,r,y,known,available):
        return E.compare(np.array(p,float),np.array(available,bool),np.array(y,np.uint8),np.array(known,bool),np.array(r,float))
    def test_unknown_both(self):
        v=self.calc([np.nan],[.8],[0],[False],[False]);b=v['losses']['brier']
        self.assertAlmostEqual(b['all_J_delta_lower_mean'],-.64);self.assertAlmostEqual(b['all_J_delta_upper_mean'],.96);self.assertIsNone(b['common_delta_mean'])
    def test_coupled_unknown_label(self):
        v=self.calc([.2],[.8],[0],[False],[True]);b=v['losses']['brier'];self.assertAlmostEqual(b['all_J_delta_lower_mean'],-.6);self.assertAlmostEqual(b['all_J_delta_upper_mean'],.6)
    def test_endpoint_exact(self):
        for y in (0,1):
            for q in (0.,1.,E.EPS,1-E.EPS):
                v=self.calc([np.nan],[q],[y],[True],[False])
                for name in ('brier','logloss'):
                    values=[float(E.losses(p,y)[name]-E.losses(q,y)[name]) for p in (0.,1.)]
                    self.assertEqual(v['losses'][name]['all_J_delta_lower_mean'],min(values));self.assertEqual(v['losses'][name]['all_J_delta_upper_mean'],max(values))
    def test_brute_completions(self):
        for available in (False,True):
            for known in (False,True):
                for y in (0,1):
                    p=.17;q=.76;v=self.calc([p],[q],[y],[known],[available])
                    for name in ('brier','logloss'):
                        values=[float(E.losses(pp,yy)[name]-E.losses(q,yy)[name]) for pp in ([p] if available else [0.,1.]) for yy in ([y] if known else [0,1])]
                        self.assertEqual(v['losses'][name]['all_J_delta_lower_mean'],min(values));self.assertEqual(v['losses'][name]['all_J_delta_upper_mean'],max(values))
    def test_known_only(self):
        v=self.calc([.2,.9],[.8,.1],[1,0],[True,False],[True,False]);self.assertEqual(v['common_known_n'],1);self.assertEqual(v['J_n'],2)
    def test_draft(self):
        with self.assertRaisesRegex(ValueError,'DRAFT'):E.run('/absent','x')
    def test_duplicate_omission(self):
        a=dict(sid=np.array([0],np.int32),ts=np.array([1704067200],np.int64),f_probability=np.ones((1,5))*.2,available=np.ones(1,bool),y=np.zeros(1,np.uint8),known=np.ones(1,bool),A=np.ones(1)*.3,C=np.ones(1)*.4,fallback=np.zeros(1,bool))
        with self.assertRaisesRegex(ValueError,'unique'):E.report([a,a],[])
        with self.assertRaisesRegex(ValueError,'all fixed cases'):E.report([a],[dict(sid=2,ts=1704067200,kind='C_zero')])

@unittest.skipUnless(os.environ.get('Q26_EWMA_SIX_YEAR')=='1','explicit generated original-science qualification')
class OriginalScience(unittest.TestCase):
    def test_six_year_parity(self):
        import test_adapter as T
        science,_=T.sources();M3,A6,M2,D=T.legacy(science);start=time.monotonic();n=6*366*24;i=np.arange(n);base=1577836800
        close=100*np.exp(np.cumsum(.006*np.sin(i/5.)+.003*np.cos(i/29.)));low=close*.95;high=close*1.03
        ser=M3.S3('generated:ewma','ETH','synthetic',close,low,tuple(M3.A.LEVELS['ETH']),base,base);A6.attach_high(ser,high);self.assertEqual(len(ser.levels),10)
        with self.assertRaisesRegex(ValueError,'five target barriers'):
            E.replay(M3,M2,ser,{},np.empty(0,bool),barriers=np.asarray(ser.levels,np.float64),status=E.READY)
        ts=np.array([1704067200,1704153600,1735689600],np.int64);cut=np.array([1704067200,1704067200,1735689600],np.int64);idx=(ts-base)//3600
        with mock.patch.object(A6.Prep6,'har_coef',side_effect=AssertionError('fit forbidden')),mock.patch('numpy.linalg.solve',side_effect=AssertionError('solve forbidden')),mock.patch('numpy.linalg.lstsq',side_effect=AssertionError('lstsq forbidden')):
            prep=A6.Prep6(ser,24,with_fbL=False);P=prep.P;all_i=np.arange(prep.n);expected=np.full((len(ts),5),np.nan)
            for qa in set(cut.tolist()):
                at=cut==qa;tr=all_i+24<=(qa-base)//3600;expected[at]=M2.fhs_predict(P.z[1.][P.valid[1.]&tr],np.log1p(science.core.BARRIERS)[None,:]/(ser.sigma[idx[at],None]*P.scale))
            saved=dict(ts=ts,quarter_cutoff=cut,fH_fallback=np.ones(len(ts),bool),p_fH=expected)
            result,available,diag=E.replay(M3,M2,ser,saved,np.ones(len(ts),bool),barriers=science.core.BARRIERS,status=E.READY)
            self.assertTrue(np.array_equal(result,expected));self.assertTrue(available.all());self.assertEqual(sum(d['J_n'] for d in diag),3)
            # Empty f library is explicit unavailable, never silently substituted.
            early=np.array([base+86400],np.int64);s=dict(ts=early,quarter_cutoff=np.array([base],np.int64),fH_fallback=np.zeros(1,bool),p_fH=np.full((1,5),np.nan))
            result,available,diag=E.replay(M3,M2,ser,s,np.ones(1,bool),barriers=science.core.BARRIERS,status=E.READY);self.assertFalse(available[0]);self.assertEqual(diag[0]['library_N'],0)
        print(dict(scope='GENERATED_SIX_YEAR_ONLY',seconds=time.monotonic()-start,ru_maxrss_native=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,hourly_n=n,fits=0),flush=True)
if __name__=='__main__':unittest.main()
