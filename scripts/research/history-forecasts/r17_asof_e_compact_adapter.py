"""Strict O248 CSV-to-O220 transport adapter; no empirical admission or audit creation.

The caller independently supplies and pins the semantic contract. Conversion
checks internal consistency and byte identity, never the truth of source claims.
Only Python's standard library is used. Import performs no file I/O.
"""
import argparse
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import re
from fractions import Fraction

HORIZONS = (6, 12, 24, 72, 168)
LEVELS = ('-0.02', '-0.05', '-0.10', '-0.20')
PERCENT_LEVELS = {'-2': '-0.02', '-5': '-0.05', '-10': '-0.10', '-20': '-0.20'}
GROUPS = ('alt', 'large', 'btc_eth')
EXCLUSIONS = ('P1:KRAKEN-ETH', 'blind8:JUPUSDT')
R193_COMMIT = '9942092cda0dea10258e12b2665baefd5b6d5214'
R193_SHA = 'bdd24bd1962b9cb76b47d7da6e6168db4a236b640dbe5957812d009d4e239a60'
QUERY_START, QUERY_COUNT, QUERY_STEP = 1704067200, 731, 86400
MAX_SUPPORT_N, I64_MAX = 2**52-1, 2**63-1
MAX_COMPRESSED_BYTES, MAX_CSV_BYTES, MAX_PAYLOAD_BYTES = 8*1024**2, 12*1024**2, 16*1024**2
HEADER = ('source,group,horizon_hours,barrier,origin_utc_seconds,origin_utc,n,sum_y,'
          'support_ts_min,support_ts_max,resolve_ts_max,availability,zero_support,forecast').split(',')


