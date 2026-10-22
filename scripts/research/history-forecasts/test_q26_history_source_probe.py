import importlib.util
import json
import os
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
from pathlib import Path

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('q26_history_source_probe.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

class ProbeTests(unittest.TestCase):
    def body(self, **updates):
        row = dict(market='BTCUSDT', created_at=p.START_MS, open='1', close='2', high='3', low='1', volume='4', value='5')
        row.update(updates)
        return json.dumps(dict(code=0, data=[row])).encode()
    def test_populated(self):
        result = p.parse_body('coinex', self.body())
        self.assertEqual(result['category'], 'seen_symbol_time_query')
        self.assertFalse(result['boundary_inclusivity_qualified'])
        self.assertNotIn('open', result)
    def test_boundary(self):
        self.assertEqual(p.parse_body('coinex', self.body(created_at=p.END_MS))['category'], 'seen_symbol_time_query')
    def test_empty(self):
        self.assertEqual(p.parse_body('coinex', b'{"code":0,"data":[]}')['category'], 'empty')
    def test_malformed(self):
        self.assertEqual(p.parse_body('coinex', b'not json')['category'], 'malformed_json')
    def test_nonfinite(self):
        for val in ('NaN', 'Infinity', '-Infinity', '1e999999'):
            category = p.parse_body('coinex', self.body(open=val))['category']
            self.assertEqual(category, 'nonfinite' if val != '1e999999' else 'seen_symbol_time_query')
        self.assertEqual(p.parse_body('coinex', b'{"code":NaN}')['category'], 'malformed_json')
        self.assertEqual(p.parse_body('coinex', b'{"code":0,"data":[],"extra":1e9999}')['category'], 'nonfinite')
    def test_oversize(self):
        self.assertEqual(p.parse_body('coinex', b'x' * (p.BODY_CAP + 1))['category'], 'body_cap')
    def test_wrong_unit_and_bool(self):
        for stamp in (p.START_MS // 1000, True, str(p.START_MS), p.END_MS + 1):
            self.assertNotEqual(p.parse_body('coinex', self.body(created_at=stamp))['category'], 'seen_symbol_time_query')
    def test_wrong_market_and_count(self):
        self.assertEqual(p.parse_body('coinex', self.body(market='OTHER'))['category'], 'schema_invalid')
        row = json.loads(self.body())['data'][0]
        self.assertEqual(p.parse_body('coinex', json.dumps({'code':0,'data':[row,row]}).encode())['category'], 'schema_invalid')
    def test_unqualified_bitmart(self):
        for data in (b'[]', b'{"code":1000,"data":[]}'):
            self.assertEqual(p.parse_body('bitmart', data)['category'], 'schema_unqualified')
    def test_source_independence(self):
        calls=[]
        def fetch(url):
            calls.append(url)
            return (200,self.body()) if url==p.URLS['coinex'] else (200,b'{"code":1000,"data":[]}')
        result=p.execute(fetch,lambda: True)
        self.assertEqual(calls,list(p.URLS.values()))
        self.assertEqual(result['sources']['coinex']['category'],'seen_symbol_time_query')
        self.assertEqual(result['sources']['bitmart']['category'],'schema_unqualified')
        self.assertEqual(result['sources']['bitmart']['vendor_code'],1000)
    def test_transport_failure(self):
        called=[]
        def fetch(url):
            called.append(url)
            raise urllib.error.URLError('SECRET_BODY')
        result=p.execute(fetch, lambda: True)
        self.assertEqual(called, list(p.URLS.values()))
        self.assertTrue(all(x['category']=='transport_failure' for x in result['sources'].values()))
        self.assertNotIn('SECRET_BODY',json.dumps(result))
    def test_wall_cap_retains_unattempted(self):
        def fetch(url):
            raise p.WallCap()
        result=p.execute(fetch, lambda: True)
        self.assertEqual(result['sources']['coinex']['category'],'wall_cap')
        self.assertEqual(result['sources']['bitmart']['category'],'unattempted')
    def test_resource_gate(self):
        result=p.execute(lambda _: self.fail('called'),lambda: False)
        self.assertTrue(all(x['category']=='unattempted' for x in result['sources'].values()))
    def test_preflight_resource_oserror(self):
        def fail(): raise OSError('PRIVATE')
        result=p.execute(lambda _: self.fail('network'),fail)
        self.assertEqual(result['stop_category'],'resource_failure')
        self.assertEqual(result['error_type'],'OSError')
        self.assertTrue(all(x['category']=='unattempted' for x in result['sources'].values()))
        self.assertNotIn('PRIVATE',json.dumps(result))
    def test_resource_failure_after_first_fetch(self):
        calls=[]
        def check():
            calls.append(1)
            if len(calls)==2: raise OSError('PRIVATE')
            return True
        report=p.new_record()
        self.assertIs(p.execute(lambda _: (200,self.body()), check, report),report)
        self.assertEqual(report['sources']['coinex']['category'],'seen_symbol_time_query')
        self.assertEqual(report['sources']['bitmart']['category'],'unattempted')
        self.assertEqual(report['stop_category'],'resource_failure')
    def test_postflight_resource_oserror(self):
        calls=[]
        def check():
            calls.append(1)
            if len(calls)==3: raise OSError('PRIVATE')
            return True
        report=p.execute(lambda _: (200,self.body()),check)
        self.assertEqual(report['stage'],'resource_postflight')
        self.assertEqual(report['stop_category'],'resource_failure')
        self.assertEqual(report['sources']['coinex']['category'],'seen_symbol_time_query')
    def test_main_outer_wallcap_partial_saved(self):
        with tempfile.TemporaryDirectory() as tmp:
            output=str(Path(tmp)/'partial.json')
            def escape(*,record):
                record['sources']['coinex']['category']='empty'
                raise p.WallCap('PRIVATE')
            with patch.object(p,'execute',escape), patch.object(p.sys,'argv',['probe','--execute','--output',output]), patch.object(p.signal,'signal'), patch.object(p.signal,'setitimer') as timer:
                p.main()
            saved=json.loads(Path(output).read_bytes())
            self.assertEqual(saved['sources']['coinex']['category'],'empty')
            self.assertEqual(saved['sources']['bitmart']['category'],'unattempted')
            self.assertEqual(saved['stop_category'],'wall_cap')
            self.assertEqual(saved['error_type'],'WallCap')
            self.assertNotIn('PRIVATE',json.dumps(saved))
            self.assertEqual(timer.call_args.args,(p.signal.ITIMER_REAL,0))
    def test_serialization_exclusive_and_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'report.json'
            p.save(path, {'status':'empty'})
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            self.assertEqual(json.loads(path.read_bytes()), {'status':'empty'})
            with self.assertRaises(FileExistsError): p.save(path,{})
            with self.assertRaises(ValueError): p.save(Path(tmp)/'large',{'x':'a'*p.OUTPUT_CAP})
            with self.assertRaises(ValueError): p.save(Path(tmp)/'nan',{'x':float('nan')})

if __name__ == '__main__': unittest.main()
