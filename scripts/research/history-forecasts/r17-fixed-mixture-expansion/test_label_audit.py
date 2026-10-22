import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
import label_audit as L

class Audit(unittest.TestCase):
    def calc(self,c=None,l=None,i=1):
        return L.primitive(np.full(30,100.) if c is None else c,np.full(30,95.) if l is None else l,0,3600*i,status=L.READY)
    def test_draft(self):
        with self.assertRaisesRegex(ValueError,'DRAFT'):L.primitive([],[],0,0)
        with self.assertRaisesRegex(ValueError,'DRAFT'):L.run('/does-not-exist','x')
    def test_previous_close_and_window(self):
        c=np.full(30,100.);c[1]=200.;l=np.full(30,95.);l[0]=1.;l[25]=1.
        v=self.calc(c,l);self.assertEqual((v['spot'],v['minimum_low'],v['label']),(100.,95.,0))
        l[24]=80.;self.assertEqual(self.calc(c,l)['label'],1)
    def test_idx_zero(self):
        self.assertFalse(self.calc(i=0)['valid'])
    def test_final_full(self):
        self.assertTrue(self.calc(i=6)['valid']);self.assertEqual(self.calc(i=7)['missing'],1)
    def test_invalid(self):
        for x in [0.,-1.,np.nan,np.inf]:
            c=np.full(30,100.);c[0]=x;self.assertFalse(self.calc(c=c)['valid'])
            l=np.full(30,95.);l[5]=x;v=self.calc(l=l);self.assertFalse(v['valid']);self.assertEqual((v['missing'],v['label'],v['depth']),(1,0,None))
    def test_grid(self):
        for ts in [-3600,1,1.5]:
            with self.assertRaises(ValueError):L.primitive([100.]*30,[90.]*30,0,ts,status=L.READY)
    def test_boundary(self):
        for x in [np.nextafter(90.,0),90.,np.nextafter(90.,np.inf)]:
            v=self.calc(l=np.full(30,x));self.assertEqual(v['label'],int(np.log(x/100.)<=np.log1p(-.1)))
            self.assertEqual(v['linear_label'],bool(x<=100*.9))
    def test_differing_expression(self):
        v=self.calc(c=np.ones(30),l=np.full(30,.9));self.assertEqual(v['label'],0);self.assertTrue(v['ratio_label']);self.assertTrue(v['boundary_disagreement'])
    def test_decoder(self):
        # Tiny generated grids only; use frozen authenticated helper for pin semantics.
        p=Path(__file__).with_name('diagnostic.py');b=p.read_bytes();D=L.helper(dict(path=str(p),size=len(b),sha256=hashlib.sha256(b).hexdigest()))
        with tempfile.TemporaryDirectory() as t:
            f=Path(t).resolve()/'fixture.json.gz';d=dict(startTs=0,columns={k:[100.,None,90.] for k in ('close','low','high')})
            f.write_bytes(gzip.compress(json.dumps(d).encode()));c,l,h=L.decode(D,D.pin(f));self.assertTrue(np.isnan(c[1]));self.assertEqual(h['absent_optional_headers'],['count','stepSeconds'])
            for extra in [dict(count=4),dict(stepSeconds=60)]:
                f.write_bytes(gzip.compress(json.dumps(dict(d,**extra)).encode()))
                with self.assertRaises(ValueError):L.decode(D,D.pin(f))
            f.write_bytes(gzip.compress(b'{"startTs":0,"startTs":1}'))
            with self.assertRaises(ValueError):L.decode(D,D.pin(f))
            f.write_bytes(gzip.compress(b' '*(L.CAP+1)))
            with self.assertRaisesRegex(ValueError,'cap'):L.decode(D,D.pin(f))
if __name__=='__main__':unittest.main()
