"""Mocked orchestration fixtures: never execute the real row producer or install Torch."""
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import r16_shallow_reconstruction_runner as R
from test_r16_shallow_reconstruction import result


class RunnerTests(unittest.TestCase):
    def scope(self,root,keys=('b','a','c')):
        p=root/'scope.json'; policy=dict(reserve_bytes=2_000_000_000,max_shard_bytes=2_000_000,max_shards_bytes=5_000_000,temporary_reserve_bytes=1_000_000)
        data=dict(schema=R.SCHEMA,datasets=str(root),canonical_keys=list(keys),disk_policy=policy,runtime={'fixture':True})
        p.write_text(json.dumps(data)); return p,data

    def test_mocked_producer_canonical_positive_completion(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); p,s=self.scope(root); specs=[dict(key=k) for k in s['canonical_keys']]
            with patch.object(R,'preflight',return_value=specs),patch.object(R,'budget',return_value=9_000_000_000),\
                 patch.object(R.A.D,'init_btc') as init,patch.object(R.A.D,'task',side_effect=lambda sp:result(sp['key'])) as producer:
                receipt=R.run(p,root/'out',R.A.sha(p))
            self.assertTrue(receipt['complete']); self.assertEqual(receipt['series'],3)
            self.assertEqual([c.args[0]['key'] for c in producer.call_args_list],['b','a','c'])
            init.assert_called_once_with(str(root)); self.assertTrue((root/'out'/'manifest.json').is_file())
            self.assertEqual([x['key'] for x in receipt['shards']],['b','a','c'])
            self.assertFalse((root/'out'/'rows').exists());self.assertFalse(receipt['merged'])
            self.assertLessEqual(receipt['started_at'],receipt['ended_at'])

    def test_initial_budget_stops_before_initializer_or_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); p,s=self.scope(root)
            with patch.object(R,'preflight',return_value=[]),patch.object(R,'budget',side_effect=RuntimeError('disk')),\
                 patch.object(R.A.D,'init_btc') as init,patch.object(R.A.D,'task') as task:
                with self.assertRaises(RuntimeError):R.run(p,root/'out',R.A.sha(p))
            init.assert_not_called();task.assert_not_called();self.assertFalse((root/'out').exists())

    def test_error_receipt_preserves_completed_shards_and_refuses_resume(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);p,s=self.scope(root)
            with patch.object(R,'preflight',return_value=[dict(key='b'),dict(key='a')]),\
                 patch.object(R,'budget',return_value=9_000_000_000),patch.object(R.A.D,'init_btc'),\
                 patch.object(R.A.D,'task',side_effect=[result('b'),RuntimeError('producer failed')]):
                with self.assertRaises(RuntimeError):R.run(p,root/'out',R.A.sha(p))
                with self.assertRaises(FileExistsError):R.run(p,root/'out',R.A.sha(p))
            status=R.A.read_unique_json(root/'out'/'run.json')
            self.assertEqual(status['status'],'error');self.assertEqual(status['completed_series'],1)
            self.assertTrue((root/'out'/'shards'/'000'/'manifest.json').is_file())
            self.assertFalse((root/'out'/'manifest.json').exists())

    def test_scope_hash_and_input_pin_mutation_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);p,s=self.scope(root)
            with patch.object(R,'preflight') as check:
                with self.assertRaises(ValueError):R.run(p,root/'out','incorrect')
                check.assert_not_called()
            entry=R.pin(p);R.check_pin(entry);p.write_text('changed')
            with self.assertRaises(ValueError):R.check_pin(entry)

    def test_budget_exact_boundary(self):
        policy=dict(reserve_bytes=2_000_000_000)
        class Usage:
            free=2_000_000_123
        with patch.object(R.shutil,'disk_usage',return_value=Usage()):
            self.assertEqual(R.budget('/tmp',policy,123),Usage.free)
            with self.assertRaises(RuntimeError):R.budget('/tmp',policy,124)

    def test_freeze_has_no_initializer_or_producer_calls(self):
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp); datasets=(root/'datasets').resolve();datasets.mkdir()
            keys=['dev:ETH','dev:BTC']+[f'grid{i}' for i in range(275)]
            specs=[dict(key=k) if k.startswith('dev:') else dict(key=k,path=str(datasets/(k+'.json'))) for k in keys]
            paths={str(Path(s['path']).resolve()) for s in specs if 'path' in s}
            paths|={str((datasets/R.A.D.M2.A.INPUTS[k][0]).resolve()) for k in ('eth_price','btc_price','steth_price')}
            paths|={str((datasets/R.A.D.M2.KLINES[k][0]).resolve()) for k in ('ETHUSDT','BTCUSDT')}
            request=dict(datasets=str(datasets),summary_path=str(root/'summary'),price_manifest_path=str(root/'prices.json'),
                plan_path=str(root/'plan.md'),dataset_commit='datasetfixture',
                disk_policy=dict(reserve_bytes=2_000_000_000,max_shard_bytes=2_000_000,max_shards_bytes=5_000_000,temporary_reserve_bytes=1_000_000))
            (root/'prices.json').write_text(json.dumps(dict(dataset_commit='datasetfixture')))
            req=root/'request.json';req.write_text(json.dumps(request))
            stack.enter_context(patch.object(R.A,'load_published_summary',return_value=dict(series=keys,code=R.A.ORIGINAL_CODE)))
            stack.enter_context(patch.object(R.A.D.R12,'dev_specs',return_value=specs))
            stack.enter_context(patch.object(R,'read_price_manifest',return_value=[dict(path=p,size=1,sha256='fake') for p in paths]))
            def fakepin(path):
                p=Path(path);relative=str(p.relative_to(datasets)) if p.is_relative_to(datasets) else ''
                return dict(path=str(p),size=1,sha256=R.AUXILIARY.get(relative,'fake'))
            stack.enter_context(patch.object(R,'pin',side_effect=fakepin));stack.enter_context(patch.object(R,'check_pin'))
            stack.enter_context(patch.object(R,'runtime',return_value={'fixture':True}))
            stack.enter_context(patch.object(R,'source_closure',return_value={'fixture.py':'sha'}))
            initializer=stack.enter_context(patch.object(R.A.D,'init_btc'));producer=stack.enter_context(patch.object(R.A.D,'task'))
            out=root/'frozen.json';receipt=R.freeze(req,out)
            self.assertEqual(receipt['price_inputs'],280);self.assertEqual(receipt['auxiliary_inputs'],2)
            initializer.assert_not_called();producer.assert_not_called();self.assertTrue(out.is_file())

    def test_no_fit_loader_check_never_calls_task(self):
        class Series:
            close=[1.,2.,3.]
        scope=dict(datasets='/tmp',disk_policy=dict(reserve_bytes=2_000_000_000,max_shard_bytes=100))
        with patch.object(R,'budget',return_value=9_000_000_000),patch.object(R.A.D,'init_btc'),\
             patch.object(R.A.D.R12,'load_series',return_value=(Series(),[{}],{})),\
             patch.object(R.A.D.A6,'_clear',create=True),patch.object(R.A.D,'task') as producer:
            checked=R.load_source_check(scope,[dict(key='a'),dict(key='b')])
        self.assertEqual(checked['checked_series'],2);producer.assert_not_called()

    def test_deflate_zip_bound_covers_incompressible_shard(self):
        import numpy as np
        rng=np.random.default_rng(446)
        with tempfile.TemporaryDirectory() as temp:
            task=result('a')
            for T,values in task['rows'].items():
                for name in R.A.NN.STATIC: values[name]=rng.normal(size=3).astype(np.float32)
            retained=R.A.retain_series_rows(task,{'a':0});bound=R.shard_write_bound(retained,task,0)
            R.A.write_series_shard(temp,task,{'a':0})
            actual=sum(p.stat().st_size for p in (Path(temp)/'000').iterdir())
            self.assertLessEqual(actual,bound)

    def test_static_source_closure_covers_producer_helpers_and_tests(self):
        files=R.source_closure()
        for name in ('r16_dev.py','r16_nn.py','r12_tail.py','a2_touch.py','a6_touch.py',
                     'r16_shallow_reconstruction.py','r16_shallow_reconstruction_runner.py',
                     'test_r16_shallow_reconstruction_runner.py'):
            self.assertIn('scripts/research/history-forecasts/'+name,files)

    def test_runtime_is_json_roundtrip_stable(self):
        value=R.runtime(); self.assertEqual(value,json.loads(json.dumps(value)))


if __name__=='__main__':unittest.main()
