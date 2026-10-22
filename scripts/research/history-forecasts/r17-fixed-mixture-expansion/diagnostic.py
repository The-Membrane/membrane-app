"""Fixed probability/label diagnostics over accepted unchanged-C outputs only.

No model, threshold selection, fits or hourly-price decoder. Public results contain
aggregate counts; all keys, predictions and provenance cases remain private.
"""
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import zipfile
import ast
import numpy as np

HERE=Path(__file__).resolve().parent
SCOPE='ACCEPTED_FIXED_C_PROBABILITY_DIAGNOSTIC_ONLY'
READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_FIXED_C_DIAGNOSTIC'
ARMS=('A_raw_fH','B_common_shape','C_conditional')
BINS=(0.,.01,.02,.05,.1,.2,.4,.6,.8,1.)
TARGET=2
HORIZONS=(6,12,24,72,168)
EVAL0=1704067200;YEAR25=1735689600;END=1767225600
OUTPUT_CAP=1024**2


def need(ok,message):
    if not ok:raise ValueError(message)


def ready(status):need(status in(READY,ADMITTED),'DRAFT: probability diagnostic not admitted')


def pin(path):
    p=Path(path);need(p.is_absolute() and str(p.resolve())==str(p) and not p.is_symlink() and
        not any(v.is_symlink() for v in p.parents),'canonical nonsymlink path')
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return dict(path=str(p),size=p.stat().st_size,sha256=h.hexdigest())


def checked(record,cap=None):
    need(type(record)is dict and set(record)=={'path','size','sha256'} and type(record['size'])is int and
        0<=record['size'] and (cap is None or record['size']<=cap) and pin(record['path'])==record,'current exact pin')
    return Path(record['path'])


def read(record,cap=16*1024**2):
    def pairs(items):
        out={}
        for k,v in items:need(k not in out,'duplicate JSON key');out[k]=v
        return out
    def finite(v):
        n=float(v);need(math.isfinite(n),'finite JSON float');return n
    def bad(_):raise ValueError('nonfinite JSON')
    return json.loads(checked(record,cap).read_bytes(),object_pairs_hook=pairs,parse_float=finite,parse_constant=bad)


def archive(record,fields=None,rows=1461,cap=1024**2):
    path=checked(record,cap)
    with zipfile.ZipFile(path) as z:
        names=z.namelist();need(len(names)==len(set(names)) and len(names)<=24,'bounded unique NPZ inventory');total=0
        for entry in z.infolist():
            need(entry.filename.endswith('.npy') and '/' not in entry.filename and not entry.flag_bits&1,'NPZ member')
            total+=entry.file_size;need(entry.file_size<=1024**2,'bounded NPY member')
            with z.open(entry) as f:
                need(f.read(6)==b'\x93NUMPY','NPY magic');version=f.read(2)
                width=2 if version==b'\x01\x00' else 4 if version in(b'\x02\x00',b'\x03\x00') else 0
                need(width>0,'NPY version');size=int.from_bytes(f.read(width),'little');need(size<=16384,'bounded NPY header')
                h=ast.literal_eval(f.read(size).decode('latin1'));dtype=np.dtype(h['descr']);shape=h['shape']
                need(set(h)=={'descr','fortran_order','shape'} and h['fortran_order'] is False and not dtype.hasobject and
                    dtype.kind in 'biuf' and isinstance(shape,tuple) and 1<=len(shape)<=2 and shape[0]<=rows and
                    all(type(n)is int and 0<=n<=max(rows,18) for n in shape) and
                    entry.file_size==6+2+width+size+math.prod(shape)*dtype.itemsize,'bounded exact NPY layout')
        need(total<=8*1024**2,'bounded NPZ logical bytes')
    with np.load(path,allow_pickle=False) as z:
        take=z.files if fields is None else fields;need(set(take)<=set(z.files),'required archive fields')
        return {k:z[k] for k in take}


def keys(sid,ts):
    need(isinstance(sid,np.ndarray) and isinstance(ts,np.ndarray) and sid.dtype==np.int32 and ts.dtype==np.int64 and
        sid.ndim==1 and ts.shape==sid.shape,'exact key dtypes/shapes')
    result=[(int(s),int(t)) for s,t in zip(sid,ts)]
    need(len(result)==len(set(result)),'duplicate keys')
    need(all(0<=s<277 and EVAL0<=t<END and t%86400==0 for s,t in result),'evaluation daily keys')
    return result


