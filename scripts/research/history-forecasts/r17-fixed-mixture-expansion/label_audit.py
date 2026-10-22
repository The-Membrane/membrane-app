"""Complete fixed diagnostic-case label provenance; no models or fitting."""
import gzip
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import sys
import numpy as np

ADMITTED='READY_PARENT_REVIEWED_FIXED_C_RAW_LABEL_AUDIT'
READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
PLAN_SHA='ab2b8e8497672857d8e2b570b3629e0f82f73c0ff442b682efe2591ce139d846'
DIAGNOSTIC_SHA='af5e3e5d283ac38eb71e637aa66874a210687b22db7e1862ded40d3d16e1f123'
CAP=64*1024**2

def need(ok,msg):
    if not ok:raise ValueError(msg)

def helper(record):
    p=Path(record['path']);need(p.is_absolute() and str(p.resolve())==str(p) and not p.is_symlink() and not any(v.is_symlink() for v in p.parents),'canonical helper');need(record['size']<=65536,'helper cap');b=p.read_bytes()
    need(len(b)==record['size'] and hashlib.sha256(b).hexdigest()==record['sha256']==DIAGNOSTIC_SHA,'frozen diagnostic helper')
    m=importlib.util.module_from_spec(importlib.util.spec_from_loader('_label_diagnostic',loader=None));m.__file__=str(p)
    exec(compile(b,str(p),'exec'),m.__dict__);return m

def primitive(close,low,start,ts,*,status='DRAFT'):
    need(status in(READY,ADMITTED),'DRAFT')
    need(type(start)is int and type(ts)is int and (ts-start)%3600==0,'integer hourly origin')
    c=np.asarray(close,np.float64);l=np.asarray(low,np.float64);i=(ts-start)//3600
    need(c.ndim==l.ndim==1 and len(c)==len(l) and 0<=i<=len(l),'grid bounds')
    spot=float(c[i-1]) if i>0 else float('nan');w=l[i:i+24]
    missing=int(np.sum(~np.isfinite(w)|(w<=0)))+24-len(w)
    valid=math.isfinite(spot) and spot>0 and missing==0
    depth=float(np.log(np.min(w)/spot)) if valid else None
    label=int(depth<=np.log1p(-.10)) if valid else 0
    linear=bool(np.min(w)<=spot*.90) if valid else None
    ratio=bool(np.min(w)/spot<=.90) if valid else None
    return dict(index=i,spot=spot if math.isfinite(spot) else None,minimum_low=float(np.min(w)) if valid else None,
                valid=bool(valid),missing=missing,depth=depth,label=label,linear_label=linear,ratio_label=ratio,
                boundary_disagreement=bool(valid and (label!=linear or label!=ratio)))

def decode(D,pin):
    path=D.checked(pin,16*1024**2);raw=path.read_bytes()
    if str(path).endswith('.gz'):
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as f:raw=f.read(CAP+1)
    need(len(raw)<=CAP,'raw uncompressed cap')
    def pairs(items):
        d={}
        for k,v in items:need(k not in d,'duplicate raw JSON key');d[k]=v
        return d
    def bad(_):raise ValueError('nonfinite raw JSON')
    d=json.loads(raw,object_pairs_hook=pairs,parse_constant=bad)
    need(type(d)is dict and type(d.get('startTs'))is int and type(d.get('columns'))is dict,'raw grid header')
    cols=d['columns'];need(all(type(cols.get(k))is list for k in ('close','low','high')),'original decoder columns')
    n=len(cols['close']);need(n==len(cols['low'])==len(cols['high']),'raw column lengths')
    for k in ('close','low','high'):
        need(all(v is None or (type(v)in(int,float) and math.isfinite(v)) for v in cols[k]),'raw numeric column')
    if 'count'in d:need(type(d['count'])is int and d['count']==n,'raw count header mismatch')
    if 'stepSeconds'in d:need(type(d['stepSeconds'])is int and d['stepSeconds']==3600,'raw step header mismatch')
    header=dict(startTs=d['startTs'],rows=n,count=d.get('count'),stepSeconds=d.get('stepSeconds'),
                absent_optional_headers=[k for k in ('count','stepSeconds') if k not in d])
    c=np.array([np.nan if v is None else float(v) for v in cols['close']],np.float64)
    l=np.array([np.nan if v is None else float(v) for v in cols['low']],np.float64)
    D.checked(pin,16*1024**2);return c,l,header

