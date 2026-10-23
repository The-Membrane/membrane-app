import ast,hashlib,importlib.util,json,os,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
P=Path(__file__).resolve().with_name('retained_vol.py')
s=importlib.util.spec_from_file_location('vol',P); B=importlib.util.module_from_spec(s);s.loader.exec_module(B)
SRC=Path(os.environ.get('Q26_A6_SOURCE',str(Path(__file__).resolve().parent.parent/'a6_touch.py')))
SOURCE_SHA='6da8e4f719ef164128cdceccfd6ba9dc347d3fa75e6e4e585bcd27eb0e36ed45'
def original():
 assert hashlib.sha256(SRC.read_bytes()).hexdigest()==SOURCE_SHA,'original A6 source pin'
 tree=ast.parse(SRC.read_text()); sf=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='sigma_fut')
 cl=next(x for x in tree.body if isinstance(x,ast.ClassDef) and x.name=='Prep6'); sh=next(x for x in cl.body if isinstance(x,ast.FunctionDef) and x.name=='sigma_H')
 env={'np':np,'ANNUAL':8760,'PARK':1/(4*np.log(2)),'HAR_WINDOWS':(24,168,720),'M3':SimpleNamespace(NULL_FRAC=.05,max_nulls=lambda h,f:int(h*f))}
 functions=[next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name==name) for name in ('parkinson_v','window_mean_null_rule','har_components')]+[sf]
 exec(compile(ast.Module(body=functions,type_ignores=[]),str(SRC),'exec'),env)
 sh.decorator_list=[]; exec(compile(ast.Module(body=[sh],type_ignores=[]),str(SRC),'exec'),env)
 class Prep:
  sigma_H=env['sigma_H']
  def har_coef(*args): raise AssertionError('fit reached')
 return SimpleNamespace(sigma_fut=env['sigma_fut'],har_components=env['har_components'],Prep6=Prep)
def fixture():
 A=original(); n=100; close=np.exp(np.arange(n)*.01);base=1704067200
 A.har_components=lambda high,low,start:np.full((len(high)+1,3),np.exp(.1234567890123))
 ser=SimpleNamespace(close=close,high=close*1.01,low=close*.99,start_i=0,base_ts=base,sigma=np.full(n+1,2.0))
 ts=np.array([base+24*3600,base+48*3600],np.int64)
 q={'quarter_cutoff':base,'n_rows':2,'n_reg':4,'coef':[0.,1.,0.,0.],'har_label_end_max':base,'library_label_end_max':base,'fallback_library_label_end_max':base}
 return A,ser,ts,np.full(2,base,np.int64),np.array([False,True]),[q]
