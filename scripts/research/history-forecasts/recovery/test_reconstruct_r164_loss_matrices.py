"""Synthetic mathematical and full IPC serialization checks; no historical aggregation."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import numpy as np
S=importlib.util.spec_from_file_location('M',Path(__file__).with_name('reconstruct_r164_loss_matrices.py'));M=importlib.util.module_from_spec(S);S.loader.exec_module(M)


def fixture(root,count=130):
    names=list(M.MAJOR)+['alt:'+str(i) for i in range(125)];names=names[:count];files=[];master=[];clusters={}
    for j,name in enumerate(sorted(names,key=lambda n:n.replace(':','-'))):
        T=np.repeat(np.array(M.HORIZONS,np.int16),10);k=np.tile(np.arange(10,dtype=np.int8),4)
        if j==0:T=np.r_[T,[24,24,24]];k=np.r_[k,[0,0,0]].astype(np.int8)
        n=len(k);y=((k.astype(np.int32)+j)%3==0).astype(np.int8);day=(M.ORIGIN+182*(j%3)+(k.astype(np.int32)%2)).astype(np.int32)
        original=np.array([np.clip(.05+.07*k+.007*im+.0003*j,.01,.99) for im in range(7)],np.float32)
        stored=original.astype(np.float16);cid=clusters.setdefault(M.MAJOR.get(name,name),len(clusters))
        # Shared finite intersection must exclude this row from ALL comparisons, not pairwise.
        if j==1:stored[6,0]=np.nan
        a=dict(name=np.array(name),asset=np.array('test'),day=day,T_h=T,k_i=k,y=y,**{'p_'+m:stored[i] for i,m in enumerate(M.MODELS)})
        p=root/(name.replace(':','-')+'.npz');np.savez_compressed(p,**a);files.append(p)
        master.append(dict(T=T,k=k,y=y,day=day,cid=np.full(n,cid),p=original.astype(float),finite=np.isfinite(stored).all(0)))
    allr={field:np.concatenate([r[field] for r in master],axis=1 if field=='p' else 0) for field in master[0]}
    published=dict(models=list(M.MODELS),comparisons=[list(c) for c in M.COMPS],per_T={})
    def ratio(p,y):return float(p.sum()/y.sum()) if y.sum() else None
    for T in M.HORIZONS:
        raw=allr['T']==T;mask=raw&allr['finite'];y=allr['y'][mask];p=allr['p'][:,mask];kk=allr['k'][mask];se=(p-y)**2
        rec=dict(n_rows=int(mask.sum()),n_rows_T=int(raw.sum()),base_rate=float(y.mean()),models={m:dict(brier=float(se[i].mean()),R=ratio(p[i],y)) for i,m in enumerate(M.MODELS)},comparisons={},levels={})
        for ma,mb in M.COMPS:
            i,j=M.MODELS.index(ma),M.MODELS.index(mb);d=se[i]-se[j]
            co=dict(mean_d=float(d.mean()),bss=float(1-se[i].sum()/se[j].sum()),S=len(np.unique(allr['cid'][mask])),B=len(np.unique((allr['day'][mask]-M.ORIGIN)//182)),bands={})
            for band,ks in M.BANDS.items():
                z=np.isin(kk,ks);co['bands'][band]=dict(bss=float(1-se[i,z].sum()/se[j,z].sum()))
            rec['comparisons'][ma+'_vs_'+mb]=co
        for k in range(10):
            z=kk==k;rec['levels'][str(k)]=dict(n=int(z.sum()),base_rate=float(y[z].mean()),**{m:dict(brier=float(se[i,z].mean()),R=ratio(p[i,z],y[z])) for i,m in enumerate(M.MODELS)})
        published['per_T'][M.TNAME[T]]=rec
    return files,published,allr


class MatrixTests(unittest.TestCase):
    def test_float16_midpoint_envelope_contains_float32_preimages(self):
        original=np.array([0,1,.1,.5,.9999,2**-25,2**-24],np.float32);stored=original.astype(np.float16);lo,hi=M.preimage(stored)
        self.assertTrue(np.all(original>=lo));self.assertTrue(np.all(original<=hi));self.assertEqual(lo[0],0);self.assertEqual(hi[1],1)
        zero=np.float16(0);neighbor=np.nextafter(zero,np.float16(np.inf),dtype=np.float16)
        self.assertEqual(hi[0],float(neighbor)/2)
        l,u=M.preimage(original);np.testing.assert_array_equal(l,original.astype(float));np.testing.assert_array_equal(l,u)
        with self.assertRaisesRegex(ValueError,'unsupported'):M.preimage(np.array([.2],np.float64))
    def test_binary_loss_and_ratio_envelopes_and_nulls(self):
        y=np.array([0,1]);l=np.array([.1,.7]);u=np.array([.2,.9]);sl,su=M.loss_bounds(y,l,u)
        np.testing.assert_allclose(sl,[.01,.01]);np.testing.assert_allclose(su,[.04,.09])
        b=M.bss_bounds(1,2,3,4);self.assertAlmostEqual(b['lower'],1-2/3);self.assertAlmostEqual(b['upper'],.75)
        self.assertIsNone(M.bss_bounds(0,0,0,0));self.assertIsNone(M.bss_bounds(0,1,0,2)['lower'])
        checks=[];M.compatible(None,None,'zeroR',checks)
        with self.assertRaises(ValueError):M.compatible(.5,None,'badR',checks)
        M.compatible(.5,M.closed(.5,.5),'roundoff',checks)
        with self.assertRaises(ValueError):M.compatible(.5+1e-10,M.closed(.5,.5),'outside',checks)
    def test_unequal_cells_major_mapping_finite_intersection_and_rounding_reconciliation(self):
        with tempfile.TemporaryDirectory() as t:
            files,published,raw=fixture(Path(t));groups,levels,counts,meta,clusters=M.build(files,expected_main_dtype='<f2')
            self.assertEqual(len(clusters),127);self.assertEqual(len(meta),130);self.assertEqual(clusters['ETH'],next(m['cluster_id'] for m in meta if m['name']=='bspan:ETH'))
            a=groups[24,'all'];arrays=M.arrays_for(a);self.assertEqual(arrays['Md'].shape[0],12);self.assertEqual(arrays['Mn'].dtype,np.int64)
            self.assertEqual(int(arrays['Mn'].sum()),published['per_T']['1d']['n_rows']);self.assertEqual(counts[24]-a['n'],1)
            self.assertGreater(np.unique(arrays['Mn'][arrays['Mn']>0]).size,1)
            self.assertFalse(np.isclose(np.mean((arrays['Md'][0]/np.where(arrays['Mn']>0,arrays['Mn'],np.nan))[arrays['Mn']>0]),arrays['Md'][0].sum()/arrays['Mn'].sum(),rtol=0,atol=1e-10))
            checks,_=M.reconcile(groups,levels,counts,published);self.assertTrue(len(checks)>700)
            self.assertEqual(sum(groups[24,b]['n'] for b in M.BANDS),a['n'])
            published['per_T']['1d']['n_rows']+=1
            with self.assertRaisesRegex(ValueError,'row counts'):M.reconcile(groups,levels,counts,published)
    def test_series_source_count_mismatch_stops_before_io(self):
        with self.assertRaisesRegex(ValueError,'source count'):M.build([Path('/not-a-real-file')])
    def test_complete_child_process_serialization_and_failed_stage_preservation(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);files,published,_=fixture(root);score=root/'score-main.json';score.write_text(json.dumps(published));out=root/'success';request=root/'fixture.json'
            cfg=dict(output=str(out),expected_main_dtype='<f2',artifacts={'score':M.pin(score)},inputs=[M.pin(p) for p in files]+[M.pin(score)])
            request.write_text(json.dumps(cfg));digest=M.sha(request)
            child="import importlib.util,json;from pathlib import Path;s=importlib.util.spec_from_file_location('m',"+repr(str(Path(M.__file__)))+");m=importlib.util.module_from_spec(s);s.loader.exec_module(m);r="+repr(str(request))+";m.authenticate=lambda p,d:(json.loads(Path(p).read_text()),json.loads(Path(p).read_text())['inputs']);m.run(r,"+repr(digest)+")"
            run=subprocess.run([sys.executable,'-c',child],capture_output=True,text=True);self.assertEqual(run.returncode,0,run.stderr)
            receipt=json.loads((out/'reconstruction.json').read_text());self.assertTrue(receipt['complete']);self.assertEqual(len(receipt['groups']),16)
            with np.load(out/'matrices.npz',allow_pickle=False) as z:
                self.assertEqual(len(z.files),96);self.assertEqual(z['T24_G0_Md'].shape[0],12);self.assertEqual(z['T24_G0_Mn'].dtype,np.int64)
            published['per_T']['1d']['comparisons']['rec12_vs_fH']['mean_d']=123.;score.write_text(json.dumps(published));cfg['artifacts']['score']=M.pin(score);cfg['inputs'][-1]=M.pin(score);cfg['output']=str(root/'failed');request.write_text(json.dumps(cfg));digest=M.sha(request)
            child=child[:child.rfind('m.run(')]+"m.run(r,"+repr(digest)+")"
            run=subprocess.run([sys.executable,'-c',child],capture_output=True,text=True);self.assertNotEqual(run.returncode,0)
            receipt=json.loads((root/'failed/reconstruction.json').read_text());self.assertFalse(receipt['complete']);self.assertEqual(receipt['status'],'failed-review-hold');self.assertFalse((root/'failed/matrices.npz').exists())

if __name__=='__main__':unittest.main()
