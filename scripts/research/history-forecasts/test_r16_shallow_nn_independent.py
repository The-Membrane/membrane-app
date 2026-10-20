"""Small synthetic evidence only; no producer, Torch, features, fits or real archives."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import r16_shallow_nn_independent as V

CAPS=dict(nmlp=8,ngru=4,ntcn=6,ntfm=4,nmlp0=8)


def reference_descriptor(a):
    a=np.ascontiguousarray(a)
    return dict(shape=list(a.shape),dtype=a.dtype.str,nbytes=a.nbytes,sha256=hashlib.sha256(a.tobytes()).hexdigest())
def reference_membership(ix,R,g):
    ix=np.asarray(ix,dtype='<i8');a=np.empty(len(ix),dtype=[tuple(x) for x in V.ROW_DTYPE]);a['core_index']=ix
    for name in ('sid','ts','T','Tidx'):a[name]=R[name][ix]
    u,c=np.unique(g[ix],return_counts=True)
    return dict(count=len(ix),ordered_indices=reference_descriptor(ix),sorted_indices=reference_descriptor(np.sort(ix)),
        row_identity_sha256=hashlib.sha256(a.tobytes()).hexdigest(),row_identity_dtype=V.ROW_DTYPE,groups={str(int(k)):int(n) for k,n in zip(u,c)})
def synthetic_replay(fractional=False):
    keys=[]
    for target in range(4):
        i=0
        while True:
            key=f'synthetic-{target}-{i}'
            if hashlib.sha256(('Q26-R16.2-dev:'+key).encode()).digest()[0]%4==target:keys.append(key);break
            i+=1
    times=np.arange(86400,11*86400+1,43200,dtype=np.int64);n=len(times)*4
    R=dict(sid=np.tile(np.repeat(np.arange(4,dtype=np.int32),len(times)),3),ts=np.tile(times,12),
        T=np.repeat([1,3,12],n).astype(np.int32),Tidx=np.repeat([0,1,2],n).astype(np.int32))
    if fractional:
        center=np.flatnonzero(R['ts']==6*86400);R['ts'][center[::2]]+=1
    g=np.tile(np.repeat(np.arange(4),len(times)),3);split=float(np.median(R['ts']));rng=np.random.default_rng(20261903);receipts=[]
    for sh in (0,1):
        for tt in (0,1):
            target=(g%2==sh)&((R['ts']>=split) if tt else (R['ts']<split))&(R['ts']%86400==0)
            allowed=(g%2!=sh)&((R['ts']+43200<=split) if tt else (R['ts']>=split+43200))
            all_rows=np.where(allowed)[0];group=min(g[all_rows]);val=all_rows[g[all_rows]==group];train=all_rows[g[all_rows]!=group]
            train=rng.choice(train,8,replace=False);val=rng.choice(val,8,replace=False)
            for m in V.MODELS:
                ix=train[:CAPS[m]];epoch=2+len(receipts)%3
                fit=dict(cell=[sh,tt],model=m,train=len(ix),val=len(val),test=int(target.sum()),epochs=epoch,val_bce=.6,sec=.1)
                receipts.append(dict(ordinal=len(receipts),cell=[sh,tt],model=m,tsplit_float=split,original_fit=fit,
                    membership={name:reference_membership(rows,R,g) for name,rows in dict(tr_all=all_rows,tr_full=train,tr=ix,va=val,te=np.where(target)[0]).items()}))
                for _ in range(epoch):rng.permutation(ix)
    return R,keys,receipts,[copy.deepcopy(r['original_fit']) for r in receipts]
def write(path,value):path.write_text(json.dumps(value,allow_nan=False));return pin(path)
def pin(path):return dict(path=str(path),size=path.stat().st_size,sha256=V.sha(path))
def archive_fixture(root):
    base=root/'base';out=root/'out';base.mkdir();out.mkdir();counts={T:6 for T in V.HORIZONS};payloads={}
    for T in V.HORIZONS:
        sid=np.array([0,0,0,1,1,1],np.int32);ts=np.array([86400,90000,172800,86400,90000,172800],np.int64)
        np.savez(base/f'rows-T{T}.npz',sid=sid,ts=ts)
        a=np.tile(np.linspace(.8,.2,V.WIDTHS[T],dtype=np.float32),(6,1));a[ts%86400!=0]=np.nan
        payload=dict(sid=sid,ts=ts,**{m:a.copy() for m in V.MODELS});payloads[T]=payload
        np.savez(out/f'rows-nn-T{T}.npz',**payload)
    return base,out,counts,payloads


def allocation_fixture(root,defect=None):
    source=root/'source.py';source.write_text('# source');sources={'source.py':V.sha(source)}
    ancestor=write(root/'scope.json',dict(phase='allocation',source_sha256=sources));digest=ancestor['sha256']
    actual=dict(status='allocation-only-before-first-make_model',neural_fits=0,completed=False,scope_sha256=digest,
        first_membership={'membership':{'tr':{'count':2}},'tsplit_float':1.5})
    if defect=='raw_status':actual['status']='training'
    if defect=='raw_fits':actual['neural_fits']=20
    if defect=='raw_completed':actual['completed']=True
    ap=write(root/'allocation.json',actual)
    child=dict(complete=True,phase='allocation',scope_sha256=digest,allocation_only=True,neural_fits=0,audit_violations={'total':0,'attempts':[]})
    if defect=='child_fits':child['neural_fits']=20
    if defect=='child_audit':child['audit_violations']={'total':1,'attempts':[]}
    if defect=='child_kind':child['allocation_only']=False
    cp=write(root/'child.json',child)
    start=dict(phase='allocation',scope_sha256=digest,child_pid=1,child_pgid=1)
    if defect=='start_scope':start['scope_sha256']='wrong'
    write(root/'monitor-start.json',start)
    monitor=dict(complete=True,phase='allocation',scope_sha256=digest,child_exit=0,failure=None,child_pid=1,
        peak_sampled_child_rss_bytes=1,elapsed_seconds=1,child_receipt=cp)
    if defect=='monitor_exit':monitor['child_exit']=1
    if defect=='monitor_failure':monitor['failure']='failed'
    if defect=='monitor_child':monitor['child_receipt']=ap
    if defect=='monitor_rss':monitor['peak_sampled_child_rss_bytes']=0
    mp=write(root/'monitor.json',monitor)
    independent=dict(complete=True,scope_sha256=digest,source_pins_verified=1,hardlink_inputs_verified=5,neural_fits=0,first_model_constructed=False,
        first_cell_membership_verified=actual['first_membership']['membership'],tsplit_float=1.5,audit_violations=0,
        monitor_sha256=mp['sha256'],child_sha256=cp['sha256'],allocation_sha256=ap['sha256'])
    if defect=='independent_model':independent['first_model_constructed']=True
    ip=write(root/'independent.json',independent);request=write(root/'request.json',dict(parent_verified_allocation_independent_receipt=ip))
    return dict(request=request,source_sha256=sources,allocation_proof=[ancestor,cp,mp],allocation_receipt=ap),ip


class ConditionalReplay(unittest.TestCase):
    def setUp(self):self.R,self.keys,self.receipts,self.meta=synthetic_replay()
    def run_replay(self,rows=None,receipts=None,meta=None):
        return V.replay(self.R if rows is None else rows,self.keys,self.receipts if receipts is None else receipts,self.meta if meta is None else meta,max_train=8,caps=CAPS)
    def test_positive_twenty_varied_epochs_sampling_caps_and_inclusive_boundary(self):
        result=self.run_replay();self.assertEqual(result['fits'],20);self.assertEqual(set(result['conditional_epochs']),{2,3,4})
        self.assertEqual(V.split_time(np.array([1,2],np.int64)),1.5)
        rows,keys,receipts,meta=synthetic_replay(fractional=True)
        self.assertEqual(V.replay(rows,keys,receipts,meta,max_train=8,caps=CAPS)['tsplit_float'],6*86400+.5)
        receipts[0]['tsplit_float']=6*86400
        with self.assertRaisesRegex(ValueError,'floating median'):V.replay(rows,keys,receipts,meta,max_train=8,caps=CAPS)
        split=result['tsplit_float'];g=V.groups(self.keys,self.R['sid'])
        boundary=np.flatnonzero((self.R['ts']+43200==split)&(g%2!=0))
        self.assertTrue(len(boundary));self.assertGreater(self.receipts[5]['membership']['tr_all']['count'],len(boundary))
    def test_missing_duplicate_order_group_and_identity_corruption(self):
        bads=[]
        r=copy.deepcopy(self.receipts);r.pop();bads.append(r)
        r=copy.deepcopy(self.receipts);r[1]=copy.deepcopy(r[0]);bads.append(r)
        r=copy.deepcopy(self.receipts);r[0],r[1]=r[1],r[0];bads.append(r)
        for name in ('groups','row_identity_sha256'):
            r=copy.deepcopy(self.receipts);r[0]['membership']['tr'][name]={'0':8} if name=='groups' else '0'*64;bads.append(r)
        r=copy.deepcopy(self.receipts);r[0]['membership']['tr']['ordered_indices']['sha256']='0'*64;bads.append(r)
        for bad in bads:
            with self.subTest(kind=str(bad[:1])[:30]),self.assertRaises(ValueError):self.run_replay(receipts=bad)
        changed={k:v.copy() for k,v in self.R.items()};changed['Tidx'][0]=99
        with self.assertRaises(ValueError):self.run_replay(rows=changed)
    def test_boundary_epoch_and_stream_consumption_mutations(self):
        changed={k:v.copy() for k,v in self.R.items()};split=float(np.median(changed['ts']));mask=changed['ts']+43200==split;changed['ts'][mask]+=1
        with self.assertRaises(ValueError):self.run_replay(rows=changed)
        for ep in (True,1,5,2.5):
            r=copy.deepcopy(self.receipts);m=copy.deepcopy(self.meta);r[0]['original_fit']['epochs']=ep;m[0]['epochs']=ep
            with self.subTest(epoch=ep),self.assertRaises(ValueError):self.run_replay(receipts=r,meta=m)
        r=copy.deepcopy(self.receipts);m=copy.deepcopy(self.meta);r[0]['original_fit']['epochs']=3;m[0]['epochs']=3
        with self.assertRaisesRegex(ValueError,'membership'):self.run_replay(receipts=r,meta=m)
        r=copy.deepcopy(self.receipts);m=copy.deepcopy(self.meta);r[-1]['original_fit']['epochs']=4;m[-1]['epochs']=4
        self.assertEqual(self.run_replay(receipts=r,meta=m)['fits'],20)  # No later membership can refute last-fit stopping.


class OutputsAndAdmission(unittest.TestCase):
    def test_all_non_nmlp_models_coverage_range_order_dtype_shape(self):
        with tempfile.TemporaryDirectory() as t:
            base,out,counts,payloads=archive_fixture(Path(t));self.assertEqual(len(V.coverage(base,out,counts)),3)
            for model in V.MODELS[1:]:
                for defect in ('daily_nan','outside_finite','range','nonmonotone','dtype','shape'):
                    changed=copy.deepcopy(payloads[12]);a=changed[model]
                    if defect=='daily_nan':a[0,0]=np.nan
                    if defect=='outside_finite':a[1,0]=.1
                    if defect=='range':a[0,0]=1.1
                    if defect=='nonmonotone':a[0,1]=.9
                    if defect=='dtype':changed[model]=a.astype(np.float64)
                    if defect=='shape':changed[model]=a[:,:-1]
                    np.savez(out/'rows-nn-T12.npz',**changed)
                    with self.subTest(model=model,defect=defect),self.assertRaises(ValueError):V.coverage(base,out,counts)
            changed=copy.deepcopy(payloads[12]);changed['sid']=changed['sid'][::-1];np.savez(out/'rows-nn-T12.npz',**changed)
            with self.assertRaisesRegex(ValueError,'order'):V.coverage(base,out,counts)
    def test_terminal_positive_and_failed_dirty_missing_mutated_replaced_evidence(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t).resolve();base,out,counts,_=archive_fixture(root);R,keys,receipts,meta=synthetic_replay()
            for name in ('rows-meta.json','merge-provenance.json'):write(base/name,{})
            inputs={name:pin(base/name) for name in V.INPUTS};links={}
            for name,p in inputs.items():
                source=Path(p['path']);dest=out/name;dest.hardlink_to(source);st=dest.stat()
                links[name]=dict(source=str(source),destination=str(dest),device=st.st_dev,inode=st.st_ino,nlink=st.st_nlink,size=st.st_size,sha256=p['sha256'],incremental_payload_bytes=0)
            write(out/'links.json',links)
            for i,r in enumerate(receipts):write(out/f'fit-{i:02d}.json',r)
            npin=write(out/'nn-meta.json',dict(info={'shallow':{'fits':meta}}))
            child=dict(complete=True,phase='fit',scope_sha256='scope',neural_fits=20,audit_violations={'total':0,'attempts':[]},opened_raw_inputs={},
                output_pins=[pin(out/f'rows-nn-T{T}.npz') for T in V.HORIZONS],nn_meta=npin)
            cp=write(out/'child.json',child);monitor=dict(complete=True,phase='fit',scope_sha256='scope',child_exit=0,failure=None,child_pid=123,elapsed_seconds=10,peak_sampled_child_rss_bytes=100,child_receipt=cp)
            write(out/'monitor.json',monitor);write(out/'monitor-start.json',dict(phase='fit',scope_sha256='scope',child_pid=123,child_pgid=123))
            write(out/'audit.json',dict(violations={'total':0,'attempts':[]},opened_raw_inputs={}))
            scope=dict(evidence={'inputs':inputs,'raw_pins':[]},resource_policy={'wall_seconds':20,'rss_bytes':200},archive_bounds={f'rows-nn-T{T}.npz':100000 for T in V.HORIZONS})
            registry=V.Pins(root/'raw');V.terminal(scope,'scope',out,registry)
            old=(out/'fit-00.json').read_bytes();(out/'fit-00.json').write_bytes(old+b' ')
            with self.assertRaises(ValueError):registry.recheck()
            with self.assertRaisesRegex(ValueError,'conflicting'):registry.snapshot(out/'fit-00.json')
            (out/'fit-00.json').write_bytes(old)
            for target,key,value in (('monitor.json','complete',False),('child.json','complete',False),('audit.json','violations',{'total':1,'attempts':[]})):
                original=(out/target).read_bytes();d=V.load(out/target);d[key]=value;write(out/target,d)
                with self.assertRaises(ValueError):V.terminal(scope,'scope',out,V.Pins(root/'raw'))
                (out/target).write_bytes(original)
            original=(out/'nn-meta.json').read_bytes();(out/'nn-meta.json').write_bytes(b'{}')
            with self.assertRaises(ValueError):V.terminal(scope,'scope',out,V.Pins(root/'raw'))
            (out/'nn-meta.json').write_bytes(original)
            dest=out/'rows-T1.npz';data=dest.read_bytes();dest.unlink();dest.write_bytes(data)
            with self.assertRaisesRegex(ValueError,'hardlink'):V.terminal(scope,'scope',out,V.Pins(root/'raw'))
    def test_allocation_full_positive_and_rehashed_contradictions(self):
        cases=(None,'raw_status','raw_fits','raw_completed','child_fits','child_audit','child_kind','monitor_exit','monitor_failure','monitor_child','monitor_rss','start_scope','independent_model')
        for defect in cases:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory() as t:
                root=Path(t).resolve();scope,ip=allocation_fixture(root,defect);registry=V.Pins(root/'raw')
                with patch.object(V,'ROOT',root):
                    registry.walk(scope)
                    if defect is None:
                        self.assertEqual(V.allocation_admission(scope,ip['path'],ip['sha256'],registry),{'tr':{'count':2}});registry.recheck()
                    else:
                        with self.assertRaises(ValueError):V.allocation_admission(scope,ip['path'],ip['sha256'],registry)
    def test_unique_json_source_pin_and_missing_request_allocation_binding(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);p=root/'duplicate.json';p.write_text('{"x":1,"x":2}')
            with self.assertRaisesRegex(ValueError,'duplicate'):V.load(p)
            source=root/'source.py';source.write_text('original')
            with patch.object(V,'ROOT',root):
                pins=V.Pins(root/'raw');pins.walk({'source_sha256':{'source.py':V.sha(source)}});source.write_text('changed')
                with self.assertRaises(ValueError):pins.recheck()
            allocation=root/'allocation.json';write(allocation,dict(complete=True));request=root/'request.json';write(request,{})
            with self.assertRaisesRegex(ValueError,'request binding'):V.allocation_admission({'request':pin(request)},allocation,V.sha(allocation),V.Pins(root/'raw'))


if __name__=='__main__':unittest.main()
