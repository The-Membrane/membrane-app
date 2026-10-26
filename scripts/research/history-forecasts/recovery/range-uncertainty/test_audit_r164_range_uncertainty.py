"""Synthetic tests only; never accesses historical outcome packets."""
from fractions import Fraction
import importlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
import numpy as np
import audit_r164_range_uncertainty as A


class AuditTests(unittest.TestCase):
    def test_weighted_laws_and_analytic_controls(self):
        records=[]
        for law,n in [('independent',256),('shared',81)]:
            ww=list(A.worlds(law));self.assertEqual(len(ww),n);self.assertEqual(len({y.tobytes() for y,w in ww}),n);self.assertEqual(sum(w for y,w in ww),1)
            self.assertEqual(sum(w*int(y[0,0]) for y,w in ww),Fraction(1,4))
            self.assertEqual(sum(w*int(y[0,1]) for y,w in ww),Fraction(3,4))
            for j,(y,w) in enumerate(ww):
                count=int(((1-y[:,0]).sum()+y[:,1].sum())*5)
                records.append(dict(law=law,index=j,weight=[w.numerator,w.denominator],covered_counts={c:count for c in A.CONSTRUCTIONS},
                    cell={'constructions':{c:dict(coverage_ci90=[0.,1.],coverage_se_cgm=None) for c in A.CONSTRUCTIONS}},
                    exact_CGM={c:dict(net=[0,1],sign=0,source_positive_on_exact_zero=False) for c in A.CONSTRUCTIONS},part_b=[dict(construction=c,coverage_dev=count/40,se_proj=1/3.29,tost_power=0.,width_median_pts=50.,width_leg=0.,joint=0.) for c in A.CONSTRUCTIONS]))
        agg=A.aggregate(records)
        self.assertEqual(agg['independent']['PU']['variance']['value'],.0234375)
        self.assertEqual(agg['shared']['DIS']['variance']['value'],.015625)
        self.assertEqual(agg['shared']['CAL']['CGM_null_mass']['value'],1.)
        self.assertIsNone(agg['shared']['CAL']['CGM_positive_only_mean_square_SE'])

    def test_fixture_members_hash_groups_and_bin_boundary(self):
        y=np.array([[0,1],[1,0],[0,0],[1,1]],np.int8)
        with tempfile.TemporaryDirectory() as t:
            d=Path(t)/'fixture';A.write_fixture(d,y);A.validate_fixture(d,y)
            self.assertEqual(sum(len(np.load(p)['y']) for p in d.iterdir()),640)
            (d/'extra.npz').write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError,'member closure'):A.validate_fixture(d,y)
        with tempfile.TemporaryDirectory() as t:
            d=Path(t)/'fixture';A.write_fixture(d,y)
            f=d/(A.NAMES[0]+'.npz');v=A.fixture_arrays(y,A.NAMES[0]);v['day'][0]+=1;np.savez(f,**v)
            with self.assertRaisesRegex(ValueError,'member changed'):A.validate_fixture(d,y)

    def test_exact_CGM_cancellation_is_recorded_not_repaired(self):
        diagnostics={};cell,counts=A.reference(np.zeros((4,2),np.int8),diagnostics)
        self.assertEqual(diagnostics['PU']['net'],[0,1]);self.assertEqual(diagnostics['PU']['sign'],0)
        self.assertTrue(diagnostics['PU']['source_positive_on_exact_zero'])
        self.assertGreater(cell['constructions']['PU']['coverage_se_cgm'],0.)
        self.assertEqual(A.exact_cgm(np.ones((2,5,4),bool)),Fraction(0))

    def test_quantile_and_reference_math(self):
        self.assertEqual(A.weighted_quantile([0,1,2,3],[.5])[0],1.)
        cell,counts=A.reference(np.array([[0,1],[0,1],[0,1],[0,1]],np.int8))
        self.assertEqual(counts['PU'],40);self.assertEqual(cell['constructions']['PU']['coverage_groups'],1.)
        self.assertIsNone(cell['constructions']['PU']['coverage_se_cgm'])
        self.assertEqual(cell['constructions']['PU']['interval_score_pts'],50.)
        self.assertEqual(cell['constructions']['PU']['T2_bins'],2)

    def test_actual_producer_and_independent_rng_replay(self):
        # Two prechosen synthetic worlds: endpoints plus mixed nonnested bin outcomes.
        import sys
        sys.path.insert(0,str(A.SOURCE));R=importlib.import_module('r164_ranges')
        for y in [np.zeros((4,2),np.int8),np.array([[0,1],[1,0],[0,0],[1,1]],np.int8)]:
            with tempfile.TemporaryDirectory() as t:
                d=Path(t)/'fixture';A.write_fixture(d,y);out=Path(t)/'world.json'
                with redirect_stdout(io.StringIO()):R.run(str(d),str(out),nominal=.9,seed=A.SEED,shuffle_blocks=False,horizons=(24,))
                ref,counts=A.reference(y);self.assertLess(A.reconcile(A.read(out)['cells'][0],ref),1e-12)
                P=importlib.import_module('r164_power')
                actual=P.part_b(str(out),[('1d','alts',0,c) for c in A.CONSTRUCTIONS],.9,.05,10.,1.)
                self.assertLess(A.reconcile(actual,A.plugin_reference(ref)),1e-12)

    def test_plugin_zero_SE_boundary(self):
        cell={'constructions':{c:dict(coverage_groups=.9,coverage_ci90=[.9,.9],width_median_pts=10.) for c in A.CONSTRUCTIONS}}
        got=A.plugin_reference(cell)
        self.assertTrue(all(v['joint']==1. and v['se_proj']==0. for v in got))
        cell['constructions']['PU']['coverage_groups']=.75
        self.assertEqual(A.plugin_reference(cell)[0]['joint'],0.)
        import sys
        sys.path.insert(0,str(A.SOURCE));P=importlib.import_module('r164_power')
        with tempfile.TemporaryDirectory() as t:
            out=Path(t)/'synthetic.json';out.write_text(json.dumps({'cells':[dict(T='1d',tier='alts',level=0,**cell)]}))
            actual=P.part_b(str(out),[('1d','alts',0,c) for c in A.CONSTRUCTIONS],.9,.05,10.,1.)
            self.assertEqual(A.reconcile(actual,A.plugin_reference(cell)),0.)

    def test_mismatch_refused(self):
        with self.assertRaisesRegex(ValueError,'numeric mismatch'):A.reconcile(1.,1.001)
        with self.assertRaisesRegex(ValueError,'field mismatch'):A.reconcile({'x':1},{'y':1})
        with self.assertRaisesRegex(ValueError,'unadmitted'):A.authenticate({'schema':A.SCHEMA,'status':'DRAFT_NOT_ADMITTED'})
        env={k:'1' for k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS')}
        with patch.dict(os.environ,env):
            req=dict(schema=A.SCHEMA,status='READY_PARENT_REVIEWED',policy=A.POLICY,runtime=A.runtime(),source_pins=[])
            with self.assertRaisesRegex(ValueError,'source closure'):A.authenticate(req)
            req['source_pins']=[A.pin(A.SOURCE/n) for n in A.CLOSURE];req['runtime_proof_pin']=dict(sha256='b0111f8eb81243ee27e6514b7bf13c32135c2ef50a214e5d7d1d031800931852')
            req['helper_pin']=A.pin(A.__file__);req['test_pin']=A.pin(__file__);req['source_pins'][0]['sha256']='0'*64
            with self.assertRaisesRegex(ValueError,'source changed'):A.authenticate(req)

    def test_read_write_network_boundary(self):
        with tempfile.TemporaryDirectory() as t:
            out=Path(t)/'out';out.mkdir();secret=Path(t)/'historical.npz';secret.write_bytes(b'synthetic')
            with A.body_guard(out,[]):
                with self.assertRaisesRegex(PermissionError,'unadmitted'):secret.read_bytes()
                with self.assertRaisesRegex(PermissionError,'write outside'):secret.write_bytes(b'no')
                import socket
                with self.assertRaisesRegex(PermissionError,'external'):socket.getaddrinfo('example.com',80)
                (out/'ok.json').write_text('{}')

    def test_failed_stage_receipt_preserved(self):
        # Admission is separately tested; inject an I/O failure before any producer run.
        with tempfile.TemporaryDirectory() as t:
            out=Path(t)/'run'
            req=dict(source_pins=[A.pin(A.SOURCE/n) for n in A.CLOSURE],helper_pin=A.pin(A.__file__),test_pin=A.pin(__file__))
            with patch.object(A,'authenticate'),patch.object(A,'write_fixture',side_effect=OSError('synthetic I/O failure')):
                with self.assertRaises(OSError):A.execute(req,out)
            failure=json.loads((out/'failure.json').read_text())
            self.assertEqual(failure['stage'],'fixture');self.assertEqual(failure['world_ordinal'],0)
            self.assertEqual(failure['exception_class'],'OSError');self.assertFalse(failure['complete'])

if __name__=='__main__':unittest.main()
