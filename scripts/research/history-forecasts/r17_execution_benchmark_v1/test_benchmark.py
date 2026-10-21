import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('benchmark',Path(__file__).with_name('benchmark.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
class BenchmarkTests(unittest.TestCase):
 def test_frozen_source_pin(self):b.verify_source()
 def test_shapes_and_determinism(self):
  import numpy as np
  a,e=b.fixture(100,20);c,f=b.fixture(100,20)
  self.assertEqual(a['Xbase'].shape,(100,12));self.assertEqual(a['Xshape'].shape,(100,6));self.assertEqual(e['y'].shape,(20,5))
  for k in a:self.assertTrue(np.array_equal(a[k],c[k],equal_nan=True))
  self.assertTrue((np.diff(a['y'].astype(int),axis=1)>=0).all())
 def test_exact_frozen_expansion(self):
  import numpy as np
  m=b.load_source();d,_=b.fixture(20,5);x,y,z=m.expand(d,np.arange(20),True)
  self.assertEqual(x.shape,(100,19));self.assertEqual(y.shape,(100,));self.assertEqual(z.shape,(100,));np.testing.assert_array_equal(x[:5,-1],np.log1p(m.BARRIERS))
 def test_parity_requires_identical_vectors(self):
  import numpy as np
  a=np.array([.1,.2]);self.assertTrue(b.prediction_identity(a,a.copy())['bitwise_equal'])
  with self.assertRaises(AssertionError):b.prediction_identity(a,np.nextafter(a,np.ones(2)))
 def test_signed_zero_and_dtype_parity_rejected(self):
  import numpy as np
  for a,c in [(np.array([0.]),np.array([-0.])),(np.array([.5],dtype=np.float64),np.array([.5],dtype=np.float32))]:
   with self.assertRaises(AssertionError):b.prediction_identity(a,c)
 def test_sample_units_whole_group(self):
  r=b.parse_sample('10 1 9 100 S\n11 10 11 200 R\n12 11 11 50 S\n13 1 4 999 ?\n',10,11)
  self.assertEqual(sum(x[1] for x in r),350*1024)
 def test_unknown_owned_fail_closed(self):
  with self.assertRaises(ValueError):b.parse_sample('10 1 9 100 S\n11 10 11 0 ?\n',10,11)
 def test_missing_parent_and_malformed_fail(self):
  for s in ['11 10 11 100 S\n','10 1 x 100 S\n','10 1 9 -1 S\n','10 1 9 100 S extra\n']:
   with self.assertRaises(ValueError):b.parse_sample(s,10,11)
 def test_deadline_fail_closed(self):
  with patch.object(b.time,'monotonic',return_value=100.):
   with self.assertRaises(TimeoutError):b.guard(11,99.)
 def test_disk_fail_closed(self):
  with patch.object(b.shutil,'disk_usage',return_value=type('D',(),{'free':0})()):
   with self.assertRaisesRegex(RuntimeError,'disk reserve'):b.guard(11,b.time.monotonic()+1)
 def test_descendants_include_tracker_and_exclude_observer(self):
  rows=b.parse_sample('10 1 9 100 S\n11 10 9 200 R\n12 10 9 50 S\n13 10 9 0 ?\n14 11 11 70 S\n',10,11,13)
  self.assertEqual(sum(x[1] for x in rows),420*1024)
if __name__=='__main__':unittest.main()
