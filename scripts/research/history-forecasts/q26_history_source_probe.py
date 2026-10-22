#!/usr/bin/env python3
"""Fixed seen-BTC transport probe. Import and tests perform no networking."""
import argparse
import datetime as dt
import decimal
import hashlib
import json
import math
import os
import resource
import signal
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PLAN = Path(__file__).with_name('q26-history-source-probe-plan.md')
BODY_CAP = 65536
OUTPUT_CAP = 32768
RSS_CAP = 256 * 1024 * 1024
FREE_MIN = 2 * 1024**3 + OUTPUT_CAP
START_MS, END_MS = 1577836800000, 1577923200000
URLS = {
 'coinex': 'https://api.coinex.com/v2/spot/kline?market=BTCUSDT&period=1hour&start_time=1577836800000&end_time=1577923200000&limit=1',
 'bitmart': 'https://api-cloud.bitmart.com/spot/quotation/v3/klines?symbol=BTC_USDT&step=60&before=1577923200&limit=1',
}
# Deliberately absent until independently documented and prospectively frozen.
BITMART_SCHEMA = None

class WallCap(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        return False
    if isinstance(value, dict):
        return all(finite(x) for x in value.values())
    if isinstance(value, list):
        return all(finite(x) for x in value)
    return True

def parse_body(source, body):
    """Only safe, enumerated metadata escapes this function."""
    if len(body) > BODY_CAP:
        return {'category': 'body_cap'}
    try:
        obj = json.loads(body, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError, RecursionError):
        return {'category': 'malformed_json'}
    try:
        valid = finite(obj)
    except RecursionError:
        return {'category': 'malformed_json'}
    if not valid:
        return {'category': 'nonfinite'}
    if source == 'bitmart':
        result = {'category': 'schema_unqualified', 'json_kind': type(obj).__name__}
        if isinstance(obj, dict):
            result['data_kind'] = type(obj.get('data')).__name__
            code = obj.get('code')
            if type(code) is int and -(2**31) <= code < 2**31:
                result['vendor_code'] = code
        return result
    if source != 'coinex' or not isinstance(obj, dict):
        return {'category': 'schema_invalid'}
    if type(obj.get('code')) is not int:
        return {'category': 'schema_invalid'}
    if obj['code'] != 0:
        return {'category': 'api_rejected'}
    rows = obj.get('data')
    if not isinstance(rows, list) or len(rows) > 1:
        return {'category': 'schema_invalid'}
    if not rows:
        return {'category': 'empty', 'rows': 0}
    row = rows[0]
    if not isinstance(row, dict) or row.get('market') != 'BTCUSDT':
        return {'category': 'schema_invalid'}
    stamp = row.get('created_at')
    if type(stamp) is not int:
        return {'category': 'timestamp_invalid'}
    if not START_MS <= stamp <= END_MS:
        return {'category': 'timestamp_outside_window'}
    # Price strings are deliberately neither persisted nor used as outcomes.
    fields = ('open', 'close', 'high', 'low', 'volume', 'value')
    if not all(isinstance(row.get(k), str) for k in fields):
        return {'category': 'schema_invalid'}
    try:
        if not all(decimal.Decimal(row[k]).is_finite() for k in fields):
            return {'category': 'nonfinite'}
    except decimal.InvalidOperation:
        return {'category': 'schema_invalid'}
    return {'category': 'seen_symbol_time_query', 'rows': 1,
            'timestamp_ms': stamp, 'timestamp_in_fixed_window': True, 'boundary_inclusivity_qualified': False}

def resources_ok():
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    rss = usage if sys.platform == 'darwin' else usage * 1024
    fs = os.statvfs('/System/Volumes/Data' if sys.platform == 'darwin' else '/')
    return rss <= RSS_CAP and fs.f_bavail * fs.f_frsize >= FREE_MIN

def transport(url):
    # Disabled redirects ensure an endpoint cannot cause additional requests.
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(urllib.request.Request(url, method='GET'), timeout=10) as response:
        return response.status, response.read(BODY_CAP + 1)

def new_record():
    return {'started_utc': utc(), 'sources': {s: {'category': 'unattempted', 'request_sha256': sha(u.encode())} for s, u in URLS.items()},
              'scope': 'seen_BTC_transport_only_no_usable_reserve_inference'}

def error_type(err):
    for kind in (WallCap, OSError, MemoryError, ValueError, TypeError, RuntimeError):
        if isinstance(err, kind):
            return kind.__name__
    return 'OtherException'

def execute(fetch=transport, resource_check=resources_ok, record=None):
    if record is None:
        record = new_record()
    for source, url in URLS.items():
        try:
            allowed = resource_check()
        except WallCap:
            record['stop_category'] = 'wall_cap'
            break
        except Exception as err:
            record.update(stop_category='resource_failure', error_type=error_type(err), stage='resource_preflight')
            break
        if not allowed:
            record['stop_category'] = 'resource_gate'
            break
        item = record['sources'][source]
        item.update(category='attempting', started_utc=utc())
        start = time.monotonic()
        try:
            status, body = fetch(url)
            item['http_status'] = status
            item['bytes_read'] = len(body)
            if status != 200:
                item['category'] = 'http_rejected'
            else:
                item.update(parse_body(source, body))
        except WallCap:
            item['category'] = 'wall_cap'
            record['stop_category'] = 'wall_cap'
            break
        except urllib.error.HTTPError as err:
            item.update(category='http_rejected', http_status=err.code)
        except (TimeoutError, urllib.error.URLError):
            item['category'] = 'transport_failure'
        except Exception:
            item['category'] = 'internal_failure'
        finally:
            item['ended_utc'] = utc()
            item['elapsed_seconds'] = round(time.monotonic() - start, 6)
    record['ended_utc'] = utc()
    if 'stop_category' in record:
        return record
    try:
        if not resource_check():
            record['stop_category'] = 'resource_gate'
    except WallCap:
        record['stop_category'] = 'wall_cap'
    except Exception as err:
        record.update(stop_category='resource_failure', error_type=error_type(err), stage='resource_postflight')
    return record

def save(path, record):
    encoded = json.dumps(record, allow_nan=False, sort_keys=True, separators=(',', ':')).encode()
    if len(encoded) > OUTPUT_CAP:
        raise ValueError('output_cap')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(encoded)
        out.flush()
        os.fsync(out.fileno())

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--execute', action='store_true', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    # Branches are independent. BitMart remains schema-only until qualified.
    if Path(args.output).exists():
        parser.error('output_exists')
    report = new_record()
    report['stage'] = 'metadata'
    def alarm(_signum, _frame):
        raise WallCap()
    signal.signal(signal.SIGALRM, alarm)
    try:
        report.update({'interpreter': sys.executable,
                       'source_sha256': sha(Path(__file__).read_bytes()),
                       'plan_sha256': sha(PLAN.read_bytes()),
                       'command': [str(Path(__file__).resolve()), '--execute', '--output', args.output]})
        report['stage'] = 'request_parse'
        signal.setitimer(signal.ITIMER_REAL, 30)
        execute(record=report)
    except WallCap as err:
        report.update(stop_category='wall_cap', error_type=error_type(err))
    except Exception as err:
        report.update(stop_category='outer_failure', error_type=error_type(err))
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    # Bounded metadata finalization is outside the request/parse alarm.
    report['ended_utc'] = utc()
    save(args.output, report)

if __name__ == '__main__':
    main()
