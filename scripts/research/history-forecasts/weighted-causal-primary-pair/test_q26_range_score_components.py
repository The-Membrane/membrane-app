import importlib.util
from pathlib import Path
import copy
import unittest
import numpy as np

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

M=load('components',Path(__file__).with_name('q26-range-score-components.py'))
K=load('qualified_metric',Path(__file__).with_name('q26-weighted-causal-primary-pair.py'))


def saved():
    n=4;sg=np.array([0,0,1,1],dtype='int64');block=np.array([0,0,2,2],dtype='int64')
    a=dict(p=np.full(n,.2),y=np.array([0.,1.,0.,0.]),sg=sg,block=block,
        day=17532+182*block+10,past_bins=np.zeros(n,dtype='int64'),original_bins=np.zeros(n,dtype='int64'),
        clock_target=np.ones(n,bool),series=sg.astype('int16'),cluster=sg.astype('int16'),row_index=np.arange(n,dtype='int64'))
    for arm in M.ARMS:
        a[arm+'_eligible']=np.ones(n,bool)
        a[arm+'_lower']=np.array([.1,.1,.25,.25]);a[arm+'_upper']=np.array([.3,.3,.75,.75])
    return a


def accepted(a):
    n=len(a['y']);sg=a['sg'];block=a['block'];bins=a['past_bins']
    scopes=[('all',np.ones(n,bool))]+[(f'SG{g}',sg==g) for g in range(5)]+[(f'block{int(b)}',block==b) for b in np.unique(block)]
    scopes += [(f'SG{int(g)}/block{int(b)}',(sg==g)&(block==b)) for g,b in np.unique(np.column_stack((sg,block)),axis=0)]
    def metric(arm,scope,b=bins,declared=True):return K._metric(a['p'],a['y'],sg,block,b,a[arm+'_lower'],a[arm+'_upper'],scope,a[arm+'_eligible'] if declared else None)
    views=[]
    for name,scope in scopes:
        pairs={}
        for ref in ('Rclock','Roriginal'):
            s=scope&a['clock_target']&a['F_eligible']&a[ref+'_eligible'];f=metric('F',s);r=metric(ref,s)
            pairs[ref]=dict(native_rows=int(scope.sum()),prespecified_clock_rows=int((scope&a['clock_target']).sum()),comparable_rows=int(s.sum()),excluded_clock_rows=int((scope&a['clock_target']&~s).sum()),F=f,reference=r,interval_score_delta_pp=None if not f['groups'] else f['interval_score_pp']-r['interval_score_pp'])
        views.append(dict(view=name,arms={arm:metric(arm,scope) for arm in M.ARMS},pairs=pairs))
    return dict(schema='q26-weighted-causal-primary-cell-v1',cell=[24,5,'alts'],native_rows=n,clock_target_rows=int(a['clock_target'].sum()),views=views,original_reference_native=metric('Roriginal',np.ones(n,bool),a['original_bins']))


class Tests(unittest.TestCase):
    def test_hand_width_lower_upper_and_rowmedian(self):
        a=saved();r=M.components(np,a['y'],a['sg'],a['block'],a['past_bins'],a['F_lower'],a['F_upper'],np.ones(4,bool))
        self.assertAlmostEqual(r['width_component_pp'],35.)
        self.assertAlmostEqual(r['lower_miss_component_pp'],250.)
        self.assertAlmostEqual(r['upper_miss_component_pp'],200.)
        self.assertAlmostEqual(r['component_sum_pp'],485.)
        self.assertEqual((r['below'],r['above'],r['coverage']),(1,1,0.))

    def test_all_views_pairs_and_native_reference(self):
        a=saved();old=accepted(a);r=M.decompose_cell(np,a,old,expected_views=len(old['views']))
        self.assertEqual(len(r['views']),10)
        self.assertEqual(r['views'][0]['pairs']['Rclock']['component_delta_sum_pp'],0.)
        self.assertIsNone(next(v for v in r['views'] if v['view']=='SG4')['arms']['F']['component_sum_pp'])
        self.assertAlmostEqual(r['original_reference_native']['component_sum_pp'],485.)

    def test_equal_group_not_row_weighting(self):
        a=saved();idx=np.array([0,1,2,3,2,3,2,3])
        r=M.components(np,*(a[k][idx] for k in ('y','sg','block','past_bins','F_lower','F_upper')),np.ones(len(idx),bool))
        self.assertAlmostEqual(r['component_sum_pp'],485.)
        self.assertAlmostEqual(r['row_median_width_pp'],50.)

    def test_partial_whole_fold_retained_and_no_endpoint_intersection(self):
        a=saved();m=a['sg']==0;a['clock_target'][m]=False;a['past_bins'][m]=-1
        for arm in ('F','Rclock'):
            a[arm+'_eligible'][m]=False;a[arm+'_lower'][m]=np.nan;a[arm+'_upper'][m]=np.nan
        old=accepted(a);r=M.decompose_cell(np,a,old,expected_views=10)
        self.assertEqual(r['views'][0]['arms']['F']['native_rows'],4)
        self.assertEqual(r['views'][0]['arms']['F']['evaluated_rows'],2)
        self.assertEqual(r['original_reference_native']['evaluated_rows'],4)
        a['F_lower'][2]=np.nan
        with self.assertRaises(ValueError):M.decompose_cell(np,a,old,expected_views=10)

    def test_small_miss_covered_but_penalty_not_zero(self):
        y=np.array([0.]);g=np.array([0]);b=np.array([0]);lo=np.array([5e-13]);hi=np.array([.1])
        r=M.components(np,y,g,b,b,lo,hi,np.ones(1,bool))
        self.assertEqual(r['coverage'],1.);self.assertGreater(r['lower_miss_component_pp'],0.)

    def test_schema_support_and_report_tamper(self):
        a=saved();old=accepted(a);bad=copy.deepcopy(old);bad['views'][0]['arms']['F']['interval_score_pp']+=.001
        with self.assertRaises(ValueError):M.decompose_cell(np,a,bad,expected_views=10)
        tiny=copy.deepcopy(old);score=tiny['views'][0]['arms']['F']['interval_score_pp']
        tiny['views'][0]['arms']['F']['interval_score_pp']=float(np.nextafter(score,np.inf))
        with self.assertRaisesRegex(ValueError,'unchanged original interval-score drift'):
            M.decompose_cell(np,a,tiny,expected_views=10)
        a['F_eligible'][0]=False;a['F_lower'][0]=a['F_upper'][0]=np.nan
        with self.assertRaises(ValueError):M.decompose_cell(np,a,old,expected_views=10)
        a=saved();a['row_index']=a['row_index'].astype('int32')
        with self.assertRaises(ValueError):M.decompose_cell(np,a,old,expected_views=10)

    def test_opposing_component_deltas_cancel(self):
        a=saved()
        # At ybar0, (lo,hi)=(0,.5) and(.01,.31) have equal IS=.5.
        a['y'][:]=0
        a['F_lower'][:]=0;a['F_upper'][:]=.5
        a['Rclock_lower'][:]=.01;a['Rclock_upper'][:]=.31
        old=accepted(a);r=M.decompose_cell(np,a,old,expected_views=10)
        d=r['views'][0]['pairs']['Rclock']
        self.assertGreater(d['component_deltas_pp']['width_component_pp'],0)
        self.assertLess(d['component_deltas_pp']['lower_miss_component_pp'],0)
        self.assertAlmostEqual(d['component_delta_sum_pp'],0.)

if __name__=='__main__':unittest.main()
