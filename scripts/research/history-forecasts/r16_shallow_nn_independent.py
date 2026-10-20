"""Independent, conditional twenty-fit evidence verifier. stdlib+NumPy; NO Torch/producer imports.
Replays NumPy scheduling conditional on recorded epochs, not training/stopping/weights.
Run before scoring (which currently rewrites the shared audit sidecar).
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata as md
import json
from pathlib import Path
import platform
import re
import struct
import sys
import zipfile
import numpy as np

ROOT=Path(__file__).resolve().parents[3]
MODELS=('nmlp','ngru','ntcn','ntfm','nmlp0')
HORIZONS=(1,3,12);WIDTHS={1:3,3:4,12:5};COUNTS={1:1424924,3:1424353,12:1422858}
INPUTS=('rows-T1.npz','rows-T3.npz','rows-T12.npz','rows-meta.json','merge-provenance.json')
ORDER=[(s,t,m) for s in (0,1) for t in (0,1) for m in MODELS]
ROW_DTYPE=[['core_index','<i8'],['sid','<i4'],['ts','<i8'],['T','<i4'],['Tidx','<i4']]
LIMITATION='Conditional replay uses actual recorded epochs; does not independently verify stopping, Torch RNG, gradients, weights, optimizer steps, or predictions. Retrospective seen-development support, not forward/blind/causal evidence.'


def fail(message):raise ValueError(message)
def sha(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return h.hexdigest()
def unique(pairs):
    d={}
    for k,v in pairs:
        if k in d:fail('duplicate JSON key: '+k)
        d[k]=v
    return d
def load(path):
    with open(path) as f:return json.load(f,object_pairs_hook=unique,parse_constant=lambda x:fail('nonfinite JSON '+x))
def descriptor(a):
    a=np.ascontiguousarray(a)
    return dict(shape=list(a.shape),dtype=a.dtype.str,nbytes=a.nbytes,sha256=hashlib.sha256(memoryview(a).cast('B')).hexdigest())
def integer(v):return isinstance(v,int) and not isinstance(v,bool)


class Pins:
    def __init__(self,raw_root):self.raw_root=Path(raw_root).resolve();self.entries={};self.sources={};self.documents=set()
    def check(self,pin):
        path=Path(pin['path'])
        if not path.is_file() or path.stat().st_size!=pin['size'] or sha(path)!=pin['sha256']:fail('pin changed: '+str(path))
        key=str(path.resolve());record=dict(path=key,size=pin['size'],sha256=pin['sha256'])
        if key in self.entries and self.entries[key]!=record:fail('conflicting/changed evidence pin: '+key)
        self.entries[key]=record
    def walk(self,value):
        if isinstance(value,dict):
            if {'path','size','sha256'}<=value.keys():
                self.check(value);path=Path(value['path']).resolve()
                if path.suffix=='.json' and not path.is_relative_to(self.raw_root) and str(path) not in self.documents:
                    self.documents.add(str(path));self.walk(load(path))
            else:
                if 'source_sha256' in value:
                    for relative,digest in value['source_sha256'].items():
                        path=ROOT/relative
                        if sha(path)!=digest:fail('source pin changed: '+relative)
                        self.sources[str(path)]=digest
                for child in value.values():self.walk(child)
        elif isinstance(value,list):
            for child in value:self.walk(child)
    def snapshot(self,path):
        path=Path(path);self.check(dict(path=str(path),size=path.stat().st_size,sha256=sha(path)))
        return load(path)
    def recheck(self):
        for pin in list(self.entries.values()):self.check(pin)
        for path,digest in self.sources.items():
            if sha(path)!=digest:fail('source changed during verification')


def core_rows(base,counts=COUNTS):
    parts=[]
    for j,T in enumerate(HORIZONS):
        with np.load(Path(base)/f'rows-T{T}.npz',allow_pickle=False) as z:sid=z['sid'];ts=z['ts']
        if sid.dtype.str!='<i4' or ts.dtype.str!='<i8' or sid.shape!=(counts[T],) or ts.shape!=sid.shape:fail('base row dtype/shape')
        parts.append(dict(sid=sid,ts=ts,T=np.full(len(ts),T,np.int32),Tidx=np.full(len(ts),j,np.int32)))
    return {k:np.concatenate([p[k] for p in parts]) for k in parts[0]}
def split_time(ts):
    n=len(ts)
    if not n:fail('empty pooled support')
    k=n//2;p=np.partition(ts.copy(),[k-1,k] if n%2==0 else k)
    return (int(p[k-1])+int(p[k]))/2 if n%2==0 else float(p[k])
def groups(keys,sid):
    if len(set(keys))!=len(keys) or np.any(sid<0) or np.any(sid>=len(keys)):fail('canonical SID identity')
    g=np.array([hashlib.sha256(('Q26-R16.2-dev:'+k).encode()).digest()[0]%4 for k in keys],np.int8)
    return g[sid]
def membership(ix,R,g):
    ix=np.asarray(ix,dtype='<i8');h=hashlib.sha256();pack=struct.Struct('<qiqii').pack
    for begin in range(0,len(ix),8192):
        h.update(b''.join(pack(int(i),int(R['sid'][i]),int(R['ts'][i]),int(R['T'][i]),int(R['Tidx'][i])) for i in ix[begin:begin+8192]))
    labels,counts=np.unique(g[ix],return_counts=True)
    return dict(count=len(ix),ordered_indices=descriptor(ix),sorted_indices=descriptor(np.sort(ix)),row_identity_sha256=h.hexdigest(),
        row_identity_dtype=ROW_DTYPE,groups={str(int(a)):int(b) for a,b in zip(labels,counts)})
def replay(R,keys,receipts,meta_fits,max_train=60000,caps=None):
    if len(receipts)!=20 or len(meta_fits)!=20:fail('exact twenty receipts/metadata fits required')
    caps=caps or dict(nmlp=60000,ngru=20000,ntcn=30000,ntfm=20000,nmlp0=60000)
    ts=R['ts'];split=split_time(ts);g=groups(keys,R['sid']);half=g%2;rng=np.random.default_rng(20261903);position=0;seen=np.zeros(len(ts),np.int8);states=[]
    for sh in (0,1):
        for tt in (0,1):
            te=np.flatnonzero((half==sh)&((ts>=split) if tt else (ts<split))&(ts%86400==0))
            tr_all=np.flatnonzero((half!=sh)&((ts+43200<=split) if tt else (ts>=split+43200)))
            if not len(te) or not len(tr_all):fail('empty retrospective cell')
            seen[te]+=1;vg=int(g[tr_all].min());va=tr_all[g[tr_all]==vg];tr=tr_all[g[tr_all]!=vg]
            if not len(tr) or not len(va):fail('empty train/validation group')
            if len(tr)>max_train:tr=rng.choice(tr,max_train,replace=False)
            full=tr
            if len(va)>max_train:va=rng.choice(va,max_train,replace=False)
            cache={}
            for m in MODELS:
                r=receipts[position];fit=r['original_fit'];identity=(sh,tt,m)
                if not integer(r['ordinal']) or not all(integer(v) for v in r['cell']) or r['ordinal']!=position or r['cell']!=[sh,tt] or r['model']!=m or fit!=meta_fits[position] or (fit['cell'],fit['model'])!=([sh,tt],m):fail('fit order/metadata mismatch')
                if isinstance(r['tsplit_float'],bool) or r['tsplit_float']!=split:fail('floating median mismatch')
                chosen=full[:caps[m]];expected={}
                for name,ix in dict(tr_all=tr_all,tr_full=full,tr=chosen,va=va,te=te).items():
                    key=hashlib.sha256(np.asarray(ix,dtype='<i8').tobytes()).hexdigest()
                    if key not in cache:cache[key]=membership(ix,R,g)
                    expected[name]=cache[key]
                if r['membership']!=expected:fail('membership/order/composite mismatch at fit '+str(position))
                for name,ix in (('train',chosen),('val',va),('test',te)):
                    if not integer(fit[name]) or fit[name]!=len(ix):fail('original fit count mismatch')
                ep=fit['epochs']
                if not integer(ep) or ep<2 or ep>4:fail('invalid conditional epoch count')
                if not isinstance(fit['val_bce'],(int,float)) or isinstance(fit['val_bce'],bool) or not np.isfinite(fit['val_bce']) or fit['val_bce']<0:fail('invalid recorded BCE')
                for _ in range(ep):rng.permutation(chosen)
                states.append(hashlib.sha256(json.dumps(rng.bit_generator.state,sort_keys=True).encode()).hexdigest());position+=1
    if not np.array_equal(seen,(ts%86400==0).astype(np.int8)):fail('test cells do not partition daily support')
    return dict(fits=position,tsplit_float=split,newly_replayed_numpy_state_sha256=states,conditional_epochs=[f['epochs'] for f in meta_fits])


def coverage(base,out,counts=COUNTS):
    result={}
    for T in HORIZONS:
        with np.load(Path(base)/f'rows-T{T}.npz',allow_pickle=False) as z:sid=z['sid'];ts=z['ts']
        n=counts[T];width=WIDTHS[T];expected={'sid','ts',*MODELS};daily=ts%86400==0
        if len(ts)!=n or not daily.any():fail('output support empty/differs')
        path=Path(out)/f'rows-nn-T{T}.npz'
        with zipfile.ZipFile(path) as z:
            if set(z.namelist())!={k+'.npy' for k in expected} or len(z.infolist())!=7:fail('NN ZIP fields/duplicates')
            for entry in z.infolist():
                bound=n*(12 if entry.filename in ('sid.npy','ts.npy') else width*4)+4096
                if entry.file_size>bound:fail('NN array inflated size bound')
        with np.load(path,allow_pickle=False) as z:
            for name,a in (('sid',sid),('ts',ts)):
                if descriptor(z[name])!=descriptor(a):fail('NN SID/timestamp order')
            hashes={}
            for m in MODELS:
                p=z[m]
                if p.dtype.str!='<f4' or p.shape!=(n,width):fail('NN prediction dtype/shape')
                for start in range(0,n,65536):
                    a=p[start:start+65536];d=daily[start:start+65536];v=a[d]
                    if not np.isfinite(v).all() or not np.isnan(a[~d]).all():fail('all-model daily coverage')
                    if np.any(v<0) or np.any(v>1) or np.any(np.diff(v,axis=1)>0):fail('NN probability range/monotonicity')
                hashes[m]=descriptor(p);del p
        result[str(T)]=dict(rows=n,daily_rows=int(daily.sum()),models=hashes)
    return result



def monitor_admission(monitor,start,phase,digest):
    for value in (monitor,start):
        if value.get('scope_sha256')!=digest or value.get('phase')!=phase:fail('monitor scope/phase mismatch')
    if monitor.get('complete') is not True or not integer(monitor.get('child_exit')) or monitor['child_exit']!=0 or monitor.get('failure') is not None:fail('successful zero-exit monitor required')
    pid=monitor['child_pid'];rss=monitor['peak_sampled_child_rss_bytes'];elapsed=monitor['elapsed_seconds']
    if not integer(pid) or pid<=0 or start['child_pid']!=pid or start['child_pgid']!=pid:fail('positive child PID/group required')
    if not integer(rss) or rss<=0 or isinstance(elapsed,bool) or not isinstance(elapsed,(int,float)) or not np.isfinite(elapsed) or elapsed<0:fail('invalid monitor telemetry')


def terminal(scope,digest,out,pins):
    out=Path(out);monitor=pins.snapshot(out/'monitor.json');child=pins.snapshot(out/'child.json');audit=pins.snapshot(out/'audit.json');start=pins.snapshot(out/'monitor-start.json')
    monitor_admission(monitor,start,'fit',digest)
    for value in (monitor,child,start):
        if value.get('scope_sha256')!=digest or value.get('phase')!='fit':fail('terminal scope/phase mismatch')
    if monitor.get('complete') is not True or child.get('complete') is not True or not integer(monitor.get('child_exit')) or monitor.get('child_exit')!=0 or monitor.get('failure') is not None or child.get('neural_fits')!=20:fail('successful terminal twenty-fit run required')
    if monitor['child_pid']!=start['child_pid'] or start['child_pgid']!=start['child_pid']:fail('child PID/group evidence differs')
    for ledger in (child['audit_violations'],audit['violations']):
        if ledger!={'total':0,'attempts':[]}:fail('dirty persistent audit')
    if audit['opened_raw_inputs']!=child['opened_raw_inputs'] or set(child['opened_raw_inputs'])-{p['path'] for p in scope['evidence']['raw_pins']}:fail('raw read ledger differs/unapproved')
    policy=scope['resource_policy']
    if monitor['elapsed_seconds']>policy['wall_seconds'] or monitor['peak_sampled_child_rss_bytes']>policy['rss_bytes']:fail('recorded operational budget exceeded')
    if monitor['child_receipt']['path']!=str(out/'child.json'):fail('child receipt path differs')
    pins.walk(monitor['child_receipt']);pins.walk(child['output_pins']);pins.walk(child['nn_meta'])
    if {Path(p['path']).name for p in child['output_pins']}!={f'rows-nn-T{T}.npz' for T in HORIZONS} or len(child['output_pins'])!=3:fail('exact NN output pins required')
    for p in child['output_pins']:
        if Path(p['path']).parent!=out or Path(p['path']).stat().st_size>scope['archive_bounds'][Path(p['path']).name]:fail('output location/archive bound')
    links=pins.snapshot(out/'links.json')
    if set(links)!=set(INPUTS):fail('five hardlinks required')
    for name,pin in scope['evidence']['inputs'].items():
        source=Path(pin['path']);dest=out/name;proof=links[name];a,b=source.stat(),dest.stat()
        if dest.is_symlink() or source.is_symlink() or (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino) or (b.st_dev,b.st_ino)!=(proof['device'],proof['inode']) or b.st_nlink<2:fail('hardlink identity replaced')
        if proof['source']!=str(source) or proof['destination']!=str(dest) or proof['size']!=b.st_size or proof['sha256']!=pin['sha256'] or proof['incremental_payload_bytes']!=0:fail('hardlink receipt differs')
    found={p.name for p in out.glob('fit-*.json')}
    if found!={f'fit-{i:02d}.json' for i in range(20)}:fail('missing/extra fit receipt')
    receipts=[pins.snapshot(out/f'fit-{i:02d}.json') for i in range(20)];meta=pins.snapshot(out/'nn-meta.json')
    if child['nn_meta']['path']!=str(out/'nn-meta.json') or set(meta['info'])!={'shallow'}:fail('NN metadata location/tier')
    return child,receipts,meta



def allocation_admission(scope,path,digest,pins):
    request=load(scope['request']['path']);bound=request.get('parent_verified_allocation_independent_receipt')
    if bound!=dict(path=str(Path(path).resolve()),size=Path(path).stat().st_size,sha256=digest):fail('independent allocation request binding required')
    pins.check(bound);value=load(path);proof=scope['allocation_proof'];ancestor=load(proof[0]['path'])
    child=pins.snapshot(proof[1]['path']);monitor=pins.snapshot(proof[2]['path']);actual=pins.snapshot(scope['allocation_receipt']['path'])
    start=pins.snapshot(Path(proof[2]['path']).parent/'monitor-start.json');monitor_admission(monitor,start,'allocation',proof[0]['sha256'])
    if monitor.get('child_receipt')!=proof[1]:fail('allocation monitor child receipt differs')
    if value.get('complete') is not True or value.get('scope_sha256')!=proof[0]['sha256'] or ancestor['phase']!='allocation':fail('independent allocation scope/completion')
    if ancestor['source_sha256']!=scope['source_sha256'] or value.get('source_pins_verified')!=len(ancestor['source_sha256']):fail('allocation source identity')
    if value.get('neural_fits')!=0 or value.get('first_model_constructed') is not False or value.get('audit_violations')!=0 or value.get('hardlink_inputs_verified')!=5:fail('independent zero-fit allocation required')
    if actual.get('status')!='allocation-only-before-first-make_model' or not integer(actual.get('neural_fits')) or actual['neural_fits']!=0 or actual.get('completed') is not False or actual.get('scope_sha256')!=proof[0]['sha256']:fail('actual allocation is not a zero-model stop')
    if child.get('allocation_only') is not True or not integer(child.get('neural_fits')) or child['neural_fits']!=0 or child.get('audit_violations')!={'total':0,'attempts':[]}:fail('actual child is not a clean zero-fit allocation')
    for obj in (child,monitor):
        if obj.get('complete') is not True or obj.get('scope_sha256')!=proof[0]['sha256'] or obj.get('phase')!='allocation':fail('terminal allocation evidence')
    for field,pin in (('monitor_sha256',proof[2]),('child_sha256',proof[1]),('allocation_sha256',scope['allocation_receipt'])):
        if value.get(field)!=pin['sha256']:fail('independent allocation artifact mismatch')
    if value.get('first_cell_membership_verified')!=actual['first_membership']['membership'] or value.get('tsplit_float')!=actual['first_membership']['tsplit_float']:fail('independent allocation membership differs')
    return actual['first_membership']['membership']


def verify(scope_path,digest,allocation_path,allocation_sha):
    implementation=Path(__file__).resolve()
    implementation_pin=dict(path=str(implementation),size=implementation.stat().st_size,sha256=sha(implementation))
    if any(n=='torch' or n.startswith('torch.') for n in sys.modules):fail('Torch already imported')
    if sha(scope_path)!=digest:fail('explicit fit scope SHA mismatch')
    scope=load(scope_path);e=scope['evidence'];out=Path(scope['out']).resolve();pins=Pins(e['datasets'])
    pins.check(implementation_pin)
    pins.check(dict(path=str(scope_path),size=Path(scope_path).stat().st_size,sha256=digest));pins.walk(scope)
    if scope['schema']!='r16-shallow-original-nn-v1' or scope['phase']!='fit' or scope['original_recipe']!=dict(seed=20261903,models=list(MODELS),tiers='shallow',threads=1):fail('original shallow fit scope required')
    if len(e['canonical_keys'])!=277 or len(e['raw_pins'])!=282 or set(e['inputs'])!=set(INPUTS):fail('original277/282/five-input identity')
    if sha(allocation_path)!=allocation_sha:fail('independent allocation SHA differs')
    allocation_membership=allocation_admission(scope,allocation_path,allocation_sha,pins)
    probe=load(scope['runtime_probe']['path']);current=sorted([d.metadata['Name'].lower(),d.version] for d in md.distributions() if d.metadata.get('Name'))
    runtime=scope['runtime']['base']
    if np.__version__!=probe['numpy_version'] or current!=runtime['packages'] or sys.executable!=runtime['executable'] or sys.version!=runtime['python'] or platform.machine()!=runtime['machine']:fail('verifier runtime/NumPy differs')
    if (out/'score.json').exists() or (out/'dev-r162-nn.json').exists():fail('pre-score verification required')
    child,receipts,meta=terminal(scope,digest,out,pins)
    if receipts[0]['membership']!=allocation_membership:fail('first fit differs from accepted allocation')
    base=Path(e['inputs']['rows-meta.json']['path']).parent;keys=load(base/'rows-meta.json')['series']
    if keys!=e['canonical_keys']:fail('canonical key order changed')
    R=core_rows(base);replayed=replay(R,keys,receipts,meta['info']['shallow']['fits'])
    if meta['info']['shallow']['rows']!=len(R['ts']) or meta['info']['shallow']['tsplit']!=int(replayed['tsplit_float']):fail('original metadata support/split')
    actual=coverage(base,out)
    if actual!=child['coverage'] or actual!=pins.snapshot(out/'coverage.json'):fail('coverage receipts differ')
    pins.recheck()
    return dict(complete=True,scope_sha256=digest,independent_allocation_sha256=allocation_sha,fit_replay=replayed,coverage=actual,
        numpy_version=np.__version__,verifier_runtime=dict(executable=sys.executable,python_version=sys.version),
        verified_file_pins=len(pins.entries),verified_source_pins=len(pins.sources),evidence_pins=list(pins.entries.values()),source_sha256=pins.sources,limitations=LIMITATION)


def main():
    p=argparse.ArgumentParser();p.add_argument('--scope',required=True);p.add_argument('--scope-sha256',required=True)
    p.add_argument('--allocation-independent',required=True);p.add_argument('--allocation-independent-sha256',required=True);p.add_argument('--out',required=True);a=p.parse_args()
    if Path(a.out).exists():raise FileExistsError('verification receipt exists')
    value=verify(a.scope,a.scope_sha256,a.allocation_independent,a.allocation_independent_sha256)
    with open(a.out,'x') as f:json.dump(value,f,indent=2,allow_nan=False)
if __name__=='__main__':main()
