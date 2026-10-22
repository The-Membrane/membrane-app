"""Synthetic persistence/integration tests; no real inputs/runtime auth or jobs.
These exercise actual primary input seam/kernel/output code in-process, not a
claim of sealed cold production runtime qualification.
"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import signal
import json
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np

D=Path(__file__).resolve().parent

def load(name,path):
    import sys
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m

R=load('weighted_run_tests_runner',Path(__file__).with_name('q26-weighted-causal-primary-pair-run.py'))
I=load('weighted_run_tests_inputs',D/'q26-weighted-causal-primary-pair-input.py')
K=load('weighted_run_tests_kernel',D/'q26-weighted-causal-primary-pair.py')


def shards(root):
    # 130 invented full-catalogue shards, both cell geometries, five states/blocks.
    files=[]
    for series in range(130):
        rows=[]
        for H,k in ((24,5),(72,7)):
            for b in range(4):
                for j in range(6):rows.append((H,k,K.ORIGIN+182*b+10+j,j))
        a=np.array(rows);n=len(a);day=a[:,2];p=(.02+.06*a[:,3]).astype('float16')
        f=root/f'series-{series:03d}.npz'
        np.savez_compressed(f,name=np.array(f'fake{series}'),y=((a[:,3]+series)%3==0).astype('uint8'),
            day=day.astype('int64'),T_h=a[:,0].astype('int16'),k_i=a[:,1].astype('int8'),
            t0_i=(day*24).astype('int64'),base_ts=np.array(0,dtype='int64'),
            levels=np.array([-.02,-.03,-.05,-.07,-.10,-.15,-.20,-.25,-.30,-.40]),
            p_fH=p,p_rec12=p,p_a=p,p_f=p,p_fbL=p,boot_q=np.tile(p[:,None],(1,5)))
        files.append(str(f))
    original=dict(major={},sg_of=lambda clusters,_:{v:v%5 for v in clusters.values()})
    return files,original


class Tests(unittest.TestCase):
    def test_actual_two_cell_input_kernel_and_saved_outputs(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);src=root/'inputs';src.mkdir();out=root/'out';out.mkdir(mode=0o700)
            files,original=shards(src)
            result=R.calculate(np,K,I,original,files,out,lambda:None)
            self.assertEqual([c['cell'][:2] for c in result['cells']],[[24,5],[72,7]])
            detail=json.loads((out/'private-detail.json').read_text())
            self.assertEqual(len(detail['catalogues'][0]['names']),130)
            self.assertIn('folds',detail['cells'][0]);self.assertNotIn('folds',result['cells'][0])
            with np.load(out/'cell-24-k5.npz',allow_pickle=False) as z:
                self.assertEqual(len(z['series']),130*4*6)
                self.assertEqual(z['series'].dtype,np.dtype('int16'))
                self.assertTrue(np.isnan(z['F_lower']).any())
                self.assertEqual(z['F_eligible'].dtype,np.dtype(bool))
            self.assertEqual((out/'private-detail.json').stat().st_mode&0o777,0o600)

    def test_late_failure_preserves_first_completed_cell_checkpoint(self):
        # No rerun of synthetic 130-shard generator needed for this refusal path.
        with tempfile.TemporaryDirectory() as t:
            out=Path(t);calls=[]
            def stream(*args,**kwargs):
                H=kwargs['cell'].horizon_hours;calls.append(H)
                if H==72:raise ValueError('injected second cell refusal')
                n=4;rows=dict(p=np.full(n,.2),y=np.array([0.,1.,0.,1.]),sg=np.arange(n),
                    day=np.full(n,K.ORIGIN+10),series=np.arange(n,dtype='int16'),cluster=np.arange(n,dtype='int16'),row_index=np.arange(n,dtype='int64'))
                return dict(rows=rows,names=('a','b','c','d'),file_order=('a','b','c','d'),has_boot=False,original_joint_mask=True)
            fake=SimpleNamespace(stream_primary=stream,PrimaryCell=I.PrimaryCell)
            with self.assertRaises(ValueError):R.calculate(np,K,fake,{},[],out,lambda:None)
            self.assertEqual(calls,[24,72]);self.assertTrue((out/'cell-24-k5.npz').exists())
            self.assertFalse((out/'private-detail.json').exists())
            cp=json.loads((out/'checkpoint.json').read_text());self.assertEqual(cp['completed_cells'],1)

    def test_private_persistence_is_exclusive_and_float_bit_exact(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'a.npz';a=np.array([0.,-0.,np.nan]);R.persist(np,p,dict(a=a))
            with np.load(p,allow_pickle=False) as z:self.assertEqual(z['a'].tobytes(),a.tobytes())
            with self.assertRaises(FileExistsError):R.persist(np,p,dict(a=a))

    def test_draft_refuses_and_restores_alarm(self):
        before=signal.getsignal(signal.SIGALRM)
        with self.assertRaises(ValueError):R.run(dict(schema='q26-weighted-causal-primary-pair-run-request-v1',parent_admitted=False))
        self.assertEqual(signal.getsignal(signal.SIGALRM),before)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL)[0],0)

    def test_actual_cold_cli_draft_and_output_binding(self):
        import subprocess,sys
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);out=root/'unused';request=root/'request.json'
            request.write_text(json.dumps(dict(schema='q26-weighted-causal-primary-pair-run-request-v1',parent_admitted=False,out=str(out))))
            base=[sys.executable,'-B',str(Path(R.__file__)),'--request',str(request),'--sha256',R.pin(request)['sha256'],'--out']
            draft=subprocess.run(base+[str(out)],capture_output=True,text=True,timeout=5)
            self.assertNotEqual(draft.returncode,0);self.assertIn('DRAFT not admitted',draft.stderr)
            mismatch=subprocess.run(base+[str(root/'other')],capture_output=True,text=True,timeout=5)
            self.assertNotEqual(mismatch.returncode,0);self.assertIn('CLI/request output binding',mismatch.stderr)
            self.assertFalse(out.exists())

    def test_pin_tamper_and_symlink_refused(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'a';p.write_text('before');q=R.pin(p);p.write_text('after')
            with self.assertRaises(ValueError):R.checked(q)
            link=Path(t)/'alias';link.symlink_to(p)
            with self.assertRaises(ValueError):R.checked(R.pin(link))

if __name__=='__main__':unittest.main()
