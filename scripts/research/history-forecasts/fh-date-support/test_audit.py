"""Synthetic boundary, provenance, complete-cohort and forbidden-work contracts."""
import copy
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

import numpy as np

spec = importlib.util.spec_from_file_location('fh_date_support_audit', Path(__file__).with_name('audit.py'))
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)
Q = 1704067200
P = 1696118400


class AuditTests(unittest.TestCase):
    def arrays(self):
        return A.witness(np, np.arange(6, dtype=np.int64),
                         np.array([P-3600, P, P+3600, Q, P, Q], np.int64),
                         np.array([-1, -1, -1, -1, 0, 1], np.int8),
                         np.array([np.nan, np.nan, np.nan, np.nan, -0., .25], np.float32), P, Q)

    def test_exact_boundary_and_maturity(self):
        a = self.arrays()
        self.assertEqual(a['unknown_partition'].tolist(), [0, 1, 2, 2, -1, -1])
        s = A.summarize(np, a)
        self.assertEqual(s['unknown']['before'], dict(count=1, min=P-3600, max=P-3600))
        self.assertEqual(s['unknown']['equal'], dict(count=1, min=P, max=P))
        self.assertEqual(s['unknown']['after'], dict(count=2, min=P+3600, max=Q))
        self.assertEqual(s['state_counts'], {'0': 1, '1': 1, '-1': 4})

    def test_calendar_predecessor_not_fixed_days(self):
        self.assertEqual(A.previous_quarter(Q), P)
        self.assertEqual(A.previous_quarter(1711929600), Q)
        for q in (Q+3600, True, float(Q)):
            with self.assertRaises(ValueError): A.previous_quarter(q)

    def test_empty_unknown_extrema_are_null(self):
        a = A.witness(np, np.array([0], np.int64), np.array([Q], np.int64),
                      np.array([0], np.int8), np.array([-0.], np.float32), P, Q)
        self.assertEqual(A.summarize(np, a)['unknown']['all'], dict(count=0, min=None, max=None))
        self.assertTrue(np.signbit(a['D_original'][0]))

    def test_entire_input_refused_on_capacity(self):
        with self.assertRaises(ValueError):
            A.witness(np, np.arange(2, dtype=np.int64), np.array([P, Q], np.int64),
                      np.array([0, 1], np.int8), np.array([0., 1.], np.float32), P, Q, 1)

    def test_typed_cohort_tampering_rejected(self):
        original = self.arrays()
        variants = [('main_index', np.array([0, 0, 2, 3, 4, 5], np.int64)),
                    ('main_index', np.arange(6, dtype=np.int32)),
                    ('main_label_end', np.array([P, P, Q+3600, Q, P, Q], np.int64)),
                    ('main_label_end', np.array([P, P, P+1, Q, P, Q], np.int64)),
                    ('main_state', np.array([-1, -1, -1, -1, 7, 1], np.int8)),
                    ('D_original', np.array([np.nan]*6, np.float32)),
                    ('D_original', np.array([np.nan]*4+[np.inf,.25], np.float32)),
                    ('D_original', original['D_original'].astype(np.float64))]
        for field, replacement in variants:
            a = dict(original, **{field: replacement})
            with self.subTest(field=field), self.assertRaises(ValueError):
                A.witness(np, a['main_index'], a['main_label_end'], a['main_state'], a['D_original'], P, Q)

    def test_signed_zero_bits_bind_array_hash(self):
        a = self.arrays(); b = {k:v.copy() for k,v in a.items()};b['D_original'][4] = 0.
        self.assertNotEqual(A.summarize(np, a)['array_sha256']['D_original'], A.summarize(np, b)['array_sha256']['D_original'])

    def test_external_sha_refused_before_json_parse(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d).resolve()/'plan.json';p.write_bytes(b'not json')
            with self.assertRaisesRegex(ValueError, 'external plan SHA'): A.authenticate(p, '0'*64)

    def test_pin_symlink_and_drift_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d).resolve()/'a';p.write_bytes(b'a');v=A.pin(p);p.write_bytes(b'b')
            with self.assertRaisesRegex(ValueError,'pin drift'): A.check(v)
            q=Path(d).resolve()/'b';q.symlink_to(p)
            with self.assertRaises(ValueError):A.pin(q)

    def test_exclusive_started_file(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d).resolve()/'started.json';A.write_json(p,{'a':1})
            with self.assertRaises(FileExistsError):A.write_json(p,{'a':2})
            self.assertEqual(json.loads(p.read_text()),{'a':1})
            self.assertEqual(p.stat().st_mode&0o777,0o600)

    def test_grid_spec_keeps_original_default_asset(self):
        s=A.grid_spec(['/tmp/blind6-prices/binance-TESTUSDT-1h.json'],'blind6:TESTUSDT')
        self.assertEqual(set(s),{'key','kind','path'})
        for paths in ([],[s['path'],s['path']]):
            with self.assertRaises(ValueError):A.grid_spec(paths,s['key'])

    def test_authoritative_relative_metadata_projects_exact_content_pin(self):
        record=dict(path='/private/tmp/raw/synthetic.json',relative='raw/synthetic.json',
                    size=19,sha256='a'*64)
        original=copy.deepcopy(record)
        raw=dict(price_inputs=[record],auxiliary_inputs=[])
        expected={key:record[key] for key in ('path','size','sha256')}
        pins=A.raw_authority_pins(raw)
        self.assertEqual(pins,{record['path']:expected})
        self.assertEqual(record,original)
        self.assertEqual(set(pins[record['path']]),{'path','size','sha256'})
        for key,value in [('path','/private/tmp/raw/other.json'),('size',20),('sha256','b'*64)]:
            changed=dict(expected,**{key:value})
            self.assertNotEqual(pins.get(changed['path']),changed)
        with self.assertRaisesRegex(ValueError,'unique raw authority path'):
            A.raw_authority_pins(dict(price_inputs=[record],auxiliary_inputs=[dict(record)]))

    def mock_boundary(self, action=None):
        n=8;base=Q-28*3600
        ser=types.SimpleNamespace(base_ts=base,close=np.ones(n-1))
        calls=[]
        class Prep:
            def __init__(self, series, h, with_fbL):
                calls.append((series,h,with_fbL));self.n=n;self.okH=np.ones(n,bool)
                self.P=types.SimpleNamespace(valid={1.:np.ones(n,bool)})
                if action: action(self)
            def har_coef(self,*args):return 'UNGUARDED FIT'
            def fh_w(self,*args):return 'UNGUARDED PREDICTION'
            def sigma_H(self, coef):return np.ones(n)
            def z_of(self, sigma):return np.zeros(n),np.ones(n,bool)
        A6=types.SimpleNamespace(Prep6=Prep)
        M2=types.SimpleNamespace(fhs_predict=lambda: 'UNGUARDED PREDICTION')
        R=types.SimpleNamespace(load_series=lambda s:(ser,None,None))
        D=types.SimpleNamespace(realized=lambda s:np.array([np.nan,-0.,.1,.2,np.nan,.4,.5,.6],np.float32))
        def state(f,cut):
            x=f.astype(np.float64);return np.where(np.isfinite(x),np.where(x<=cut,0,1),-1).astype(np.int8)
        C=types.SimpleNamespace(downside_feature=lambda x,sanitize:sanitize(x).astype(np.float32),states_of=state)
        B=types.SimpleNamespace(sanitize=lambda x:np.asarray(x,float).copy())
        record=dict(n_reg=5,coef=[0.,0.,0.,0.],har_label_end_min=base+24*3600,
                    har_label_end_max=Q,library_label_end_max=Q,fallback_library_label_end_max=Q)
        pilot=dict(key='blind6:TESTUSDT',current_cutoff=Q,previous_cutoff=P)
        return R,A6,D,M2,C,B,record,pilot,calls

    def test_whole_original_boundary_then_all_mature_rows(self):
        R,A6,D,M2,C,B,record,pilot,calls=self.mock_boundary()
        a=A.reconstruct(np,R,A6,D,M2,C,B,dict(kind='grid',key=pilot['key']),record,pilot,.15)
        self.assertEqual(a['main_index'].tolist(),[0,1,2,3,4])
        self.assertEqual(a['main_state'].tolist(),[-1,0,0,1,-1])
        self.assertEqual(a['D_original'].dtype,np.dtype('float32'))
        self.assertEqual(calls[0][1:],(24,False))
        self.assertEqual(A6.Prep6(None,24,False).har_coef(),'UNGUARDED FIT')

    def test_refit_spy_and_prediction_spy_raise_and_restore(self):
        for method in ('har_coef','fh_w'):
            parts=self.mock_boundary(lambda p:getattr(p,method)())
            R,A6,D,M2,C,B,record,pilot,_=parts
            with self.assertRaisesRegex(RuntimeError,'forbidden'):
                A.reconstruct(np,R,A6,D,M2,C,B,dict(kind='grid',key=pilot['key']),record,pilot,.15)
            self.assertTrue(getattr(A6.Prep6,method) is not None)

    def test_numpy_solve_and_lstsq_tripwires_restore(self):
        R,A6,D,M2,C,B,record,pilot,_=self.mock_boundary()
        solve,lstsq=np.linalg.solve,np.linalg.lstsq
        with A.forbid_work(np,A6,M2):
            for f in (np.linalg.solve,np.linalg.lstsq,M2.fhs_predict):
                with self.assertRaisesRegex(RuntimeError,'forbidden'):f()
        self.assertIs(np.linalg.solve,solve);self.assertIs(np.linalg.lstsq,lstsq)

    def test_float32_threshold_is_not_float64_recomputation(self):
        cut=0.1
        original=np.array([cut+1e-10],np.float64)
        stored=original.astype(np.float32)
        self.assertGreater(float(stored[0]),cut)
        self.assertEqual(stored.dtype,np.dtype('float32'))
        # A different cutoff makes promotion of rounded D observable.
        cut=(float(original[0])+float(stored[0]))/2
        self.assertLessEqual(original[0],cut);self.assertGreater(float(stored[0]),cut)

    def test_summary_refuses_lost_rows_and_extra_fields(self):
        a=self.arrays();a['main_index']=a['main_index'][:-1]
        with self.assertRaises(ValueError):A.summarize(np,a)
        a=self.arrays();a['extra']=np.zeros(6)
        with self.assertRaises(ValueError):A.summarize(np,a)

    def test_run_serializes_complete_typed_witness_and_immutable_marker(self):
        """Run orchestration is real; only metadata admission and original model boundaries are synthetic."""
        R,A6,D,M2,C,B,record,pilot,_=self.mock_boundary()
        B.guard=lambda allowed,out:contextlib.nullcontext(set())
        modules={'r12_tail':R,'a6_touch':A6,'r16_dev':D,'a2_touch':M2}
        class Finder:
            def __init__(self,values):self.paths={}
            def find_spec(self,*args):return None
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            source=root/'synthetic-source';source.write_bytes(b'synthetic pinned dependency\n')
            source_pin=A.pin(source)
            planfile=root/'plan.json';planfile.write_bytes(b'{"fixture_only":true}\n')
            plan_sha=A.digest(planfile.read_bytes())
            out=root/'out'
            plan=dict(out=str(out),files=[source_pin],legacy_sources={},
                      roles={'staging_producer':source_pin,'census':source_pin,'audit':source_pin},
                      pilot=pilot,row_capacity=200000)
            metadata=(plan,dict(required_raw_paths=[str(Path('/tmp/blind6-prices/binance-TESTUSDT-1h.json').resolve())]),
                      {},dict(current_cutoff=record),.15)
            with mock.patch.object(A,'authenticate',return_value=metadata), \
                 mock.patch.object(A,'FrozenSources',Finder), \
                 mock.patch.object(A,'source_module',side_effect=lambda name,pin:B if 'producer' in name else C), \
                 mock.patch.object(A.importlib,'import_module',side_effect=lambda name:modules[name]):
                reply=A.run(str(planfile),plan_sha)
                self.assertEqual(reply,dict(complete=True,reconstruction=True,historical_bridge_parity='UNAVAILABLE'))
                self.assertEqual({p.name for p in out.iterdir()},{'started.json','witness.npz','result.json'})
                started_bytes=(out/'started.json').read_bytes()
                self.assertEqual(json.loads(started_bytes),dict(schema='q26-fh-date-support-started-v1',
                                  plan_sha256=plan_sha,reconstruction=True))
                result=json.loads((out/'result.json').read_bytes())
                self.assertEqual(result['started'],A.pin(out/'started.json'))
                self.assertEqual(result['witness'],A.pin(out/'witness.npz'))
                self.assertEqual(result['source'],source_pin)
                self.assertEqual(result['plan_sha256'],plan_sha)
                self.assertTrue(result['complete'])
                self.assertEqual(result['historical_bridge_parity'],'UNAVAILABLE')
                with np.load(out/'witness.npz',allow_pickle=False) as saved:
                    arrays={key:saved[key] for key in saved.files}
                self.assertEqual(set(arrays),set(A.FIELDS))
                for key,value in arrays.items():self.assertEqual(value.dtype,np.dtype(A.FIELDS[key]))
                self.assertEqual(arrays['main_index'].tolist(),[0,1,2,3,4])
                self.assertEqual(result['summary'],A.summarize(np,arrays))
                self.assertEqual(result['membership_sha256'],A.digest(arrays['main_index'].astype('<i8').tobytes()))
                self.assertEqual(result['summary']['unknown']['total'],2)
                with self.assertRaises(FileExistsError):A.run(str(planfile),plan_sha)
                self.assertEqual((out/'started.json').read_bytes(),started_bytes)
                # Rehash is exercised by a new synthetic run whose dependency drifts after admission.
                drift_out=root/'drift-out';plan['out']=str(drift_out)
                original=D.realized
                def drift(series):
                    source.write_bytes(b'changed dependency\n')
                    return original(series)
                D.realized=drift
                try:
                    with self.assertRaisesRegex(ValueError,'pin drift'):A.run(str(planfile),plan_sha)
                finally:D.realized=original
                self.assertTrue((drift_out/'started.json').exists())
                self.assertFalse((drift_out/'result.json').exists())


if __name__=='__main__':unittest.main()