def run(path,sha,*,status='DRAFT'):
    need(status==ADMITTED,'DRAFT: no input access')
    b=Path(path).read_bytes();need(len(b)<=65536 and hashlib.sha256(b).hexdigest()==sha,'external request')
    q=json.loads(b);need(q['schema']=='q26-fixed-c-label-audit-request-v1' and q['status']==ADMITTED,'request admission')
    D=helper(q['pins']['diagnostic_source']);D.checked(q['pins']['source']);need(q['pins']['source']==D.pin(Path(__file__).resolve()),'current source')
    plan=D.read(q['pins']['plan'],1024**2);need(q['pins']['plan']['sha256']==PLAN_SHA,'frozen plan')
    diag=D.read(q['pins']['diagnostic'],1024**2);need(plan['diagnostic_inventory_pin']==q['pins']['diagnostic'],'same accepted diagnostic')
    ev=diag['private_data']['accepted_evidence'];need(q['pins']['parent_acceptance']==ev['parent_acceptance'],'parent seal')
    accept=D.read(ev['parent_acceptance']);need(accept['public_data']['complete']is True and accept['public_data']['phase_closed']is True and accept['private_evidence']['manifest']==ev['manifest'],'closed accepted C')
    old=D.read(accept['private_evidence']['request'],2*1024**2);runtime=old['runtime']
    need(sys.executable==runtime['invocation_path'] and sys.dont_write_bytecode and sys.flags.optimize==0 and sys.version==runtime['version'] and np.__version__==runtime['packages']['numpy'],'accepted runtime')
    need(str(Path(sys.executable).resolve())==runtime['executable']['path'] and all(os.environ.get(k)==v for k,v in runtime['environment'].items()),'runtime environment')
    for pin in [runtime['executable'],*runtime['native_pins']]:D.checked(pin)
    inputs={p['path']:p for p in old['files']};need(len(inputs)==len(old['files']),'unique accepted input pins')
    prep=D.read(old['pins']['preparation_request'],2*1024**2);orig=D.read(prep['pins']['original_control_request'],2*1024**2)
    need(orig['pins']['raw_scope']==plan['authority']['raw_scope'],'frozen raw authority');scope=D.read(orig['pins']['raw_scope'])['base_scope']
    cases=diag['private_data']['case_inventory'];refs=diag['private_data']['source_refs']
    minimal=[{k:c[k] for k in ('sid','ts','quarter','kind','known','label','quarter_cutoff','private_quarter','private_row')} for c in cases]
    need(minimal==plan['cases'] and len(cases)==377 and len({(c['sid'],c['ts']) for c in cases})==377,'complete377 case inventory')
    need(sum(c['kind']=='C_high' for c in cases)==46 and sum(c['kind']=='C_zero' for c in cases)==331,'frozen selection')
    pm=D.read(ev['prepared_manifest'],8*1024**2);manifest=D.read(ev['manifest'],8*1024**2)
    need(manifest['canonical_mapping']==old['canonical_mapping'] and len(pm['series_receipts'])==277,'canonical full cohort')
    results=[];headers=[];allpins=[]
    for s in plan['series']:
        sid=s['sid'];key=refs[str(sid)]['key'];need(old['canonical_mapping'][sid]==[sid,key] and s['key']==key and s['kind']=='grid' and s['slice']is None,'supported canonical grid')
        group,symbol=key.split(':',1);need(group in ('A3','blind3','blind4','blind5','blind6','blind7','blind8'),'no chain/slice/unsupported')
        prefix='final-blind-prices/' if group=='A3' else 'history-forecasts/r11/r1110-p3-run-9ab156bb/acq/' if group=='blind8' else group+'-prices/'
        matches=[p for p in scope['price_inputs'] if p['relative'].startswith(prefix) and p['relative'].split('/')[-1].split('-')[1]==symbol]
        need(len(matches)==1 and {k:matches[0][k] for k in ('path','size','sha256')}==s['raw_pin'],'unique canonical raw mapping')
        need(inputs.get(s['raw_pin']['path'])==s['raw_pin'],'raw pin in accepted full cohort closure')
        pp=pm['series_receipts'][sid];pr=D.read(pp,65536);need(pp==refs[str(sid)]['prepared_receipt'] and pr['sid']==sid and pr['key']==key and pr['outputs']['24']==refs[str(sid)]['H24']==s['H24'],'prepared authority')
        a=D.archive(s['H24']);c,l,h=decode(D,s['raw_pin']);headers.append(dict(sid=sid,**h));allpins.extend((pp,s['H24'],s['raw_pin']))
        need(a['sid'].dtype==np.int32 and a['ts'].dtype==np.int64 and len(set(a['ts'].tolist()))==len(a['ts']),'prepared keys');index={int(t):i for i,t in enumerate(a['ts'])}
        for case in [v for v in cases if v['sid']==sid]:
            ts=case['ts'];need(ts in index,'case prepared timestamp');i=index[ts];need(int(a['sid'][i])==sid,'prepared SID')
            v=primitive(c,l,h['startTs'],ts,status=ADMITTED);fail=[]
            def compare(name,ok):
                if not ok:fail.append(name)
            compare('label_valid',v['valid']==bool(a['label_valid'][i])==case['known'])
            compare('label',v['label']==int(a['y'][i,2])==case['label'])
            compare('future_missing_hours',v['missing']==int(a['future_missing_hours'][i]))
            saved=float(a['future_log_min'][i]);compare('future_log_min',saved==v['depth'] if v['valid'] else math.isnan(saved))
            compare('quarter',D.quarter(ts)==case['quarter'] and int(a['quarter_cutoff'][i])==case['quarter_cutoff'])
            results.append(dict(sid=sid,ts=ts,kind=case['kind'],raw=s['raw_pin'],prepared=s['H24'],**v,mismatches=fail))
        del c,l,a
    need(len(results)==377 and len(headers)==32 and {(v['sid'],v['ts']) for v in results}=={(v['sid'],v['ts']) for v in cases},'complete raw audit coverage')
    for pin in [*allpins,*q['pins'].values()]:D.checked(pin)
    out=Path(q['out']);need(out.is_absolute() and str(out.resolve())==str(out) and out.parent==Path(path).parent and not out.exists(),'fresh private output')
    report=dict(public_data=dict(schema='q26-fixed-c-label-audit-v1',label='CODEX CONTINUATION',complete=True,cases=377,raw_files=32,
        mismatch_cases=sum(bool(v['mismatches']) for v in results),boundary_disagreements=sum(v['boundary_disagreement'] for v in results),
        missing_optional_header_files=sum(bool(h['absent_optional_headers']) for h in headers),forecast_promotion_status='NOT_ADMITTED'),
        private_data=dict(cases=results,headers=headers,request_sha256=sha))
    data=(json.dumps(report,sort_keys=True,allow_nan=False)+'\n').encode();need(len(data)<=1024**2,'output cap')
    fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    need(json.loads(out.read_bytes())==report,'exact output readback');return D.pin(out)

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--admitted',action='store_true');a=p.parse_args()
    print(json.dumps(run(a.request,a.request_sha256,status=ADMITTED if a.admitted else 'DRAFT')))
