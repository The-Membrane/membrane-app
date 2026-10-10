"""Offline launcher, budget, and disk-guard checks. Never runs collectors."""

import contextlib
import importlib.util
import io
import json
import os
import plistlib
import sys
import unittest
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch, Mock


sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'venue-observations-tick.py'
PLIST = HERE / 'launchd/com.membrane.venue-observations.plist'
spec = importlib.util.spec_from_file_location('venue_observations_tick', SCRIPT)
tick = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = tick
spec.loader.exec_module(tick)


class VenueObservationsTickTests(unittest.TestCase):
    def historical_block(self, slots, clock=None, free=None, archive=0):
        clock = [0] if clock is None else clock
        with (
            patch.object(tick.time, 'monotonic', side_effect=lambda: clock[0]),
            patch.object(tick, 'disk_free_bytes', return_value=tick.MIN_FREE_BYTES + 1 if free is None else free),
            patch.object(tick, 'historical_archive_bytes', return_value=archive),
            patch.object(tick, 'run_historical_slot', side_effect=slots) as run,
        ):
            result = tick.run_historical_block(0, tick.TOTAL_SECONDS)
        return result, run.call_count

    def test_historical_slots_request_reserve_and_stop_conditions(self):
        slot = {'status': 'verified', 'reason': None, 'rpcStarts': 64}
        result, calls = self.historical_block([slot] * 8)
        self.assertEqual(calls, 8)
        self.assertEqual(result['rpcStarts'], 512)
        self.assertEqual(result['status'], 'slot_bound')
        result, calls = self.historical_block([{**slot, 'rpcStarts': 800}] * 8)
        self.assertEqual(calls, 4)  # 896 remain: cannot reserve another 1024
        self.assertEqual(result['rpcStarts'], 3200)
        self.assertEqual(result['status'], 'rpc_start_bound')
        for failed in [
            {'status': 'failed', 'reason': 'http_429', 'rpcStarts': 1},
            {'status': 'failed', 'reason': 'provider_rpc_internal_error', 'rpcStarts': 4},
            {'status': 'failed', 'reason': 'writer_lock_lost', 'rpcStarts': 2},
            {'status': 'failed', 'reason': 'archive_byte_cap', 'rpcStarts': 2},
            {'status': 'setup_failed', 'reason': 'two_archive_hosts_required', 'rpcStarts': 0},
            {'status': 'timeout', 'rpcStarts': None},
            {'status': 'invalid_summary', 'rpcStarts': None},
            {'status': 'complete', 'reason': None, 'rpcStarts': 0},
            {'status': 'partial', 'reason': None, 'rpcStarts': 0},
            {'status': 'failed', 'reason': 'predeployment_code_absent', 'rpcStarts': 0},
        ]:
            with self.subTest(failed=failed):
                result, calls = self.historical_block([failed])
                self.assertEqual(calls, 1)
                self.assertNotEqual(result['status'], 'slot_bound')
        censor = {'status': 'failed', 'reason': 'predeployment_code_absent', 'rpcStarts': 4}
        result, calls = self.historical_block([censor] * 8)
        self.assertEqual(calls, 8)
        self.assertEqual(result['rpcStarts'], 32)

    def test_historical_wall_deadline_disk_and_archive_highwater(self):
        result, calls = self.historical_block([], clock=[1600])
        self.assertEqual(calls, 0)  # only 150s before the absolute1750 cutoff
        self.assertEqual(result['status'], 'time_bound')
        result, calls = self.historical_block([], free=tick.MIN_FREE_BYTES - 1)
        self.assertEqual(calls, 0)
        self.assertEqual(result['status'], 'disk_reserve')
        # A lossless pair can publish two source records and one paired record.
        result, calls = self.historical_block([], archive=tick.HISTORICAL_MAX_ARCHIVE_BYTES - 2 * tick.HISTORICAL_MAX_RECORD_BYTES)
        self.assertEqual(calls, 0)
        self.assertEqual(result['status'], 'archive_byte_cap')
        result, calls = self.historical_block([], archive=tick.HISTORICAL_MAX_ARCHIVE_BYTES - tick.HISTORICAL_MAX_RECORD_BYTES + 1)
        self.assertEqual(calls, 0)
        self.assertEqual(result['status'], 'archive_byte_cap')
        clock = [0]
        def advance(_deadline, _lock=None):
            clock[0] += 155
            return {'status': 'verified', 'reason': None, 'rpcStarts': 20}
        result, calls = self.historical_block(advance, clock=clock)
        self.assertEqual(calls, 5)
        self.assertEqual(result['status'], 'time_bound')
        self.assertEqual(result['durationSeconds'], 775)

    def test_historical_child_is_bounded_and_summary_rejects_raw_or_secret_fields(self):
        summary = {'status': 'verified', 'reason': None, 'venue': 'sUSDS', 'day': '2026-06-10', 'rpcStarts': 64}
        child = Mock(returncode=0)
        child.communicate.return_value = (json.dumps(summary), None)
        with (
            patch.object(tick.time, 'monotonic', return_value=0),
            patch.object(tick.subprocess, 'Popen', return_value=child) as spawn,
        ):
            self.assertEqual(tick.run_historical_slot(900, global_lock=73), summary)
            command = spawn.call_args.args[0]
            self.assertIn('--max-old-space-size=384', command)
            self.assertIn('--eval', command)
            self.assertTrue(spawn.call_args.kwargs['start_new_session'])
            self.assertEqual(spawn.call_args.kwargs['pass_fds'], (73,))
            child.communicate.assert_called_once_with(timeout=155)
            for data in [{**summary, 'rawRpcTrace': []}, {**summary, 'reason': 'https://secret.example/key'},
                         {**summary, 'rpcStarts': 1025}, {**summary, 'rpcStarts': True}]:
                child.communicate.return_value = (json.dumps(data), None)
                result = tick.run_historical_slot(900)
                self.assertIn(result['status'], ('invalid_summary', 'collector_error'))
                self.assertNotIn('https', json.dumps(result))
            child.communicate.side_effect = [subprocess.TimeoutExpired(command, 155), ('', None)]
            with patch.object(tick, 'stop_process_group') as stop:
                self.assertEqual(tick.run_historical_slot(900)['status'], 'timeout')
                stop.assert_called_once_with(child)

    def test_historical_follows_all_current_recorders_and_optional_failure_keeps_lock_release(self):
        order = []
        statuses = []
        lock = os.open('/dev/null', os.O_RDONLY)
        def stage_result(stage, _deadline):
            order.append(stage.name)
            return {'name': stage.name, 'status': 'ok', 'optional': stage.optional}
        def historical(_started, _deadline, inherited_lock):
            order.append('historical')
            self.assertEqual(inherited_lock, lock)
            raise ValueError('invalid_archive')
        with (
            patch.object(tick, 'acquire_lock', return_value=lock),
            patch.object(tick, 'disk_free_bytes', return_value=tick.MIN_FREE_BYTES + 1),
            patch.object(tick.os, 'nice'),
            patch.object(tick, 'run_stage', side_effect=stage_result),
            patch.object(tick, 'run_historical_block', side_effect=historical),
            patch.object(tick, 'write_status', side_effect=lambda data: statuses.append(json.loads(json.dumps(data)))),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(tick.run_tick(), 0)
        self.assertEqual(order, [stage.name for stage in tick.STAGES] + ['historical'])
        self.assertEqual(statuses[-1]['status'], 'complete')
        self.assertEqual(statuses[-1]['stages'][-1]['status'], 'preflight_failed')
        self.assertTrue(statuses[-1]['stages'][-1]['optional'])
        with self.assertRaises(OSError):
            os.fstat(lock)

    def test_archive_guard_counts_files_and_rejects_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'archive'
            root.mkdir()
            (root / 'record.json').write_bytes(b'123')
            with patch.object(tick, 'HISTORICAL_ROOT', root):
                self.assertEqual(tick.historical_archive_bytes(), 3)
                (root / 'link').symlink_to('/private/tmp')
                with self.assertRaises(ValueError):
                    tick.historical_archive_bytes()

    def test_inline_summary_detects_nested429_without_printing_trace(self):
        fixture = {'status': 'failed', 'reason': 'quote_output_incomplete', 'venue': 'sUSDe',
                   'anchorDay': '2026-06-10', 'rpcStarts': 45,
                   'captures': [{'reason': 'quote_output_incomplete', 'rawRpcTrace': [
                       {'transportError': {'message': 'historical_depth_quote_http_429'}, 'private': 'secret-url'}]}]}
        source = "import { runTick } from './scripts/research/carry-depth-quote-archive.mjs';"
        self.assertEqual(tick.HISTORICAL_SUMMARY_CODE.count(source), 1)
        code = tick.HISTORICAL_SUMMARY_CODE.replace(source, 'const runTick = async () => (' + json.dumps(fixture) + ');')
        # This child executes only the stub above; the real collector is not imported.
        result = subprocess.run([tick.NODE, '--max-old-space-size=384', '--input-type=module', '--eval', code],
                                capture_output=True, text=True, timeout=5, check=True)
        data = json.loads(result.stdout)
        self.assertEqual(data['reason'], 'http_429')
        self.assertEqual(data['rpcStarts'], 45)
        self.assertNotIn('captures', data)
        self.assertNotIn('secret-url', result.stdout)
        internal_entry = {'request': {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getStorageAt', 'params': ['0x1', '0x2', '0x3']},
                          'response': {'jsonrpc': '2.0', 'id': 1, 'error': {'code': -32603, 'message': 'Internal error'}}}
        for extra in [
            {'captures': [{'reason': 'venue_nav_unavailable', 'rawRpcTrace': [internal_entry]}]},
            {'captures': [], 'study': 'historical-depth-quote-anchor-failure-v1', 'evidence': {
                'headerEvidence': [internal_entry]}}
        ]:
            nested = {**fixture, **extra, 'reason': 'venue_nav_unavailable'}
            code = tick.HISTORICAL_SUMMARY_CODE.replace(source, 'const runTick = async () => (' + json.dumps(nested) + ');')
            result = subprocess.run([tick.NODE, '--max-old-space-size=384', '--input-type=module', '--eval', code],
                                    capture_output=True, text=True, timeout=5, check=True)
            data = json.loads(result.stdout)
            self.assertEqual(data['reason'], 'provider_rpc_internal_error')
            self.assertNotIn('Internal error', result.stdout)
            self.assertNotIn('captures', data)
        for changed_error in [
            {'code': -32603, 'message': 'execution reverted', 'data': '0xdeadbeef'},
            {'code': -32603, 'message': 'Internal error', 'data': '0xdeadbeef'},
            {'code': -32603, 'message': 'Internal error', 'data': None},
            {'code': -32603, 'message': 'execution reverted'},
        ]:
            entry = {**internal_entry, 'response': {**internal_entry['response'], 'error': changed_error}}
            nested = {**fixture, 'reason': 'provider_rpc_error', 'captures': [
                {'reason': 'provider_rpc_error', 'rawRpcTrace': [entry]}]}
            code = tick.HISTORICAL_SUMMARY_CODE.replace(source, 'const runTick = async () => (' + json.dumps(nested) + ');')
            result = subprocess.run([tick.NODE, '--max-old-space-size=384', '--input-type=module', '--eval', code],
                                    capture_output=True, text=True, timeout=5, check=True)
            self.assertEqual(json.loads(result.stdout)['reason'], 'provider_rpc_error')
            self.assertNotIn('deadbeef', result.stdout)

    def test_guard_requires_one_gib_plus_margin(self):
        self.assertFalse(tick.disk_guard(tick.MIN_FREE_BYTES - 1))
        self.assertTrue(tick.disk_guard(tick.MIN_FREE_BYTES))
        self.assertGreater(tick.MIN_FREE_BYTES, 1024 * 1024 * 1024)

    def test_check_guard_never_starts_a_collector(self):
        output = io.StringIO()
        with (
            patch.object(tick, 'disk_free_bytes', return_value=tick.MIN_FREE_BYTES + 1),
            patch.object(tick.subprocess, 'Popen', side_effect=AssertionError('collector ran')),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(tick.main(['--check-guard']), 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['requiredFreeBytes'], tick.MIN_FREE_BYTES)

    def test_disk_reserve_stops_before_priority_or_collector(self):
        status = []
        lock = os.open('/dev/null', os.O_RDONLY)
        with (
            patch.object(tick, 'acquire_lock', return_value=lock),
            patch.object(tick, 'disk_free_bytes', return_value=tick.MIN_FREE_BYTES - 1),
            patch.object(tick, 'write_status', side_effect=status.append),
            patch.object(tick.os, 'nice', side_effect=AssertionError('priority changed')),
            patch.object(tick, 'run_stage', side_effect=AssertionError('collector ran')),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(tick.run_tick(), 0)
        self.assertEqual(status[0]['status'], 'disk_reserve')
        self.assertEqual(status[0]['stages'], [])

    def test_hourly_launch_agent_and_bounded_stage_plan(self):
        with PLIST.open('rb') as source:
            config = plistlib.load(source)
        self.assertEqual(config['Label'], 'com.membrane.venue-observations')
        self.assertEqual(config['StartInterval'], 3600)
        self.assertFalse(config['RunAtLoad'])
        self.assertEqual(config['ProgramArguments'], ['/usr/bin/python3', str(SCRIPT)])
        self.assertEqual(config['StandardOutPath'], '/dev/null')
        self.assertTrue(all(
            ((stage.code_root() if stage.code_root else tick.ROOT) / 'scripts' / stage.script).is_file()
            for stage in tick.STAGES
        ))
        self.assertLess(sum(stage.timeout_seconds for stage in tick.STAGES), tick.TOTAL_SECONDS)
        self.assertEqual(
            {stage.name for stage in tick.STAGES if not stage.optional},
            {'liquidity', 'venue_flows_local', 'route_flow_susde', 'route_flow_susds', 'route_flow_scrvusd', 'depth', 'terms', 'news', 'alarms'},
        )
        liquidity = next(stage for stage in tick.STAGES if stage.name == 'liquidity')
        self.assertEqual(liquidity.args, ('--local',))
        routes = [stage for stage in tick.STAGES if stage.name.startswith('route_flow_')]
        self.assertEqual(len(routes), 3)
        for stage in routes:
            self.assertEqual(stage.timeout_seconds, 95)
            self.assertIn('--max-ranges-per-venue', stage.args)
            self.assertEqual(stage.args[stage.args.index('--max-ranges-per-venue') + 1], '10')
        alarms = next(stage for stage in tick.STAGES if stage.name == 'alarms')
        self.assertEqual(alarms.args, ('--record-only',))
        news = next(stage for stage in tick.STAGES if stage.name == 'news')
        self.assertEqual(news.args, ('--local-only',))
        depth = next(stage for stage in tick.STAGES if stage.name == 'depth')
        self.assertEqual(depth.args, ('--local',))
        self.assertEqual(depth.timeout_seconds, 150)


if __name__ == '__main__':
    unittest.main()
