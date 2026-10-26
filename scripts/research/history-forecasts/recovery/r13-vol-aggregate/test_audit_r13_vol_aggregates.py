"""Pure synthetic aggregate fixtures; no recovered summary metric parsing."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import audit_r13_vol_aggregates as A
HORIZONS={'1h':1,'3h':3,'12h':12,'1d':24,'3d':72}


def fixture(zero=False):
 def record(n,w,base,new):return dict(rows=n,weeks=w,mse_fH=base,mse_new=new,mean_diff=new-base,se=.2,p_one_sided=.4,median_sq_fH=0. if zero else .3,median_sq_new=.4,weeks_to_80=None)
 v={}
 for h in HORIZONS:
  b12={k:record(10,2,0. if zero else 2.,x) for k,x in [('lsQ',3.),('lsW',1.6)]}
  b13={k:record(30,3,0. if zero else 4.,x) for k,x in [('lsQ',3.),('lsW',3.2)]}
  root={k:record(40,4,0. if zero else 3.5,(10*b12[k]['mse_new']+30*b13[k]['mse_new'])/40) for k in ('lsQ','lsW')};root.update(b12=b12,b13a=b13);v[h]=root
 return dict(schema='q26-r13.1-dev/1',vol=v,cells={'unknown_touch_metrics':[123]},private_manifest='must never copy')


class VolTests(unittest.TestCase):
 def test_all30_and_ratio_arithmetic_projection(self):
  rows=A.project(fixture(),HORIZONS);self.assertEqual(len(rows),30)
  self.assertEqual({(r['horizon'],r['cohort'],r['variant']) for r in rows},{(h,c,v) for h in HORIZONS for c in ('pooled','b12','b13a') for v in ('lsQ','lsW')})
  r=rows[0];self.assertEqual(r['model'],'fHQ');self.assertEqual(r['derived_mean_loss_difference'],-.5);self.assertEqual(r['derived_loss_ratio'],3/3.5)
  text=json.dumps(rows);self.assertNotIn('unknown_touch_metrics',text);self.assertNotIn('private_manifest',text);self.assertIn('legacy_descriptive_UNVALIDATED',text)
 def test_zero_reference_null_not_infinite(self):
  rows=A.project(fixture(True),HORIZONS)
  self.assertTrue(all(r['derived_loss_ratio'] is None and r['derived_fractional_loss_reduction'] is None and r['ratio_status']=='zero_reference' for r in rows))
  json.dumps(rows,allow_nan=False)
 def test_closure_missing_and_nonfinite_refused(self):
  for kind in ('horizon','cohort','variant','field','count','finite','difference','pooled'):
   d=fixture();x=d['vol']['1h']
   if kind=='horizon':del d['vol']['3d']
   elif kind=='cohort':del x['b13a']
   elif kind=='variant':x['b12']['extra']=x['b12']['lsQ']
   elif kind=='field':del x['lsQ']['weeks_to_80']
   elif kind=='count':x['lsQ']['rows']=0
   elif kind=='finite':x['lsQ']['mse_new']=float('nan')
   elif kind=='difference':x['lsQ']['mean_diff']+=.01
   else:x['b12']['lsQ']['rows']+=1
   with self.assertRaises(ValueError,msg=kind):A.project(d,HORIZONS)
 def test_source_literal_and_draft_refusal(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'source.py';p.write_text('HS=(1,3,12,24,72)\n');self.assertEqual(A.literals(p,'HS'),(1,3,12,24,72))
   with self.assertRaisesRegex(ValueError,'missing'):A.literals(p,'TL')
   q=Path(t)/'draft.json';q.write_text(json.dumps(dict(admission_status='DRAFT_PENDING_REVIEW')))
   with self.assertRaisesRegex(ValueError,'DRAFT'):A.authenticate(q,A.pin(q)['sha256'])
 def test_legacy_null_and_zero_denominator_semantics(self):
  d=fixture();d['vol']['1h']['lsQ'].update(se=None,p_one_sided=None,weeks_to_80=None)
  self.assertIsNone(A.project(d,HORIZONS)[0]['legacy_descriptive_UNVALIDATED']['se'])
  d['vol']['1h']['lsQ']['se']=-1
  with self.assertRaisesRegex(ValueError,'SE sign'):A.project(d,HORIZONS)
 def test_serialization_and_partial_failure(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);data=root/'synthetic.json';data.write_text(json.dumps(fixture()));req=root/'request.json';req.write_text('{}');digest=A.pin(req)['sha256']
   r=dict(output=str((root/'ok').resolve()),pins={'summary':A.pin(data)},runtime=A.runtime())
   with patch.object(A,'authenticate',return_value=(r,HORIZONS)):A.execute(req,digest,root/'ok')
   result=json.loads((root/'ok'/'result.json').read_text());self.assertEqual(len(result['comparisons']),30);self.assertNotIn('private_manifest',result);self.assertTrue(result['complete'])
   data.write_text('{');r['pins']['summary']=A.pin(data);r['output']=str((root/'bad').resolve())
   with patch.object(A,'authenticate',return_value=(r,HORIZONS)):
    with self.assertRaises(json.JSONDecodeError):A.execute(req,digest,root/'bad')
   failure=json.loads((root/'bad'/'failure.json').read_text());self.assertEqual(failure['stage'],'input');self.assertEqual(failure['exception_class'],'JSONDecodeError')

if __name__=='__main__':unittest.main()