def join_predictions(expected_sid,expected_ts,parts):
    """Exact expected J coverage; reorder by keys, refuse duplicates/omissions."""
    expected=keys(expected_sid,expected_ts);found={}
    for part in parts:
        kk=keys(part['sid'],part['ts']);n=len(kk)
        for arm in ARMS:
            p=part[arm];need(p.dtype==np.float64 and p.shape==(n,5) and np.isfinite(p).all() and
                np.all((p>=0)&(p<=1)),'finite prediction schema')
        for i,key in enumerate(kk):
            need(key not in found,'duplicate private prediction key');found[key]=(part,i)
    need(set(found)==set(expected),'exact complete expected J key coverage')
    return {arm:np.asarray([found[k][0][arm][found[k][1]] for k in expected],np.float64).reshape(-1,5) for arm in ARMS}


def quarter(ts):
    d=dt.datetime.fromtimestamp(int(ts),dt.timezone.utc)
    return '%d-Q%d'%(d.year,1+(d.month-1)//3)


def group_masks(ts):
    out={'pooled':np.ones(len(ts),bool),'2024':ts<YEAR25,'2025':ts>=YEAR25}
    q=np.array([quarter(t) for t in ts],dtype='U7')
    out.update({('%d-Q%d'%(y,k)):q==('%d-Q%d'%(y,k)) for y in(2024,2025) for k in range(1,5)})
    return out


def counted(mask,event,non_event,unknown,p):
    known=event|non_event;all_n=int(mask.sum());known_n=int(np.sum(mask&known))
    return dict(n=all_n,known_L24_n=known_n,events=int(np.sum(mask&event)),non_events=int(np.sum(mask&non_event)),
        unknown=int(np.sum(mask&unknown)),sum_probability_all_J=float(p[mask].sum()),
        sum_probability_known_L24=float(p[mask&known].sum()),
        mean_probability_all_J=float(p[mask].mean()) if all_n else None,
        mean_probability_known_L24=float(p[mask&known].mean()) if known_n else None)


def binned(p,y,known):
    ix=np.searchsorted(np.asarray(BINS[1:-1]),p,side='right')
    event=known&(y==1);non_event=known&(y==0);unknown=~known
    n=np.bincount(ix,minlength=9).astype(int).tolist()
    return dict(n=n,events=np.bincount(ix[event],minlength=9).astype(int).tolist(),
        non_events=np.bincount(ix[non_event],minlength=9).astype(int).tolist(),
        unknown=np.bincount(ix[unknown],minlength=9).astype(int).tolist(),
        sum_probability=np.bincount(ix,weights=p,minlength=9).tolist())


def membership(a,c):
    return dict(A_n=int(a.sum()),C_n=int(c.sum()),intersection_n=int(np.sum(a&c)),A_only_n=int(np.sum(a&~c)),
        C_only_n=int(np.sum(c&~a)),union_n=int(np.sum(a|c)),identical_membership=bool(np.array_equal(a,c)))


def concentration(sid,mask):
    n=int(mask.sum());counts=np.bincount(sid[mask],minlength=277)
    ranked=np.sort(counts)[::-1]
    public=dict(n=n,contributing_series=int(np.sum(counts>0)),top_counts=ranked[:5].astype(int).tolist(),
        top1_share=float(ranked[0]/n) if n else None,top5_share=float(ranked[:5].sum()/n) if n else None,
        top10_share=float(ranked[:10].sum()/n) if n else None)
    private=[dict(sid=int(s),n=int(counts[s])) for s in np.flatnonzero(counts)]
    return public,private


def diagnose_rows(sid,ts,probabilities,y,known,*,expected_keys=None,status='DRAFT'):
    ready(status);kk=keys(sid,ts);n=len(kk)
    if expected_keys is not None:
        need(len(expected_keys)==len(set(expected_keys)) and set(kk)==set(expected_keys),'complete independently expected J membership')
    need(set(probabilities)==set(ARMS) and y.dtype==np.uint8 and y.shape==(n,5) and
         known.dtype==bool and known.shape==(n,) and np.isin(y[known],[0,1]).all(),'label/known schema')
    order=np.lexsort((ts,sid));sid,ts,y,known=sid[order],ts[order],y[order],known[order]
    probs={}
    for arm,p in probabilities.items():
        need(p.dtype==np.float64 and p.shape==(n,5) and np.isfinite(p).all() and np.all((p>=0)&(p<=1)),'prediction domain')
        probs[arm]=p[order,TARGET]
    labels=y[:,TARGET];event=known&(labels==1);non_event=known&(labels==0);unknown=~known
    public={};private_concentration={}
    for name,g in group_masks(ts).items():
        row=dict(J_n=int(g.sum()),L24_n=int(np.sum(g&known)),unknown_n=int(np.sum(g&unknown)),arms={})
        for arm,p in probs.items():
            masks={'zero':p==0,'one':p==1,'high':p>=.8,'low':p<.01}
            row['arms'][arm]=dict(all_J_bins=binned(p[g],labels[g],known[g]),
                known_L24_bins={k:v for k,v in binned(p[g&known],labels[g&known],np.ones(int(np.sum(g&known)),bool)).items() if k in('n','events','sum_probability')},
                **{kind:counted(g&mask,event,non_event,unknown,p) for kind,mask in masks.items()})
        a,c=probs['A_raw_fH'],probs['C_conditional']
        row['A_C_membership']={kind:membership(g&am,g&cm) for kind,am,cm in
            (('zero',a==0,c==0),('high',a>=.8,c>=.8))}
        public[name]=row
    cp=probs['C_conditional'];private_cases=[]
    for i in np.flatnonzero((cp==0)|(cp>=.8)):
        private_cases.append(dict(sid=int(sid[i]),ts=int(ts[i]),quarter=quarter(ts[i]),known=bool(known[i]),
            label=int(labels[i]) if known[i] else None,kind='C_zero' if cp[i]==0 else 'C_high',
            probabilities={arm:float(p[i]) for arm,p in probs.items()}))
    public_concentration={}
    for arm,p in probs.items():
        public_concentration[arm]={};private_concentration[arm]={}
        for kind,mask in (('zero',p==0),('one',p==1),('high',p>=.8),('low',p<.01)):
            pc,pr=concentration(sid,mask);public_concentration[arm][kind]=pc;private_concentration[arm][kind]=pr
    return dict(public_data=dict(schema='q26-fixed-c-probability-diagnostic-v1',scope=SCOPE,target='H24/-10%',target_index=TARGET,
        bins=list(BINS),bin_boundary='Internal edges enter the higher bin; p=1 is in final bin.',groups=public,
        concentration=public_concentration,unseen_validation=False,forecast_promotion_status='NOT_ADMITTED',
        interpretation='Descriptive accepted-development diagnostics; no cause or data-error claim.'),
        private_data=dict(case_inventory=private_cases,series_concentration=private_concentration))


def registered_bins(report,result):
    groups=result['public_data']['groups']
    need(report['J_n']==groups['pooled']['J_n'] and report['L24_n']==groups['pooled']['L24_n'],'accepted total J/L24 counts')
    views={v['view']:v for v in report['views'] if v['view_type']=='calendar'}
    for name in('pooled','2024','2025'):
        need(views[name]['forecast_J_n']==groups[name]['J_n'] and views[name]['scored_L24_n']==groups[name]['L24_n'],'accepted calendar counts')
        for arm in ARMS:
            stored=views[name]['arms'][arm]['calibration_bins'][TARGET]
            current=groups[name]['arms'][arm]['known_L24_bins']
            need(stored['n']==current['n'] and stored['events']==current['events'],'registered bin exact counts/events')
            need(np.allclose(stored['sum_probability'],current['sum_probability'],rtol=0,atol=1e-10),'registered bin probability sums')
            metric=views[name]['arms'][arm]
            need(metric['exact_zero'][TARGET]==groups[name]['arms'][arm]['zero']['n']-groups[name]['arms'][arm]['zero']['unknown'] and
                 metric['exact_one'][TARGET]==groups[name]['arms'][arm]['one']['n']-groups[name]['arms'][arm]['one']['unknown'],
                 'registered known-label zero/one counts')


def derive_joint(arrays,sid):
    maps={};common=None
    for h,a in arrays.items():
        n=len(a['sid']);need(a['sid'].dtype==np.int32 and a['ts'].dtype==np.int64 and a['sid'].shape==a['ts'].shape==(n,) and
            np.all(a['sid']==sid) and np.all(a['ts']%86400==0),'prepared source key schema')
        key=[int(t) for t in a['ts']];need(len(set(key))==n,'unique prepared keys')
        for flag in('issue_eligible','p_fH_valid','label_valid'):need(a[flag].dtype==bool and a[flag].shape==(n,),'prepared flag schema')
        maps[h]={t:i for i,t in enumerate(key)};common=set(key) if common is None else common&set(key)
    j=set();l5=0
    for ts in common:
        if EVAL0<=ts<END and all(arrays[h]['issue_eligible'][maps[h][ts]] and arrays[h]['p_fH_valid'][maps[h][ts]] for h in HORIZONS):
            j.add(ts);l5+=int(all(arrays[h]['label_valid'][maps[h][ts]] for h in HORIZONS))
    return np.array([int(t) in j for t in arrays[24]['ts']],bool),l5


def run(path,sha,*,status='DRAFT'):
    need(status==ADMITTED,'DRAFT: parent diagnostic admission required before input access')
    rp=pin(path);need(rp['sha256']==sha,'external diagnostic request SHA');q=read(rp,65536)
    need(set(q)=={'schema','status','scope','target_index','bins','pins','out'} and
        q['schema']=='q26-fixed-c-probability-diagnostic-request-v1' and q['status']==ADMITTED and q['scope']==SCOPE and
        q['target_index']==TARGET and q['bins']==list(BINS) and
        set(q['pins'])=={'parent_acceptance','manifest','prepared_manifest','report','source'},'frozen diagnostic scope and authorities')
    need(q['pins']['source']==pin(Path(__file__).resolve()),'current diagnostic source')
    accepted=read(q['pins']['parent_acceptance'],1024**2);parent=accepted['public_data'];evidence=accepted['private_evidence']
    need(parent['schema']=='q26-full277-fixed-c-parent-acceptance-v1' and parent['complete'] is True and parent['series']==277 and
        parent['original24_private_pairs_exact']==191 and parent['original24_native54_exact'] is True and
        parent['phase_closed'] is True and parent['unseen_validation'] is False and parent['forecast_promotion_status']=='NOT_ADMITTED' and
        evidence['manifest']==q['pins']['manifest'],'accepted sealed parent evidence')
    oldq=read(evidence['request'],2*1024**2);runtime=oldq['runtime']
    need(sys.executable==runtime['invocation_path'] and sys.dont_write_bytecode and sys.flags.optimize==0 and
        str(Path(sys.executable).resolve())==runtime['executable']['path'] and
        all(os.environ.get(k)==v for k,v in runtime['environment'].items()),'current accepted runtime')
    need(sys.version==runtime['version'] and np.__version__==runtime['packages']['numpy'],'current interpreter/NumPy versions')
    for p in [runtime['executable'],*runtime['native_pins']]:checked(p)
    # The sealed accepted request supplies pin identities. Raw-hourly files are
    # not diagnostic inputs and are neither opened nor rehashed here.
    inputs={}
    for p in oldq['files']:
        need(type(p)is dict and set(p)=={'path','size','sha256'} and type(p['size'])is int and p['size']>=0 and
            p['path'] not in inputs,'unique typed accepted pin metadata');inputs[p['path']]=p
    need(q['pins']['prepared_manifest']==oldq['pins']['preparation_manifest'],'same accepted baseline authority')
    m=read(q['pins']['manifest'],8*1024**2);pm=read(q['pins']['prepared_manifest'],8*1024**2)
    need(m['complete'] is True and m['scope']=='FULL277_UNCHANGED_FIXED_C_EVALUATION' and m['canonical_mapping']==oldq['canonical_mapping'] and
        len(m['series_receipts'])==len(pm['series_receipts'])==277 and m['reports']['component']==q['pins']['report'],
        'all277 sealed evaluated/prepared receipts')
    wrapper=read(q['pins']['report'],64*1024**2);report=wrapper['component']
    sid_parts=[];ts_parts=[];y_parts=[];known_parts=[];prediction_parts=[];all_expected=[];l5=0;case_provenance={};source_refs={};prepared_pins=[];output_pins=[q['pins']['manifest'],q['pins']['report']]
    fields=('sid','ts','issue_eligible','p_fH_valid','label_valid')
    for sid,((mapped,key),pp,ep) in enumerate(zip(oldq['canonical_mapping'],pm['series_receipts'],m['series_receipts'])):
        need(mapped==sid,'canonical full277 traversal');pr=read(pp,65536);er=read(ep,65536);output_pins.append(ep)
        need(pr['sid']==er['sid']==sid and pr['key']==er['key']==key and er['prepared_receipt']==pp and er['complete'] is True,'SID authoritative join')
        need(inputs.get(pp['path'])==pp and all(inputs.get(p['path'])==p for p in pr['outputs'].values()),'prepared artifacts in accepted input closure')
        prepared_pins.extend([pp,*pr['outputs'].values()])
        arrays={h:archive(pr['outputs'][str(h)],fields if h!=24 else (*fields,'y','p_fH','fH_fallback','quarter_cutoff')) for h in HORIZONS}
        onj,complete=derive_joint(arrays,sid);l5+=complete;a=arrays[24];n=len(a['sid'])
        need(a['y'].dtype==np.uint8 and a['y'].shape==(n,5) and np.isin(a['y'][a['label_valid']],[0,1]).all() and
            np.all(np.diff(a['y'][a['label_valid']].astype(np.int8),axis=1)>=0) and np.all(a['y'][~a['label_valid']]==0),
            'known binary nested labels and invalid-label zero encoding')
        expected_cut=[]
        for t in a['ts']:
            d=dt.datetime.fromtimestamp(int(t),dt.timezone.utc)
            expected_cut.append(int(dt.datetime(d.year,1+3*((d.month-1)//3),1,tzinfo=dt.timezone.utc).timestamp()))
        need(a['quarter_cutoff'].dtype==np.int64 and np.array_equal(a['quarter_cutoff'],np.array(expected_cut,np.int64)),'independent UTC issue-quarter join')
        meta=read(pr['outputs']['metadata']);h24=next(v for v in meta['series_horizons'] if v['horizon']==24)
        quarters=[v for v in h24['quarters'] if EVAL0<=v['quarter_cutoff']<END]
        summary=read(er['summary'],256*1024);output_pins.append(er['summary'])
        need(summary['sid']==sid and summary['key']==key and summary['prepared_receipt']==pp and
            summary['joint_ledger']['J_n']==int(onj.sum()) and summary['joint_ledger']['L24_n']==int(np.sum(onj&a['label_valid'])) and
            summary['joint_ledger']['L5_n']==complete and len(er['quarters'])==2*len(quarters) and
            [v['quarter_cutoff'] for v in quarters]==sorted(set(a['quarter_cutoff'][(a['ts']>=EVAL0)&(a['ts']<END)].tolist())),
            'all J and zeroJ calendar coverage')
        parts=[]
        for i,calendar in enumerate(quarters):
            qa=calendar['quarter_cutoff'];npin,jpin=er['quarters'][2*i:2*i+2];state=archive(npin,rows=92,cap=65536);receipt=read(jpin,65536)
            output_pins.extend((npin,jpin));take=onj&(a['quarter_cutoff']==qa);count=int(take.sum())
            need(set(state)=={'sid','ts','on_J','candidate_prediction_valid','fH_fallback','issuance_state',*ARMS} and
                state['sid'].dtype==np.int32 and state['ts'].dtype==np.int64 and state['sid'].shape==state['ts'].shape==(count,) and
                np.all(state['sid']==sid) and np.array_equal(state['ts'],a['ts'][take]),'exact quarterly prediction J join')
            for flag in('on_J','candidate_prediction_valid','fH_fallback'):need(state[flag].dtype==bool and state[flag].shape==(count,),'private flag encoding')
            need(state['on_J'].all() and state['candidate_prediction_valid'].all() and
                np.array_equal(state['fH_fallback'],a['fH_fallback'][take]) and
                state['A_raw_fH'].dtype==np.float64 and state['A_raw_fH'].tobytes()==a['p_fH'][take].tobytes(),
                'prediction-only J flags and exact baseline bytes')
            need(receipt['sid']==sid and receipt['quarter_cutoff']==qa and receipt['rows']==count and
                receipt['file']==Path(npin['path']).name and receipt['size']==npin['size'] and receipt['sha256']==npin['sha256'] and
                receipt['forecasts_only_on_original_J'] is True,'private container/clock/row receipt binding')
            for row in np.flatnonzero((state['C_conditional'][:,TARGET]==0)|(state['C_conditional'][:,TARGET]>=.8)):
                case_provenance[(sid,int(state['ts'][row]))]=dict(quarter_cutoff=qa,private_quarter=npin,private_row=int(row))
            parts.append(state)
        expected_sid=a['sid'][onj];expected_ts=a['ts'][onj]
        pred=join_predictions(expected_sid,expected_ts,parts)
        sid_parts.append(expected_sid);ts_parts.append(expected_ts);y_parts.append(a['y'][onj]);known_parts.append(a['label_valid'][onj]);prediction_parts.append(pred)
        all_expected += list(zip(expected_sid.tolist(),expected_ts.tolist()))
        source_refs[sid]=dict(key=key,prepared_receipt=pp,H24=pr['outputs']['24'])
    sid=np.concatenate(sid_parts);ts=np.concatenate(ts_parts);y=np.concatenate(y_parts);known=np.concatenate(known_parts)
    probabilities={arm:np.concatenate([p[arm] for p in prediction_parts]) for arm in ARMS}
    result=diagnose_rows(sid,ts,probabilities,y,known,expected_keys=all_expected,status=status)
    registered_bins(report,result);need(l5==report['L5_n']==parent['L5_n'],'L5 remains diagnostic, never a filter')
    result['public_data'].update(complete=True,series=277,L5_n=l5,registered_calendar_bins='EXACT_COUNTS_EVENTS_PROBABILITY_SUMS_WITHIN_1E-10',
        label_definition='Inclusive hourly-low H24 hit relative to issue spot; incomplete labels excluded from realized counts; not proof of exchange liquidation.',
        raw_label_provenance_replay='NOT_RUN_NO_RAW_HOURLY_READS')
    cases=result['private_data']['case_inventory'];used=set()
    for case in cases:
        case.update(case_provenance[(case['sid'],case['ts'])]);used.add(case['sid'])
    result['private_data']['source_refs']={str(s):source_refs[s] for s in sorted(used)}
    result['private_data']['accepted_evidence']=q['pins']
    result['private_data']['raw_label_replay_plan']=dict(scope='ALL_C_ZERO_OR_C_HIGH_MEMBERS_INCLUDING_UNKNOWN',
        selection='C==0 OR C>=.8 on the complete accepted prediction-only J; no cherry-picked cases',
        reference_counts_from_prior_review=dict(C_high=46,C_zero=331),reference_counts_are_not_selection_filters=True,
        steps=['Locate original frozen raw series by canonical SID/key and accepted raw authority.',
               'Use original hourly-grid origin index and issue spot; retain all24 future low bars [idx,idx+24).',
               'Check finite positive spot/lows and full24-hour coverage before labeling.',
               'Recompute the original float expression log(min(low[idx:idx+24])/spot[idx]) <= log1p(-0.1); record ratio<=0.90 separately for boundary arithmetic.',
               'Compare every selected case against saved label_valid/y; document mismatches before attributing cause.'],
        status='PLANNED_NOT_EXECUTED')
    for p in [runtime['executable'],*runtime['native_pins'],*prepared_pins,*output_pins]:checked(p)
    for p in q['pins'].values():checked(p)
    out=Path(q['out']);need(out.is_absolute() and str(out.resolve())==str(out) and out.parent==Path(path).parent and
        out.parent.is_dir() and not out.exists(),'fresh private diagnostic output beside its request')
    roots={Path(q['pins']['manifest']['path']).parent,Path(q['pins']['prepared_manifest']['path']).parent,HERE.parents[3],
        Path(runtime['executable']['path']).parent,Path(runtime['invocation_path']).parent.parent}
    need(all(not out.is_relative_to(root) for root in roots),'diagnostic output outside accepted data/source/runtime trees')
    protected=[Path(p['path']) for p in [rp,*q['pins'].values(),*oldq['files'],*output_pins]]
    need(all(out!=p and not p.is_relative_to(out) for p in protected),'output preserves exact accepted inputs')
    raw=json.dumps(result,allow_nan=False,separators=(',',':')).encode();need(len(raw)<=OUTPUT_CAP,'bounded diagnostic output; no truncation')
    with os.fdopen(os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    need(json.loads(out.read_bytes())==result,'diagnostic exact JSON readback')
    return pin(out)
