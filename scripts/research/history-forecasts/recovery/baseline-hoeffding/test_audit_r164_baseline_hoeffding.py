"""Pure synthetic tests; no accepted production result is read or aggregated."""
from copy import deepcopy
from fractions import Fraction as F
import itertools
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import audit_r164_baseline_hoeffding as A


def synthetic_input():
 rows=[];summary={}
 for law in ('independent','shared'):
  sequence=itertools.product((0,1),repeat=8) if law=='independent' else itertools.product(range(3),repeat=4)
  for index,state in enumerate(sequence):
   if law=='independent':
    pairs=list(zip(state[::2],state[1::2]));weight=F(1)
    for low,high in pairs:weight*=F(1 if low else 3,4)*F(3 if high else 1,4)
   else:pairs=[((0,0),(0,1),(1,1))[s] for s in state];weight=F(math.prod(2 if s==1 else 1 for s in state),256)
   count=5*sum(int(low==0)+int(high==1) for low,high in pairs)
   rows.append(dict(law=law,index=index,weight=[weight.numerator,weight.denominator],covered_counts={c:count for c in ('PU','DIS')},cell={'constructions':{c:dict(n_groups=40,rows_with_range=640,coverage_groups=count/40,coverage_rows=count/40,coverage_ci90=[0.,1.]) for c in ('PU','DIS')}}))
  summary[law]={c:dict(CI_inclusion_mass=A.exact(F(1))) for c in ('PU','DIS')}
 return dict(complete=True,worlds=rows,summary=summary)


class BaselineTests(unittest.TestCase):
 def test_exact_law_and_Hoeffding_control(self):
  v=A.audit(synthetic_input());self.assertEqual(len(v['comparisons']),674)
  for c in ('PU','DIS'):
   self.assertEqual(A.frac(v['summary']['independent'][c]['hoeffding']['inclusion']),F(65511,65536))
   self.assertEqual(A.frac(v['summary']['shared'][c]['hoeffding']['inclusion']),1)
   self.assertEqual(A.frac(v['summary']['independent'][c]['original']['inclusion']),1)
   self.assertEqual(A.frac(v['summary']['shared'][c]['hoeffding']['collapse_1_1_mass']),0)
 def test_common_support_and_boundary_widths(self):
  radius=math.sqrt(math.log(20)/8);self.assertEqual(A.RADIUS,radius)
  self.assertEqual(A.interval(F(0)),[0.,radius]);self.assertEqual(A.interval(F(1)),[1-radius,1.])
  self.assertEqual(A.interval(F(1,2)),[0.,1.]);self.assertFalse(A.contains(A.interval(F(1,8)),F(3,4)))
  self.assertTrue(A.contains(A.interval(F(1,4)),F(3,4)))
 def test_collapse_original_and_width_average(self):
  rows=[dict(weight=[1,4],original=dict(CI=[1.,1.],includes_theta=False)),dict(weight=[3,4],original=dict(CI=[0.,1.],includes_theta=True))]
  got=A.summarize(rows,'original');self.assertEqual(A.frac(got['collapse_1_1_mass']),F(1,4));self.assertEqual(got['expected_CI_width'],.75)
  self.assertEqual(A.frac(got['miss_mass']),F(1,4));self.assertEqual(got['minimum_CI_width'],0.)
 def test_closure_probability_and_baseline_tamper_refused(self):
  original=synthetic_input()
  for change in ('duplicate','weight','count','CI','support'):
   d=deepcopy(original)
   if change=='duplicate':d['worlds'][-1]=d['worlds'][0]
   elif change=='weight':d['worlds'][0]['weight']=[2,3]
   elif change=='count':d['worlds'][0]['covered_counts']['PU']+=1
   elif change=='support':d['worlds'][0]['cell']['constructions']['PU']['n_groups']=39
   else:d['worlds'][0]['cell']['constructions']['PU']['coverage_ci90']=[.8,.2]
   with self.assertRaises(ValueError,msg=change):A.audit(d)
 def test_draft_refuses_before_inputs(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'draft.json';p.write_text(json.dumps(dict(admission_status='DRAFT_PENDING_REVIEW')))
   with self.assertRaisesRegex(ValueError,'DRAFT'):A.authenticate(p,A.pin(p)['sha256'])
 def test_serialization_and_failed_stage(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);data=root/'synthetic.json';data.write_text(json.dumps(synthetic_input()));req=root/'request.json';req.write_text('{}');digest=A.pin(req)['sha256']
   r=dict(output=str((root/'success').resolve()),pins={'input_result':A.pin(data)})
   with patch.object(A,'authenticate',return_value=r):A.execute(req,digest,root/'success')
   result=json.loads((root/'success'/'result.json').read_text());self.assertTrue(result['complete']);self.assertEqual(len(result['comparisons']),674);self.assertLess((root/'success'/'result.json').stat().st_size,1000000)
   data.write_text('{');r['pins']['input_result']=A.pin(data);r['output']=str((root/'failure').resolve())
   with patch.object(A,'authenticate',return_value=r):
    with self.assertRaises(json.JSONDecodeError):A.execute(req,digest,root/'failure')
   failure=json.loads((root/'failure'/'failure.json').read_text());self.assertEqual(failure['stage'],'input');self.assertEqual(failure['exception_class'],'JSONDecodeError')

if __name__=='__main__':unittest.main()
