"""Synthetic merge-only fixtures; never run producer, fit or neural execution."""
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import r16_shallow_merge_runner as M
from test_r16_shallow_reconstruction import result


class MergeTests(unittest.TestCase):
    def fixture(self,root,stack):
        keys=['b','a'];shards=root/'shards'
        M.R.A.collect_shards([result('a',100),result('b')],shards,keys)
        stack.enter_context(patch.dict(M.EXPECTED,{'1':6,'3':6,'12':6},clear=True))
        scope=dict(evidence=dict(shards=str(shards),canonical_keys=keys,datasets=str(root/'datasets'),
            scope=dict(sha256='frozen-generation'),manifest=dict(sha256='frozen-manifest',path=str(root/'generation'/'manifest.json'))),
            bounds=M.merge_bounds(),interpretation='Projected generation derivative; original D.task not rerun')
        stack.enter_context(patch.object(M,'preflight',return_value=scope))
        budget=stack.enter_context(patch.object(M.R,'budget',return_value=8_000_000_000))
        task=stack.enter_context(patch.object(M.R.A.D,'task',side_effect=AssertionError('producer forbidden')))
        return scope,budget,task

    def test_merge_all_fields_canonical_order_nan_bytes_and_provenance(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);scope,budget,task=self.fixture(root,stack)
            value=M.run(root/'scope','frozen',root/'merged')
            self.assertTrue(value['complete']);self.assertFalse(value['original_task_executed'])
            self.assertFalse(value['neural_training']);self.assertFalse(value['scoring'])
            self.assertEqual(value['archive_open_checks'],list(scope['bounds']))
            self.assertTrue(value['canonical_concatenation_verified']);task.assert_not_called()
            self.assertEqual(set(p.name for p in (root/'merged').iterdir()),
                {'rows-T1.npz','rows-T3.npz','rows-T12.npz','rows-meta.json','merge-provenance.json'})
            for T in M.R.A.HORIZONS:
                with np.load(root/'merged'/f'rows-T{T}.npz') as z:
                    np.testing.assert_array_equal(z['sid'],[0,0,0,1,1,1])
                    np.testing.assert_array_equal(z['ts'],[30,10,20,130,110,120])
                    self.assertTrue(np.isnan(z['lsH'][1]))
            self.assertTrue((root/'merged.merge-run.json').exists())
            # Initial full reservation plus each write is guarded, not a compression guess.
            self.assertEqual(budget.call_args_list[0].args[2],sum(scope['bounds'].values())+M.TEMPORARY)
            self.assertGreaterEqual(budget.call_count,6)

    def test_existing_out_or_attempt_receipt_forbids_merge(self):
        for existing in ('out','out.merge-run.json'):
            with self.subTest(existing=existing),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);(root/existing).touch()
                with patch.object(M.R.A,'merge_shards') as merge:
                    with self.assertRaises(FileExistsError):M.run(root/'scope','frozen',root/'out')
                    merge.assert_not_called()

    def test_disk_failure_before_adapter_or_output(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);_,budget,_=self.fixture(root,stack);budget.side_effect=RuntimeError('disk')
            with patch.object(M.R.A,'merge_shards') as merge:
                with self.assertRaisesRegex(RuntimeError,'disk'):M.run(root/'scope','frozen',root/'merged')
                merge.assert_not_called()
            self.assertFalse((root/'merged').exists());self.assertFalse((root/'merged.merge-run.json').exists())

    def test_per_archive_disk_failure_preserves_partial_and_error_receipt(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);_,budget,_=self.fixture(root,stack)
            calls=0
            def disk(*args):
                nonlocal calls
                calls+=1
                if calls==3:raise RuntimeError('growth before second archive')
                return 8_000_000_000
            budget.side_effect=disk
            with self.assertRaisesRegex(RuntimeError,'second archive'):M.run(root/'scope','frozen',root/'merged')
            receipt=json.loads((root/'merged.merge-run.json').read_text())
            self.assertFalse(receipt['complete'])
            self.assertTrue((root/'merged'/'rows-T1.npz').exists())
            with self.assertRaises(FileExistsError):M.run(root/'scope','frozen',root/'merged')

    def test_raw_dataset_output_forbidden(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);self.fixture(root,stack)
            with patch.object(M.R.A,'merge_shards') as merge:
                with self.assertRaisesRegex(ValueError,'raw dataset'):M.run(root/'scope','frozen',root/'datasets'/'merged')
                merge.assert_not_called()

    def test_distinct_nan_payload_and_row_order_are_rejected(self):
        for kind in ('nan_payload','roworder'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
                root=Path(temp);scope,_,_=self.fixture(root,stack);M.run(root/'scope','frozen',root/'merged')
                path=root/'merged'/'rows-T1.npz'
                with np.load(path) as z:arrays={k:z[k] for k in z.files}
                if kind=='nan_payload':arrays['lsH'].view(np.uint32)[1]=0x7fc00001
                else:arrays['ts'][0],arrays['ts'][1]=arrays['ts'][1],arrays['ts'][0]
                np.savez_compressed(path,**arrays)
                with self.assertRaisesRegex(ValueError,'byte mismatch'):
                    M.verify_merge(scope['evidence']['shards'],root/'merged',scope['evidence']['canonical_keys'])

    def test_shard_hash_mutation_rejected_by_unchanged_adapter(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);scope,_,_=self.fixture(root,stack)
            p=Path(scope['evidence']['shards'])/'000'/'rows-T1.npz';p.write_bytes(p.read_bytes()+b'bad')
            with self.assertRaisesRegex(ValueError,'SHA mismatch'):M.run(root/'scope','frozen',root/'merged')
            self.assertFalse(json.loads((root/'merged.merge-run.json').read_text())['complete'])

    def test_bounds_exceed_uncompressed_arrays_and_actual_archives(self):
        with patch.dict(M.EXPECTED,{'1':6,'3':6,'12':6},clear=True):
            bounds=M.merge_bounds()
        for T in M.R.A.HORIZONS:
            source=result('a')['rows'][T]
            source['sid']=np.full(3,0,np.int32)
            arrays={k:np.tile(source[k],(2,1)) if source[k].ndim==2 else np.tile(source[k],2) for k in M.R.A.FIELDS}
            import io
            buffer=io.BytesIO();np.savez_compressed(buffer,**arrays)
            self.assertGreater(bounds[f'rows-T{T}.npz'],sum(a.nbytes for a in arrays.values()))
            self.assertGreater(bounds[f'rows-T{T}.npz'],len(buffer.getvalue()))

    def test_wrong_persisted_metadata_sha_rejected(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);self.fixture(root,stack);original=M.R.A.merge_shards
            def corrupt(shards,out,keys):
                metadata=original(shards,out,keys)
                metadata['outputs']['1']['sha256']='0'*64
                (Path(out)/'rows-meta.json').write_text(json.dumps(metadata))
                return metadata
            with patch.object(M.R.A,'merge_shards',side_effect=corrupt):
                with self.assertRaisesRegex(ValueError,'output identity'):M.run(root/'scope','frozen',root/'merged')
            self.assertFalse(json.loads((root/'merged.merge-run.json').read_text())['complete'])
            self.assertFalse((root/'merged'/'merge-provenance.json').exists())

    def test_unknown_output_write_is_denied(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);self.fixture(root,stack)
            def unexpected(shards,out,keys):
                Path(out).mkdir();(Path(out)/'unknown.json').write_text('{}')
            with patch.object(M.R.A,'merge_shards',side_effect=unexpected):
                with self.assertRaisesRegex(ValueError,'unexpected merge output write'):
                    M.run(root/'scope','frozen',root/'merged')
            self.assertFalse((root/'merged'/'unknown.json').exists())
            self.assertFalse(json.loads((root/'merged.merge-run.json').read_text())['complete'])

    def test_self_consistent_modified_generation_proof_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);scope=root/'scope';scope.write_text(json.dumps(dict(base_scope={})))
            manifest=root/'manifest';manifest.write_text(json.dumps(dict(complete=True)))
            independent=root/'independent';independent.write_text(json.dumps(dict(manifest_sha256=M.R.A.sha(manifest))))
            stack.enter_context(patch.object(M,'GENERATION_SHA',M.R.A.sha(scope)))
            stack.enter_context(patch.object(M,'GENERATION_MANIFEST_SHA',M.R.A.sha(manifest)))
            stack.enter_context(patch.object(M,'GENERATION_INDEPENDENT_SHA',M.R.A.sha(independent)))
            manifest.write_text(json.dumps(dict(complete=True,altered=True)))
            independent.write_text(json.dumps(dict(manifest_sha256=M.R.A.sha(manifest))))
            with self.assertRaisesRegex(ValueError,'accepted generation proof pin changed'):
                M.accepted_generation(dict(generation_scope_path=str(scope),generation_manifest_path=str(manifest),
                    generation_independent_path=str(independent)))

    def test_freeze_and_preflight_do_not_require_old_git_head(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);metadata=[]
            for name in ('generation-scope','generation-manifest','generation-independent','doc'):
                p=root/name;p.write_text('{}');metadata.append(M.R.pin(p))
            evidence=dict(scope=metadata[0],manifest=metadata[1],independent=metadata[2],
                shard_pins=[],raw_pins=[],metadata_pins=[],source_sha256={},generation_runtime=M.R.runtime())
            stack.enter_context(patch.object(M,'accepted_generation',return_value=evidence))
            old_preflight=stack.enter_context(patch.object(M.R,'preflight',side_effect=AssertionError('old HEAD gate forbidden')))
            request=root/'request.json';request.write_text(json.dumps(dict(plan_path=metadata[3]['path'],disk_policy=M.POLICY)))
            frozen=M.freeze(request,root/'scope.json')
            M.preflight(root/'scope.json',frozen['scope_sha256']);old_preflight.assert_not_called()
            Path(metadata[0]['path']).write_text('changed')
            with self.assertRaisesRegex(ValueError,'pin mismatch'):M.preflight(root/'scope.json',frozen['scope_sha256'])


if __name__=='__main__':unittest.main()
