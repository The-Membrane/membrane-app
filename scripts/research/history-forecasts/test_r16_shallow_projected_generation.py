"""Mocked orchestration only; never execute historical producer/models."""
from contextlib import ExitStack
from collections import Counter
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import r16_shallow_projected_generation as G
from test_r16_shallow_reconstruction import result

class GenerationTests(unittest.TestCase):
    def fixture(self,root,stack):
        keys=[f'fixture:{i}' for i in range(277)]
        for sid,key in G.S.SELECTED.items():keys[sid]=key
        specs=[dict(key=k) for k in keys];mapping={k:i for i,k in enumerate(keys)};refs={}
        for sid in G.S.SELECTED:
            p=root/f'reference-{sid}.json';rows=G.R.A.retain_series_rows(result(keys[sid]),mapping)
            p.write_text(json.dumps(dict(descriptors=G.S.describe_rows(rows))));refs[str(sid)]=G.R.pin(p)
        base=dict(datasets=str(root/'datasets'),canonical_keys=keys,disk_policy=G.POLICY,
            price_inputs=[],auxiliary_inputs=[],summary=dict(path=str(root/'summary')),price_manifest=dict(path=str(root/'prices')))
        scope=dict(base_scope=base,proof=dict(references=refs),limitations='fixture');ledger=dict(total=0,attempts=[])
        stack.enter_context(patch.object(G,'preflight',return_value=(scope,specs)))
        stack.enter_context(patch.object(G,'EXPECTED_ROWS',{str(T):831 for T in (1,3,12)}))
        budget=stack.enter_context(patch.object(G.R,'budget',return_value=9_000_000_000))
        init=stack.enter_context(patch.object(G.R.A.D,'init_btc'))
        stack.enter_context(patch.object(G.R.A.D,'_BTC',{}));stack.enter_context(patch.object(G.R.A.D.R12,'_CHAIN',{}))
        stack.enter_context(patch.object(G.sys,'addaudithook'))
        stack.enter_context(patch.object(G.S,'read_audit',return_value=(lambda *a:None,Counter(),ledger)))
        original=stack.enter_context(patch.object(G.R.A.D,'task',side_effect=AssertionError('original forbidden')))
        task=stack.enter_context(patch.object(G.P,'task',side_effect=lambda sp:result(sp['key'])))
        return scope,specs,ledger,budget,init,task,original

    def test_all277_canonical_shards_five_sentinels(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);scope,specs,_,_,init,task,original=self.fixture(root,stack)
            got=G.run(root/'scope','frozen',root/'out')
            self.assertTrue(got['complete']);self.assertEqual(got['row_totals'],{'1':831,'3':831,'12':831})
            self.assertEqual(got['series'],277);self.assertEqual([c.args[0] for c in task.call_args_list],specs)
            self.assertEqual([s['sid'] for s in got['sentinels']],list(G.S.SELECTED))
            self.assertEqual(len(list((root/'out'/'shards').iterdir())),277)
            self.assertFalse(got['merged']);self.assertFalse(got['neural_training'])
            init.assert_called_once_with(scope['base_scope']['datasets']);original.assert_not_called()
            self.assertTrue((root/'out'/'manifest.json').is_file())

    def test_partial_error_preserved_no_retry(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);_,specs,_,_,_,task,_=self.fixture(root,stack)
            task.side_effect=[result(specs[0]['key']),RuntimeError('mock failed')]
            with self.assertRaises(RuntimeError):G.run(root/'scope','frozen',root/'out')
            status=G.R.A.read_unique_json(root/'out'/'run.json')
            self.assertEqual(status['completed_series'],1);self.assertFalse(status['complete'])
            self.assertTrue((root/'out'/'shards'/'000'/'manifest.json').exists())
            self.assertFalse((root/'out'/'manifest.json').exists())
            with self.assertRaises(FileExistsError):G.run(root/'scope','frozen',root/'out')
            self.assertEqual(task.call_count,2)

    def test_swallowed_denial_ledger_blocks_before_shard(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);_,_,ledger,_,_,task,_=self.fixture(root,stack)
            def denied(sp):
                ledger['total']+=1;ledger['attempts'].append({'path':'unapproved'})
                try:raise G.S.AuditViolation('denied')
                except BaseException:pass
                return result(sp['key'])
            task.side_effect=denied
            with self.assertRaises(G.S.AuditViolation):G.run(root/'scope','frozen',root/'out')
            status=G.R.A.read_unique_json(root/'out'/'run.json')
            self.assertEqual(status['audit_violations']['total'],1);self.assertEqual(status['completed_series'],0)
            self.assertFalse((root/'out'/'shards').exists())

    def test_context_mismatch_before_write(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);_,_,_,_,_,task,_=self.fixture(root,stack)
            task.side_effect=lambda sp:result(sp['key'],shift=1)
            with self.assertRaisesRegex(ValueError,'sentinel'):G.run(root/'scope','frozen',root/'out')
            self.assertEqual(task.call_count,1);self.assertFalse((root/'out'/'shards').exists())

    def test_final_count_mismatch_never_complete(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);self.fixture(root,stack)
            stack.enter_context(patch.object(G,'EXPECTED_ROWS',{'1':832,'3':831,'12':831}))
            with self.assertRaisesRegex(ValueError,'completion gate'):G.run(root/'scope','frozen',root/'out')
            self.assertEqual(G.R.A.read_unique_json(root/'out'/'run.json')['completed_series'],277)
            self.assertFalse((root/'out'/'manifest.json').exists())

    def test_initial_disk_failure_no_output(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);_,_,_,budget,init,task,_=self.fixture(root,stack);budget.side_effect=RuntimeError('disk')
            with self.assertRaisesRegex(RuntimeError,'disk'):G.run(root/'scope','frozen',root/'out')
            init.assert_not_called();task.assert_not_called();self.assertFalse((root/'out').exists())

    def test_proof_mutation_rejected_without_fit(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);scope=root/'scope';manifest=root/'manifest';scope.write_text('altered');manifest.write_text('{}')
            with patch.object(G.P,'task') as task:
                with self.assertRaisesRegex(ValueError,'changed'):
                    G.accepted_proof(dict(parity_scope_path=str(scope),parity_manifest_path=str(manifest)))
                task.assert_not_called()

    def test_pair_proof_rejects_legal_hash_and_independent_count(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp).resolve();btc=str(root/'datasets'/'binance-klines/BTCUSDT-1h.json')
            old=dict(source_sha256={},base_scope=dict(datasets=str(root/'datasets'),price_inputs=[dict(path=btc)],
                auxiliary_inputs=[],summary=dict(path=str(root/'summary')),price_manifest=dict(path=str(root/'prices'))))
            scope=root/'scope.json';scope.write_text(json.dumps(old));scope_sha=G.R.A.sha(scope)
            manifest=root/'manifest.json';manifest.write_text(json.dumps(dict(complete=True,all_five_exact=True,child_calls=10)))
            independent=root/'independent.json';pairs=[];keys=[f'k{i}' for i in range(277)]
            for sid,key in G.S.SELECTED.items():keys[sid]=key
            for sid,key in G.S.SELECTED.items():
                rows=G.R.A.retain_series_rows(result(key),{k:i for i,k in enumerate(keys)})
                descriptors=G.S.describe_rows(rows);pairs.append(dict(sid=sid,key=key,rows={T:3 for T in descriptors}))
                for arm in ('original','projection'):
                    value=dict(complete=True,sid=sid,key=key,arm=arm,scope_sha256=scope_sha,
                        memory_npz_roundtrip=True,audit_violations=dict(total=0,attempts=[]),
                        opened_inputs={btc:1},descriptors=descriptors)
                    (root/f'{arm}-{sid:03d}.json').write_text(json.dumps(value))
            info=dict(complete=True,descriptor_pairs=255,distinct_child_pids=10,input_pins=282,source_pins=21,
                scope_sha256=scope_sha,pairs=pairs);independent.write_text(json.dumps(info))
            stack.enter_context(patch.object(G,'PARITY_SCOPE_SHA',scope_sha))
            stack.enter_context(patch.object(G,'PARITY_MANIFEST_SHA',G.R.A.sha(manifest)))
            stack.enter_context(patch.object(G.S,'parity_sources',return_value={}))
            request=dict(parity_scope_path=str(scope),parity_manifest_path=str(manifest),parity_independent_path=str(independent))
            _,proof=G.accepted_proof(request)
            self.assertEqual(len(proof['references']),5);self.assertEqual(len(proof['projections']),5)
            path=root/'original-000.json';original=path.read_text();value=json.loads(original)
            value['descriptors']['1']['fields']['fH']['sha256']='0'*64
            G.S.validate_receipt(value,0,'original',old,scope_sha)
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError,'exact field'):G.accepted_proof(request)
            path.write_text(original);info['pairs'][0]['rows']['1']=4;independent.write_text(json.dumps(info))
            with self.assertRaisesRegex(ValueError,'row counts'):G.accepted_proof(request)

    def test_deadline_after_task_before_write(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp);self.fixture(root,stack)
            stack.enter_context(patch.object(G,'check_deadline',side_effect=[None,None,TimeoutError('deadline')]))
            with self.assertRaises(TimeoutError):G.run(root/'scope','frozen',root/'out')
            self.assertFalse((root/'out'/'shards').exists());self.assertFalse((root/'out'/'manifest.json').exists())

    def test_receipt_budget_before_atomic_write(self):
        with patch.object(G.R,'budget',side_effect=RuntimeError('disk')),patch.object(G.R,'atomic_json') as write:
            with self.assertRaises(RuntimeError):G.write_receipt(Path('/tmp/unused'),{'complete':True},G.POLICY)
            write.assert_not_called()

if __name__=='__main__':unittest.main()