class Tests(unittest.TestCase):
 def test_target_forward_clock_annualization(self):
  a=original();c=np.exp(np.arange(80)*.02);v=a.sigma_fut(c,24,0)
  self.assertAlmostEqual(v[24],np.sqrt(8760)*.02,12)
  c[0]=1e10; self.assertAlmostEqual(a.sigma_fut(c,24,0)[24],v[24],9)
  c[47]*=2;self.assertGreater(a.sigma_fut(c,24,0)[24],v[24])
  c=np.exp(np.arange(80)*.02);c[48]*=2;self.assertAlmostEqual(a.sigma_fut(c,24,0)[24],v[24],9)
 def test_null_tolerance_zero_and_short(self):
  a=original();c=np.exp(np.arange(80)*.02);c[47]=np.nan
  self.assertTrue(np.isfinite(a.sigma_fut(c,24,0)[24]))
  c[40]=np.nan;self.assertTrue(np.isnan(a.sigma_fut(c,24,0)[24]))
  self.assertTrue(np.isnan(a.sigma_fut(np.ones(80),24,0)[24]))
  self.assertTrue(np.isnan(a.sigma_fut(np.ones(12),24,0)).all())
 def test_reconstruct_fullprecision_and_no_fit(self):
  A,ser,ts,cut,fb,q=fixture()
  with patch.object(np.linalg,'solve',side_effect=AssertionError),patch.object(np.linalg,'lstsq',side_effect=AssertionError):
   r=B.reconstruct(A,ser,ts,cut,fb,q,ts,status=B.READY)
  np.testing.assert_array_equal(r['har'],np.full(2,np.exp(.1234567890123)))
  self.assertNotEqual(r['har'][0],np.exp(np.float64(np.float32(.1234567890123))))
  np.testing.assert_array_equal(r['ewma'],[2.,2.]);self.assertTrue(r['strict_future'].all())
 def test_actual_raw_features_no_future_high_leak(self):
  A=original();n=1100;close=np.exp(np.arange(n)*.001);base=1704067200-40*86400
  ser=SimpleNamespace(close=close,high=close*1.01,low=close*.99,start_i=0,base_ts=base,sigma=np.full(n+1,1.5))
  t=np.array([1704067200+86400],np.int64);cut=np.array([1704067200],np.int64);f=np.array([False]);q=[{'quarter_cutoff':int(cut[0]),'n_rows':1,'n_reg':4,'coef':[0.,.5,.25,.25],'har_label_end_max':int(cut[0]),'library_label_end_max':int(cut[0]),'fallback_library_label_end_max':int(cut[0])}]
  r=B.reconstruct(A,ser,t,cut,f,q,t,status=B.READY);ix=int((t[0]-base)//3600)
  comp=A.har_components(ser.high,ser.low,0)[ix];self.assertAlmostEqual(r['har'][0],np.exp(np.log(comp)@np.array([.5,.25,.25])),12)
  ser.high[ix:]*=5
  r2=B.reconstruct(A,ser,t,cut,f,q,t,status=B.READY);np.testing.assert_array_equal(r['har'],r2['har'])
 def test_none_no_fallback(self):
  A,ser,t,c,f,q=fixture();q[0].update(n_reg=0,coef=None)
  r=B.reconstruct(A,ser,t,c,f,q,t,status=B.READY);self.assertTrue(np.isnan(r['har']).all());self.assertTrue((r['ewma']==2).all())
 def test_maturity_quarter_join_refusals(self):
  for kind in ['future','quarter','duplicate','offhour','missingJ']:
   A,ser,t,c,f,q=fixture();j=t.copy()
   if kind=='future':q[0]['har_label_end_max']+=1
   if kind=='quarter':c[:]=1706745600
   if kind=='duplicate':q=q+q
   if kind=='offhour':j[0]+=1
   if kind=='missingJ':j[0]+=3600
   with self.subTest(kind=kind),self.assertRaises(ValueError):B.reconstruct(A,ser,t,c,f,q,j,status=B.READY)
 def test_original_vs_strict(self):
  A,ser,t,c,f,q=fixture();ser.close[47]=np.nan
  r=B.reconstruct(A,ser,t,c,f,q,t,status=B.READY)
  self.assertTrue(np.isfinite(r['target'][0]));self.assertFalse(r['strict_future'][0])
 def test_score_known_answer_and_period(self):
  t=np.array([1672531200,1704067200,1735689600],np.int64)
  r=B.score(t,np.array([1.,2.,4.]),np.array([1.,1.,2.]),np.array([1.,1.,2.]),np.array([1,1,0],bool),np.zeros(3,bool),status=B.READY)
  v=r['views']['pooled_2024_2025'];self.assertEqual(v['J'],2);self.assertEqual(r['out_of_period_J'],1)
  self.assertAlmostEqual(v['original_target_paired']['HAR'],np.log(2)**2)
  self.assertEqual(v['complete_future_paired']['n'],1)
 def test_invalid_scales_target_and_dtype(self):
  t=np.arange(4,dtype=np.int64)+1704067200;h=np.array([0.,1.,np.inf,1.]);e=np.ones(4);y=np.array([1.,0.,1.,1.]);b=np.ones(4,bool)
  v=B.score(t,h,e,y,b,b,status=B.READY)['views']['2024'];self.assertEqual(v['original_target_paired']['n'],1)
  self.assertEqual(v['HAR_unavailable'],2);self.assertEqual(v['target_unavailable'],1)
  with self.assertRaises(ValueError):B.score(t,h.astype(np.float32),e,y,b,b,status=B.READY)
 def test_draft_no_touch(self):
  with self.assertRaises(ValueError):B.reconstruct(None,None,None,None,None,None,None)
 def test_extreme_coef_original_nan(self):
  A,ser,t,c,f,q=fixture();q[0]['coef']=[10000.,0.,0.,0.]
  self.assertTrue(np.isnan(B.reconstruct(A,ser,t,c,f,q,t,status=B.READY)['har']).all())
if __name__=='__main__':unittest.main()
