"""Mock-only parity orchestration, exact-byte descriptors and read-guard checks."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import r16_shallow_projection_parity as P
from test_r16_shallow_reconstruction import result


def fake_scope(root):
    return dict(base_scope=dict(datasets=str(root),price_inputs=[dict(path=str(root/'binance-klines/BTCUSDT-1h.json'))],
        auxiliary_inputs=[],summary=dict(path=str(root/'summary')),price_manifest=dict(path=str(root/'prices'))))


def arm_receipt(sid,arm,root=None):
    key=P.SELECTED[sid]; rows=P.R.A.retain_series_rows(result(key),{key:sid})
    return dict(complete=True,sid=sid,arm=arm,key=key,descriptors=P.describe_rows(rows),scope_sha256='digest',
        memory_npz_roundtrip=True,audit_violations={'total':0,'attempts':[]},opened_inputs={str((root/'binance-klines/BTCUSDT-1h.json').resolve()):1} if root else {})


class ParityTests(unittest.TestCase):
    def test_bitwise_nan_dtype_and_order_mismatches_rejected(self):
        a=np.array([0x7fc00001],np.uint32).view(np.float32)
        b=np.array([0x7fc00002],np.uint32).view(np.float32)
        da,db=P.descriptor(a),P.descriptor(b)
        self.assertEqual(da['nan_mask_sha256'],db['nan_mask_sha256']);self.assertNotEqual(da,db)
        original=arm_receipt(0,'original');projected=copy.deepcopy(original);projected['arm']='projection'
        self.assertTrue(P.compare(original,projected))
        for x,y in ((a,b),(np.array([1.],np.float32),np.array([1.],np.float64)),
                    (np.array([1.,2.]),np.array([2.,1.]))):
            projected=copy.deepcopy(original);projected['descriptors']['1']['fields']['lsH']=P.descriptor(y)
            src=copy.deepcopy(original);src['descriptors']['1']['fields']['lsH']=P.descriptor(x)
            with self.assertRaises(ValueError):P.compare(src,projected)

    def test_empty_or_absent_horizons_cannot_pass(self):
        rows=P.R.A.retain_series_rows(result(P.SELECTED[0]),{P.SELECTED[0]:0})
        del rows[12]
        with self.assertRaises(ValueError):P.describe_rows(rows)
        rows=P.R.A.retain_series_rows(result(P.SELECTED[0]),{P.SELECTED[0]:0})
        rows[12]={k:v[:0] for k,v in rows[12].items()}
        with self.assertRaises(ValueError):P.describe_rows(rows)

    def test_read_guard_paths_modes_fd_and_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'datasets';root.mkdir();good=root/'allowed';bad=root/'reserved'
            good.write_bytes(b'ok');bad.write_bytes(b'forbidden');link=root/'alias';link.symlink_to(bad)
            external=Path(temp)/'outside';external.write_bytes(b'external');escape=root/'escape';escape.symlink_to(external)
            hook,counts,ledger=P.read_audit(root,[good])
            hook('open',(str(good),'r',0));hook('open',(str(good),'rb',0));hook('open',(3,'r',0))
            self.assertEqual(counts[str(good.resolve())],2)
            for path,mode,flags in ((bad,'r',0),(link,'r',0),(good,'w',os.O_WRONLY),(good,'r+',os.O_RDWR),(escape,'r',0)):
                with self.assertRaises(P.AuditViolation):hook('open',(str(path),mode,flags))
            hook('open',(str(Path(temp)/'outside'),'r',0))

    def test_actual_legacy_broad_exception_cannot_swallow_audit_denial(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);bad=root/'unlisted.json';hook,reads,ledger=P.read_audit(root,[])
            def denied(path,*args,**kwargs):return hook('open',(path,'rb',0))
            with patch('builtins.open',side_effect=denied):
                with self.assertRaises(P.AuditViolation):P.R.A.D.load_volume(dict(kind='grid',path=str(bad)))
            self.assertEqual(ledger['total'],1);self.assertEqual(reads,{})

    def test_bare_swallower_still_cannot_complete_child(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);scope=fake_scope(root);scope['base_scope']['canonical_keys']=[P.SELECTED[0]];installed=[]
            def swallowed(spec):
                try:installed[0]('open',(str(root/'unlisted'),'r',0))
                except BaseException:pass
                return result(spec['key'])
            with patch.object(P,'preflight',return_value=(scope,[dict(key=P.SELECTED[0])])),\
                 patch.object(P.R,'budget',return_value=3_000_000_000),patch.object(P.sys,'addaudithook',side_effect=installed.append),\
                 patch.dict(P.R.A.D._BTC,{},clear=True),patch.dict(P.R.A.D.R12._CHAIN,{},clear=True),\
                 patch.object(P.R.A.D,'init_btc'),patch.object(P.R.A.D,'task',side_effect=swallowed):
                with self.assertRaises(P.AuditViolation):P.child(root/'scope','digest',0,'original',root/'child.json')
            receipt=P.R.A.read_unique_json(root/'child.json')
            self.assertFalse(receipt['complete']);self.assertEqual(receipt['audit_violations']['total'],1)

    def test_aggregate_output_cap_is_checked_before_write(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'existing').write_bytes(b'x'*(P.OUTPUT_LIMIT-100))
            with self.assertRaises(RuntimeError):P.bounded_json(root/'new.json',{'value':'x'*200})
            self.assertFalse((root/'new.json').exists())

    def test_fixed_ten_fresh_subprocess_order_and_no_generation_approval(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);calls=[]
            def fake(cmd,**kwargs):
                sid=int(cmd[cmd.index('--sid')+1]);arm=cmd[cmd.index('--arm')+1]
                path=Path(cmd[cmd.index('--receipt')+1]);P.bounded_json(path,arm_receipt(sid,arm,root));calls.append((sid,arm))
                self.assertLessEqual(kwargs['timeout'],600);self.assertEqual(kwargs['env']['OMP_NUM_THREADS'],'1')
                self.assertEqual(kwargs['stderr'],subprocess.DEVNULL)
                return subprocess.CompletedProcess(cmd,0,stderr=b'')
            with patch.object(P,'preflight',return_value=(fake_scope(root),[])),patch.object(P.R,'budget',return_value=3_000_000_000),\
                 patch.object(P.subprocess,'run',side_effect=fake),patch.object(P.R.A.D,'task') as producer:
                final=P.run(root/'scope','digest',root/'out')
            self.assertEqual(calls,[(sid,arm) for sid in P.SELECTED for arm in ('original','projection')])
            self.assertTrue(final['all_five_exact']);self.assertEqual(final['child_calls'],10)
            self.assertFalse(final['projection_approved']);producer.assert_not_called()

    def test_failure_stops_with_prefix_preserved_and_no_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);calls=[]
            def fake(cmd,**kwargs):
                sid=int(cmd[cmd.index('--sid')+1]);arm=cmd[cmd.index('--arm')+1]
                path=Path(cmd[cmd.index('--receipt')+1]);calls.append((sid,arm))
                if len(calls)==3:return subprocess.CompletedProcess(cmd,9,stderr=b'bounded failure')
                P.bounded_json(path,arm_receipt(sid,arm,root));return subprocess.CompletedProcess(cmd,0,stderr=b'')
            with patch.object(P,'preflight',return_value=(fake_scope(root),[])),patch.object(P.R,'budget',return_value=3_000_000_000),\
                 patch.object(P.subprocess,'run',side_effect=fake):
                with self.assertRaises(RuntimeError):P.run(root/'scope','digest',root/'out')
                with self.assertRaises(FileExistsError):P.run(root/'scope','digest',root/'out')
            status=P.R.A.read_unique_json(root/'out'/'run.json')
            self.assertEqual(len(calls),3);self.assertEqual(len(status['completed']),1)
            self.assertFalse(status['projection_approved']);self.assertFalse((root/'out'/'manifest.json').exists())
            self.assertTrue((root/'out'/'projection-000.json').exists())

    def test_child_timeout_is_terminal_without_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with patch.object(P,'preflight',return_value=(fake_scope(root),[])),patch.object(P.R,'budget',return_value=3_000_000_000),\
                 patch.object(P.subprocess,'run',side_effect=subprocess.TimeoutExpired('child',600)) as child:
                with self.assertRaises(TimeoutError):P.run(root/'scope','digest',root/'out')
            self.assertEqual(child.call_count,1)
            self.assertFalse(P.R.A.read_unique_json(root/'out'/'run.json')['complete'])

    def test_parent_rejects_unlisted_reads_or_missing_codec_proof(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);scope=fake_scope(root);value=arm_receipt(0,'original',root)
            P.validate_receipt(value,0,'original',scope,'digest')
            bad=copy.deepcopy(value);bad['opened_inputs'][str(root/'reserved')]=1
            with self.assertRaises(ValueError):P.validate_receipt(bad,0,'original',scope,'digest')
            bad=copy.deepcopy(value);bad['memory_npz_roundtrip']=False
            with self.assertRaises(ValueError):P.validate_receipt(bad,0,'original',scope,'digest')

    def test_deadline_checked_after_child_before_accepting_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            def fake(cmd,**kwargs):
                sid=int(cmd[cmd.index('--sid')+1]);arm=cmd[cmd.index('--arm')+1]
                P.bounded_json(Path(cmd[cmd.index('--receipt')+1]),arm_receipt(sid,arm,root))
                return subprocess.CompletedProcess(cmd,0)
            with patch.object(P,'preflight',return_value=(fake_scope(root),[])),patch.object(P.R,'budget',return_value=3_000_000_000),\
                 patch.object(P.time,'monotonic',side_effect=[0,0,3601]),patch.object(P.subprocess,'run',side_effect=fake) as child:
                with self.assertRaises(TimeoutError):P.run(root/'scope','digest',root/'out')
            self.assertEqual(child.call_count,1);self.assertFalse((root/'out'/'manifest.json').exists())

    def test_disk_failure_before_first_child(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with patch.object(P,'preflight',return_value=(fake_scope(root),[])),patch.object(P.R,'budget',side_effect=RuntimeError('disk')),\
                 patch.object(P.subprocess,'run') as child:
                with self.assertRaises(RuntimeError):P.run(root/'scope','digest',root/'out')
            child.assert_not_called();self.assertFalse((root/'out').exists())


if __name__=='__main__':unittest.main()
