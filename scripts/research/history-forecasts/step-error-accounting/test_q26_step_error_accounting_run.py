import gzip,hashlib,importlib.util,json,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('runner',Path(__file__).with_name('q26-step-error-accounting-run.py'));R=importlib.util.module_from_spec(s);s.loader.exec_module(R)
class Decode(unittest.TestCase):
 def test_actual_gzip_json_boundary(self):
  raw=b'{"rows":[{"y":1.0,"p_garch":0.0}]}';self.assertEqual(R.decode(gzip.compress(raw),hashlib.sha256(raw).hexdigest()),json.loads(raw))
 def test_incorrect_published_identity(self):
  with self.assertRaisesRegex(ValueError,'identity'):R.decode(gzip.compress(b'{}'),'0'*64)
 def test_bounded_expansion(self):
  raw=b' '*100
  with self.assertRaisesRegex(ValueError,'cap'):R.decode(gzip.compress(raw),hashlib.sha256(raw).hexdigest(),cap=50)
 def test_nonfinite_json(self):
  raw=b'{"value":NaN}'
  with self.assertRaisesRegex(ValueError,'nonfinite'):R.decode(gzip.compress(raw),hashlib.sha256(raw).hexdigest())
 def test_truncated_transport(self):
  raw=gzip.compress(b'{}')[:-2]
  with self.assertRaises((EOFError,OSError)):R.decode(raw,hashlib.sha256(b'{}').hexdigest())
if __name__=='__main__':unittest.main()