def need(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode('ascii')


def sha(value):
    return hashlib.sha256(value).hexdigest()


def _integer(value,name):
    need(type(value) is int and -I64_MAX<=value<=I64_MAX,name)
    return value


def _digest(value):
    return type(value) is str and len(value)==64 and all(c in '0123456789abcdef' for c in value)


def _descriptor(value):
    need(type(value) is dict and set(value)=={'path','size','sha256'},'descriptor fields')
    need(type(value['path']) is str and value['path'] and type(value['size']) is int and value['size']>=0 and _digest(value['sha256']),'descriptor values')


def _group(key):
    if key in ('dev:BTC','dev:ETH'):return 'btc_eth'
    return 'large' if key.split(':')[0] in ('A2','A3') else 'alt'


def validate_contract(c):
    fields={'source','r193_commit','r193_sha256','pool_kind','exclusions','horizons','levels','rowsB','ordered_source_keys','row_support','filter_evidence','crosswalk_evidence','crosswalk','support_origin_span','provider_publication_time_verified','query_grid'}
    need(type(c) is dict and set(c)==fields,'semantic contract fields')
    need(c['source']=='dev' and c['r193_commit']==R193_COMMIT and c['r193_sha256']==R193_SHA,'original source binding')
    need(c['pool_kind']=='FULL_R192_ISSUED_SCORED_ROWS_THEN_R193_FILTERS' and c['exclusions']==list(EXCLUSIONS) and c['horizons']==list(HORIZONS) and c['levels']==list(LEVELS),'full pool convention')
    need(c['query_grid']=={'start_utc_seconds':QUERY_START,'count':QUERY_COUNT,'step_seconds':QUERY_STEP},'exact reviewed 2024-2025 query grid')
    need(c['provider_publication_time_verified'] is False,'source-resolution clock only; no provider timestamp claim')
    need(type(c['rowsB']) is list and len(c['rowsB'])==5,'five original rowsB descriptors')
    for H,d in zip(HORIZONS,c['rowsB']):
        need(type(d) is dict and set(d)=={'horizon_hours','file','header'} and d['horizon_hours']==H,'rowsB horizon/header binding')
        _descriptor(d['file']);_descriptor(d['header'])
    for key in ('ordered_source_keys','row_support','filter_evidence','crosswalk_evidence'):_descriptor(c[key])
    span=c['support_origin_span'];need(type(span) is list and len(span)==2,'source history span')
    _integer(span[0],'span start');_integer(span[1],'span end');need(span[0]<=span[1],'source history order')
    cross=c['crosswalk'];need(type(cross) is list and len(cross)<=10000,'crosswalk size')
    mapping={};keys=set()
    for row in cross:
        need(type(row) is dict and set(row)=={'sid','canonical_key','source','group'},'crosswalk fields')
        sid=_integer(row['sid'],'SID');key=row['canonical_key']
        need(sid>=0 and sid not in mapping and type(key) is str and key and key not in keys and key not in EXCLUSIONS and row['source']=='dev' and row['group']==_group(key),'authenticated source/group crosswalk')
        mapping[sid]=row;keys.add(key)
    return c



def integer(text, name):
    need(type(text) is str and re.fullmatch(r'0|-?[1-9][0-9]*', text) is not None, name+' canonical integer')
    return _integer(int(text), name)


def pinned_bytes(value, descriptor, cap, name):
    _descriptor(descriptor)
    need(type(value) is bytes and len(value)<=cap, name+' byte cap/type')
    need(len(value)==descriptor['size'] and sha(value)==descriptor['sha256'], name+' hash/size')


def convert(compressed, *, compressed_descriptor, csv_descriptor, semantic_contract, contract_sha256):
    """Return (canonical O220 payload bytes, canonical conversion receipt bytes).

    Descriptors bind exact source bytes; contract_sha256 binds canonical(contract).
    Neither a receipt nor successful conversion is an approved semantic review.
    """
    pinned_bytes(compressed, compressed_descriptor, MAX_COMPRESSED_BYTES, 'compressed')
    _descriptor(csv_descriptor)
    need(csv_descriptor['size']<=MAX_CSV_BYTES, 'declared CSV byte cap')
    validate_contract(semantic_contract)
    need(_digest(contract_sha256) and sha(canonical(semantic_contract))==contract_sha256, 'independent contract hash')
    # The extra byte proves truncation cannot silently pass the declared ceiling.
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode='rb') as gz:
            body=gz.read(min(MAX_CSV_BYTES, csv_descriptor['size'])+1)
    except (OSError, EOFError) as exc:
        raise ValueError('invalid gzip') from exc
    pinned_bytes(body, csv_descriptor, MAX_CSV_BYTES, 'CSV')
    try:
        text=body.decode('ascii')
    except UnicodeDecodeError as exc:
        raise ValueError('CSV must be ASCII') from exc
    rows=csv.reader(io.StringIO(text, newline=''), strict=True)
    need(next(rows, None)==HEADER, 'exact CSV header')
    curves={('dev',g,h,l): {} for g in GROUPS for h in HORIZONS for l in LEVELS}
    total=0
    for fields in rows:
        total+=1
        need(total<=60*QUERY_COUNT and len(fields)==len(HEADER), 'CSV record count/width')
        source,group,horizon,percent,cutoff,date,n,y,earliest,latest,resolved,availability,zero,forecast=fields
        h=integer(horizon, 'horizon')
        need(percent in PERCENT_LEVELS, 'registered integer percent barrier')
        key=(source,group,h,PERCENT_LEVELS[percent])
        need(key in curves, 'registered source/group/horizon')
        t=integer(cutoff, 'cutoff')
        need(QUERY_START<=t<QUERY_START+QUERY_COUNT*QUERY_STEP and (t-QUERY_START)%QUERY_STEP==0, 'exact cutoff grid')
        need(date==dt.datetime.fromtimestamp(t,dt.timezone.utc).strftime('%Y-%m-%d'), 'UTC date/cutoff equality')
        need(t not in curves[key], 'duplicate record')
        n,y=integer(n,'n'),integer(y,'sum_y')
        need(0<=n<=MAX_SUPPORT_N and 0<=y<=n, 'count domain')
        need(availability=='available' and zero==str(int(n==0)), 'availability/zero_support domain')
        if n==0:
            need(earliest==latest==resolved=='', 'empty support timestamps')
            lo=hi=None
        else:
            lo,hi,rt=integer(earliest,'earliest'),integer(latest,'latest'),integer(resolved,'resolve')
            need(semantic_contract['support_origin_span'][0]<=lo<=hi<=semantic_contract['support_origin_span'][1], 'support span')
            need(rt==hi+h*3600 and rt<=t, 'exact resolved clock/cutoff')
        # Producer emits binary64 Jeffreys probability with .17g. Counts remain
        # authoritative; exact rational conversion rounds once to binary64.
        expected=format(float(Fraction(2*y+1,2*(n+1))), '.17g')
        need(forecast==expected, 'faithful seventeen-digit Jeffreys forecast')
        curves[key][t]=[t,n,y,lo,hi]
    need(total==60*QUERY_COUNT, 'full 60 by 731 census')
    series=[]
    for key,records in curves.items():
        need(len(records)==QUERY_COUNT, 'complete curve census')
        ordered=[records[QUERY_START+i*QUERY_STEP] for i in range(QUERY_COUNT)]
        pn=py=0
        previous=(None,None)
        first=None
        for i,(t,n,y,lo,hi) in enumerate(ordered):
            need(n>=pn and 0<=y-py<=n-pn, 'cumulative counts')
            if n>0:
                need(first is None or lo==first, 'constant earliest prefix origin')
                if pn>0:
                    need(hi>=previous[1], 'monotone latest prefix origin')
                if i>0 and n>pn:
                    need(hi+key[2]*3600>t-QUERY_STEP, 'new support newly resolves')
                    if pn==0:
                        need(lo+key[2]*3600>t-QUERY_STEP, 'first support newly resolves')
                first=lo
            if n==pn:
                need(y==py and (lo,hi)==previous, 'unchanged count preserves outcomes/spans')
            pn,py,previous=n,y,(lo,hi)
        series.append(dict(source=key[0],group=key[1],horizon_hours=key[2],barrier=key[3],records=ordered))
    # The four nested touch levels share the exact same source rows. A deeper
    # downside event cannot be more frequent than a shallower downside event.
    for g in GROUPS:
        for h in HORIZONS:
            for i in range(QUERY_COUNT):
                t=QUERY_START+i*QUERY_STEP
                cells=[curves[('dev',g,h,l)][t] for l in LEVELS]
                need(all((r[1],r[3],r[4])==(cells[0][1],cells[0][3],cells[0][4]) for r in cells), 'shared level support')
                need(all(a[2]>=b[2] for a,b in zip(cells,cells[1:])), 'nested downside outcomes')
    payload=canonical(dict(schema='q26-o220-asof-e-prefix-snapshots-v1',semantic_contract=semantic_contract,series=series))
    need(len(payload)<=MAX_PAYLOAD_BYTES, 'O220 payload byte cap')
    receipt=canonical(dict(schema='q26-o248-compact-adapter-receipt-v1',
        compressed_source=compressed_descriptor,uncompressed_csv=csv_descriptor,
        semantic_contract_sha256=contract_sha256,
        payload=dict(size=len(payload),sha256=sha(payload)),curves=60,records=total,
        admission='TRANSPORT_CONVERSION_ONLY_NO_SEMANTIC_APPROVAL',
        forecast_check='exact Fraction Jeffreys to binary64, canonical .17g',
        provider_publication_time_verified=False))
    return payload,receipt


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_gzip')
    parser.add_argument('bindings_json',help='independent compressed_descriptor, csv_descriptor, semantic_contract, contract_sha256')
    parser.add_argument('payload_output')
    parser.add_argument('receipt_output')
    args=parser.parse_args()
    with open(args.bindings_json,'rb') as handle:
        binding_bytes=handle.read(1024**2+1)
    need(len(binding_bytes)<=1024**2, 'binding file byte cap')
    def pairs(items):
        obj={}
        for key,value in items:
            need(key not in obj,'duplicate binding JSON key')
            obj[key]=value
        return obj
    def bad(_):
        raise ValueError('nonfinite binding JSON')
    binding=json.loads(binding_bytes,object_pairs_hook=pairs,parse_constant=bad)
    need(set(binding)=={'compressed_descriptor','csv_descriptor','semantic_contract','contract_sha256'}, 'binding fields')
    with open(args.source_gzip,'rb') as handle:
        compressed=handle.read(MAX_COMPRESSED_BYTES+1)
    payload,receipt=convert(compressed,**binding)
    # Exclusive creation prevents silently overwriting source, audit or evidence.
    with open(args.payload_output,'xb') as handle:
        handle.write(payload)
    with open(args.receipt_output,'xb') as handle:
        handle.write(receipt)


if __name__=='__main__':
    main()
