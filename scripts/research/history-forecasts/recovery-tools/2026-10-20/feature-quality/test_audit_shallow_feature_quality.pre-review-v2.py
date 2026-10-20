"""Synthetic-only tests: no historical prices, features, predictions or fits."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import tempfile
import unittest
import warnings
import sys
import numpy as np
spec=importlib.util.spec_from_file_location('FQ',Path(__file__).with_name('audit_shallow_feature_quality.py'))
Q=importlib.util.module_from_spec(spec);spec.loader.exec_module(Q)


def synthetic_series(n=1000):
    close=np.exp(np.arange(n)*.001);hi=close*1.01;lo=close*.99
    close[4]=np.nan;close[6]=0.;close[8]=np.inf;hi[14:45]=np.nan;lo[14:45]=np.nan
    return SimpleNamespace(close=close,high=hi,low=lo,start_i=0,base_ts=0)


def evaluate(ser,volume,har):
    with patch.object(Q.NN.R12,'load_series',return_value=(ser,None,None)),patch.object(Q.NN.D,'load_volume',return_value=volume),patch.object(Q.NN.A6,'har_of',return_value=har):
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',RuntimeWarning);return Q.captured_series({'key':'synthetic'})


def batch_inputs(n):
    f={k:np.zeros(n,np.float64) for k in Q.NN.STATIC};f['lsH'][:]=np.log(.2)
    return f

def replay_fixture(epochs):
    keys=[]
    for group in range(4):
        key=next('synthetic-'+str(i) for i in range(10000) if Q.I.groups(['synthetic-'+str(i)],np.array([0]))[0]==group)
        keys.append(key)
    sid=np.repeat(np.arange(4,dtype=np.int32),9);ts=np.tile(np.arange(-4,5,dtype=np.int64)*86400,4)
    R=dict(sid=sid,ts=ts,T=np.ones(len(ts),np.int32),Tidx=np.zeros(len(ts),np.int32))
    g=Q.I.groups(keys,sid);split=Q.I.split_time(ts);rng=np.random.default_rng(20261903);receipts=[];meta=[];caps={m:2 for m in Q.I.MODELS}
    for sh in (0,1):
        for tt in (0,1):
            test=np.flatnonzero((g%2==sh)&((ts>=split) if tt else (ts<split))&(ts%86400==0))
            eligible=np.flatnonzero((g%2!=sh)&((ts+43200<=split) if tt else (ts>=split+43200)))
            val=eligible[g[eligible]==g[eligible].min()];train=eligible[g[eligible]!=g[eligible].min()]
            if len(train)>3:train=rng.choice(train,3,replace=False)
            if len(val)>3:val=rng.choice(val,3,replace=False)
            for m in Q.I.MODELS:
                chosen=train[:2];ordinal=len(receipts)
                fit=dict(cell=[sh,tt],model=m,train=len(chosen),val=len(val),test=len(test),epochs=epochs[ordinal],val_bce=.5)
                members={k:Q.I.membership(ix,R,g) for k,ix in dict(tr_all=eligible,tr_full=train,tr=chosen,va=val,te=test).items()}
                receipts.append(dict(ordinal=ordinal,cell=[sh,tt],model=m,original_fit=fit,tsplit_float=split,membership=members));meta.append(fit)
                for _ in range(epochs[ordinal]):rng.permutation(chosen)
    return R,keys,receipts,meta,caps

class QualityTests(unittest.TestCase):
    def test_zero_nan_inf_and_boundaries_are_distinct(self):
        v=np.array([[0.,np.nan,np.inf,-11.,-10.,10.,11.]])
        c=Q.counter(v,low=-10,high=10)
        self.assertEqual(c['invalid'],2);self.assertEqual(c['strictly_clipped_low'],1);self.assertEqual(c['strictly_clipped_high'],2)
        self.assertEqual(c['equal_low_boundary'],1);self.assertEqual(c['equal_high_boundary'],1);self.assertEqual(c['rows_affected'],1)
        self.assertEqual(Q.counter(np.zeros((2,3)))['invalid'],0)
    def test_series_original_bitwise_equivalence_and_volume_cases(self):
        ser=synthetic_series();har=np.ones((1001,3));har[1,2]=0;har[2,2]=np.nan
        for vol in (None,np.ones(999),np.ones(1000),np.r_[np.zeros(750),np.ones(250)]):
            A,raw=evaluate(ser,vol,har)
            self.assertEqual(raw['volume_loader_returned_none'],vol is None)
            self.assertEqual(raw['volume_mismatch'],vol is not None and len(vol)!=1000)
            self.assertEqual(A['r'].dtype,np.float32)
            self.assertTrue(raw['hm_all'][44]);self.assertTrue(raw['volume_ratio'][0]!=raw['volume_ratio'][0])
        A,raw=evaluate(ser,None,har)
        self.assertTrue(raw['vr_all'][24]);self.assertFalse(raw['v_all'][24])
    def test_batch_original_bitwise_equivalence_and_index_boundaries(self):
        ser=synthetic_series();A,raw=evaluate(ser,np.ones(1000),np.ones((1001,3)))
        ts=np.array([0,48*3600,30*24*3600,1002*3600],np.int64);sid=np.full(4,42,np.int32);f=batch_inputs(4);t=np.array([0,1,2,0])
        calc,stage=Q.batch_formula(A,raw,sid,ts,f,t)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',RuntimeWarning);h,d,s=Q.NN.build_batch({42:A},sid,ts,f,t,3)
        Q.exact(dict(H=h,D=d,S=s),calc,'synthetic')
        self.assertEqual(stage['hourly.indices'][1]['fallback'][0].sum(),47)
        self.assertEqual(stage['hourly.indices'][1]['fallback'][1].sum(),0)
        self.assertEqual(stage['daily.indices'][1]['fallback'][0].sum(),29)
        self.assertEqual(stage['daily.indices'][1]['fallback'][2].sum(),0)
        self.assertTrue(stage['hourly.indices'][1]['fallback'][3].any())
    def test_valid_zero_gap_not_fallback_and_invalid_scale(self):
        ser=synthetic_series();A,raw=evaluate(ser,np.ones(1000),np.ones((1001,3)))
        f=batch_inputs(4);f['lsH']=np.array([0.,np.nan,-1000.,-80.]);A['lrv22'][800]=0.;A['lpm'][800]=0.
        sid=np.full(4,17);ts=np.full(4,800*3600);calc,stage=Q.batch_formula(A,raw,sid,ts,f,np.array([0,1,2,0]))
        self.assertFalse(stage['gap22.before_fallback'][1]['fallback'][0]);self.assertEqual(stage['gap22.before_fallback'][0][0],0)
        self.assertTrue(stage['scale.hourly_HAR'][1]['fallback'][1]);self.assertTrue(stage['scale.hourly_HAR'][1]['fallback'][2]);self.assertFalse(stage['scale.hourly_HAR'][1]['fallback'][3])
        self.assertTrue(np.isfinite(calc['H']).all())
    def test_batch_global_sid_order_invariance_and_signed_zero_refusal(self):
        ser=synthetic_series();A,raw=evaluate(ser,np.ones(1000),np.ones((1001,3)))
        ts=np.array([700,900,800])*3600;f=batch_inputs(3);sid=np.full(3,231);tidx=np.array([0,2,1]);whole,_=Q.batch_formula(A,raw,sid,ts,f,tidx)
        order=np.array([2,0,1]);perm,_=Q.batch_formula(A,raw,sid[order],ts[order],{k:v[order] for k,v in f.items()},tidx[order])
        Q.exact({k:v[order] for k,v in whole.items()},perm,'permutation')
        parts=[Q.batch_formula(A,raw,sid[i:i+1],ts[i:i+1],{k:v[i:i+1] for k,v in f.items()},tidx[i:i+1])[0] for i in range(3)]
        Q.exact(whole,{k:np.concatenate([p[k] for p in parts]) for k in whole},'batch')
        with self.assertRaises(ValueError):Q.exact({'x':np.array([0.])},{'x':np.array([-0.])},'signedzero')
    def test_strict_clip_counter_uses_prefill_masks_not_zero(self):
        values=np.array([[0.,-5.,5.,-5.01,5.01]])
        c=Q.counter(values,invalid=np.array([[False,False,False,True,False]]),fallback=np.array([[False,False,False,True,False]]),low=-5,high=5)
        self.assertEqual(c['invalid'],1);self.assertEqual(c['fallback'],1);self.assertEqual(c['strictly_clipped_low'],1);self.assertEqual(c['strictly_clipped_high'],1)
    def test_raw_source_pin_mutation_and_guard_extra_access_torch(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'raw';p.write_text('safe');record=Q.pin(p);Q.check_pin(record);p.write_text('mutated')
            with self.assertRaises(ValueError):Q.check_pin(record)
            hook,state,reads=Q.access_guard(t,[p]);hook('open',(str(p),'r',0));self.assertEqual(reads[str(p.resolve())],1)
            for event,args in [('open',(str(Path(t)/'other'),'r',0)),('open',(str(p),'w',1)),('import',('torch',None)),('socket.connect',())]:
                with self.assertRaises(PermissionError):hook(event,args)
            self.assertEqual(len(state['violations']),4)
        with patch.dict(sys.modules,{'torch':SimpleNamespace()}):
            with self.assertRaises(ValueError):Q.no_torch()
    def test_static_prefill_nonfinite_and_saturation_original_equivalence(self):
        ser=synthetic_series();A,raw=evaluate(ser,np.ones(1000),np.ones((1001,3)))
        f=batch_inputs(5);f['lsf']=np.array([0.,np.nan,np.inf,-20.,20.]);f['r24']=np.array([-20.01,-20.,0.,20.,20.01])
        sid=np.full(5,123);ts=np.full(5,800*3600);tidx=np.array([0,1,2,0,1])
        calculated,stage=Q.batch_formula(A,raw,sid,ts,f,tidx)
        h,d,s=Q.NN.build_batch({123:A},sid,ts,f,tidx,3);Q.exact(dict(H=h,D=d,S=s),calculated,'static')
        values,kwargs=stage['static.lsf'];counts=Q.counter(values,**kwargs)
        self.assertEqual(counts['invalid'],2);self.assertEqual(counts['fallback'],2);self.assertEqual(counts['strictly_clipped_high'],1)
        values,kwargs=stage['static.r24'];counts=Q.counter(values,**kwargs)
        self.assertEqual(counts['strictly_clipped_low'],1);self.assertEqual(counts['strictly_clipped_high'],1)
        self.assertEqual(counts['equal_low_boundary'],1);self.assertEqual(counts['equal_high_boundary'],1)
    def test_shared_rng_epoch_replay_and_membership_tamper(self):
        R,keys,receipts,meta,caps=replay_fixture([4]*20)
        roles,split=Q.roles_replay(R,keys,receipts,meta,max_train=3,caps=caps)
        self.assertEqual(len(roles),60);self.assertEqual(split,0.)
        R2,keys2,receipts2,meta2,caps2=replay_fixture([2]+[4]*19)
        changed,_=Q.roles_replay(R2,keys2,receipts2,meta2,max_train=3,caps=caps2)
        # Shared permutations between models affect later cell sampling, not just epoch metadata.
        self.assertTrue(any(not np.array_equal(a['indices'],b['indices']) for a,b in zip(roles[15:],changed[15:])))
        receipts[0]['membership']['tr']['count']+=1
        with self.assertRaises(ValueError):Q.roles_replay(R,keys,receipts,meta,max_train=3,caps=caps)
    def test_global_body_guard_integrity_only_does_not_enable_prediction_load(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t).resolve();raw=root/'raw';raw.mkdir();inside=raw/'approved.json';inside.write_text('{}')
            outside=root/'outside.json';outside.write_text('{}');prediction=root/'rows-nn-T1.npz'
            np.savez(prediction,p=np.array([.5],np.float32));predpin=Q.pin(prediction)
            payload=root/'dev-r162-nn.json';payload.write_text('{}');out=root/'fresh.json'
            hook,state,reads=Q.access_guard(raw,[inside],metadata=[prediction,payload],integrity_pins=[predpin],output=out)
            Q.ACTIVE_GUARD=state;sys.addaudithook(hook)
            try:
                self.assertEqual(inside.read_text(),'{}')
                for p in (outside,prediction,payload):
                    with self.assertRaises(PermissionError):p.read_bytes()
                Q.check_pin(predpin)  # Exact admitted streamed hash, no NPZ/JSON parsing.
                self.assertIsNone(state['hash_only_target'])
                with self.assertRaises(PermissionError):np.load(prediction,allow_pickle=False)
                with self.assertRaises(ValueError):Q.check_pin(Q.pin(inside))
                with self.assertRaises(PermissionError):outside.write_text('changed')
                with open(out,'xb') as f:f.write(b'{}')
                with self.assertRaises(PermissionError):out.write_text('overwrite')
                self.assertTrue(state['violations'])
            finally:state['active']=False;Q.ACTIVE_GUARD=None
            self.assertEqual(out.read_text(),'{}')
    def test_runtime_whitelist_is_code_only_and_exact_metadata_allowed(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t).resolve();runtime=root/'runtime';runtime.mkdir();raw=root/'raw';raw.mkdir()
            code=runtime/'library.py';code.write_text('# code');data=runtime/'extra.json';data.write_text('{}')
            hook,state,reads=Q.access_guard(raw,[],runtime_roots=[runtime])
            hook('open',(str(code),'r',0))
            with self.assertRaises(PermissionError):hook('open',(str(data),'r',0))
            with self.assertRaises(PermissionError):hook('open',(42,'r',0))
            with self.assertRaises(PermissionError):hook('os.rename',(str(code),str(data),-1,-1))
    def test_short_history_and_batch_limit(self):
        out,all_bad,un=Q.roll_raw(np.array([np.nan]*24),24,np.nanmean)
        self.assertTrue(np.isnan(out).all());self.assertTrue(un.all());self.assertFalse(all_bad.any())
        with self.assertRaises(ValueError):Q.batch_formula({}, {},np.zeros(1025),np.zeros(1025),{},np.zeros(1025,int))

if __name__=='__main__':unittest.main()
