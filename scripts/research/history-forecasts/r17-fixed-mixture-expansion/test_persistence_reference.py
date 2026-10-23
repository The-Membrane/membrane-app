"""Generated-only known answers, using authenticated original RMS function AST."""
import ast,hashlib,importlib.util,math,os,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
p=Path(__file__).with_name('persistence_reference.py')
if not p.exists():p=Path(__file__).with_name('q26-o188-persistence.py')
s=importlib.util.spec_from_file_location('persistence',p);P=importlib.util.module_from_spec(s);s.loader.exec_module(P)
ROOT=Path(os.environ['Q26_SOURCE_ROOT']) if 'Q26_SOURCE_ROOT' in os.environ else Path(__file__).resolve().parent.parent

def original():
    specs=[('a3_touch.py','f719a3202738c4c301e13ad892f4406de4c0adc532b219359301aa50d8e205f7','max_nulls'),('a6_touch.py','6da8e4f719ef164128cdceccfd6ba9dc347d3fa75e6e4e585bcd27eb0e36ed45','sigma_fut')]
    env={'np':np,'math':math,'NULL_FRAC':.05,'ANNUAL':8760.}
    for filename,sha,name in specs:
        b=(ROOT/filename).read_bytes();assert hashlib.sha256(b).hexdigest()==sha
        tree=ast.parse(b);node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
        if name=='sigma_fut':env['M3']=SimpleNamespace(NULL_FRAC=.05,max_nulls=env['max_nulls'])
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),filename,'exec'),env)
    return SimpleNamespace(sigma_fut=env['sigma_fut'])
A6=original();BASE=1609459200

def series(close=None,start=0):
    if close is None:close=np.exp(np.arange(80,dtype=np.float64)*.01)
    return SimpleNamespace(close=np.asarray(close,np.float64),base_ts=BASE,start_i=start)
def timestamps(indices):return np.asarray(indices,np.int64)*3600+BASE
def run(ser,indices):return P.persistence(A6,ser,timestamps(indices),status=P.READY)
def direct(ser,i):
    values=[]
    for m in range(i-24,i):
        with np.errstate(invalid='ignore',divide='ignore'):v=float(np.log(ser.close[m]/ser.close[m-1]))
        if math.isfinite(v):values.append(v*v)
    if i-25<ser.start_i or len(values)<23:return float('nan')
    val=math.sqrt(8760*math.fsum(values)/len(values))
    return val if val>0 else float('nan')

class Tests(unittest.TestCase):
 def test_direct_window_known_answer(self):
    ser=series();r=run(ser,[25,31,45,80]);expected=[direct(ser,i) for i in (25,31,45,80)]
    np.testing.assert_allclose(r['persistence'],expected,rtol=2e-14,atol=0)
    np.testing.assert_allclose(r['persistence'],math.sqrt(8760)*.01,rtol=3e-14)
    self.assertTrue(r['strict_past'].all());self.assertTrue((r['finite_past_returns']==24).all())
 def test_future_invariance_and_last_known_return(self):
    a=series();before=run(a,[40])['persistence'].copy();future=a.close.copy();future[40:]*=1e6
    np.testing.assert_array_equal(before,run(series(future),[40])['persistence'])
    known=a.close.copy();known[39]*=2
    self.assertGreater(run(series(known),[40])['persistence'][0],before[0])
 def test_nonconsecutive_J_is_not_shifted_target(self):
    ser=series();r=run(ser,[26,53,79]);np.testing.assert_allclose(r['persistence'],[direct(ser,i) for i in (26,53,79)],rtol=2e-14)
    # Previous accepted J origin26 is unrelated to the needed past-window origin29 at53.
    expected=A6.sigma_fut(ser.close,24,ser.start_i)[29]
    self.assertEqual(r['persistence'][1],expected)
 def test_start_and_warmup_edges(self):
    r=run(series(),[0,24,25]);self.assertTrue(np.isnan(r['persistence'][:2]).all());self.assertTrue(np.isfinite(r['persistence'][2]))
    r=run(series(start=20),[44,45]);self.assertTrue(np.isnan(r['persistence'][0]));self.assertTrue(np.isfinite(r['persistence'][1]));self.assertFalse(r['strict_past'][0])
 def test_original_null_allowance_and_zero(self):
    a=series().close.copy();a[15]=np.nan;r=run(series(a),[40]);self.assertEqual(r['finite_past_returns'][0],23);self.assertTrue(np.isfinite(r['persistence'][0]));self.assertFalse(r['strict_past'][0])
    for value in (np.nan,np.inf,0.):
        a=series().close.copy();a[25]=value;r=run(series(a),[40]);self.assertEqual(r['finite_past_returns'][0],22);self.assertTrue(np.isnan(r['persistence'][0]))
    r=run(series(np.full(80,100.)),[40]);self.assertTrue(np.isnan(r['persistence'][0]));self.assertTrue(r['strict_past'][0])
 def test_DRAFT_and_schema_and_no_solver(self):
    class Bomb:
        def __array__(self,*args):raise AssertionError('DRAFT touched input')
    with self.assertRaisesRegex(ValueError,'DRAFT'):P.persistence(A6,Bomb(),Bomb())
    for ts in (timestamps([40,40]),timestamps([41,40]),timestamps([40])+1,np.array([1],np.int32),timestamps([-1]),timestamps([81])):
        with self.assertRaises(ValueError):P.persistence(A6,series(),ts,status=P.READY)
    with patch.object(np.linalg,'solve',side_effect=AssertionError('fit')),patch.object(np.linalg,'lstsq',side_effect=AssertionError('fit')):run(series(),[40])
 def test_support_masks_not_outcome_leaking_availability(self):
    t=timestamps([40,41,42,43]);h=np.array([1,np.nan,1,1.]);e=np.array([1,1,np.inf,1.]);p=np.array([1,1,1,0.]);y=np.array([np.nan,1,1,1.])
    r=P.support_masks(t,h,e,p,y,status=P.READY);self.assertEqual(r['forecast_available']['HAR'].tolist(),[True,False,True,True]);self.assertFalse(r['three_way_common'].any())
    self.assertEqual(r['paired_HAR_EWMA'].tolist(),[False,False,False,True]);self.assertEqual(r['paired_HAR_PERSISTENCE'].tolist(),[False,False,True,False]);self.assertEqual(r['paired_EWMA_PERSISTENCE'].tolist(),[False,True,False,False])
    changed=P.support_masks(t,h,e,p,np.ones(4),status=P.READY)
    for k in ('HAR','EWMA','PERSISTENCE'):np.testing.assert_array_equal(r['forecast_available'][k],changed['forecast_available'][k])
if __name__=='__main__':unittest.main()
