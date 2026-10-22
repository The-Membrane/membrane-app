import importlib.util
from pathlib import Path
import unittest
import numpy as np
S=importlib.util.spec_from_file_location('weighted',Path(__file__).with_name('q26-weighted-causal-primary-pair.py'))
M=importlib.util.module_from_spec(S);S.loader.exec_module(M)


def fixture():
    # 7 calendar blocks, five SGs, unequal row multiplicities and nontrivial p/y.
    rows=[]
    for b in range(7):
        for g in range(5):
            for j in range(8):
                for rep in range(1+j%3):
                    rows.append((.1 if b==0 else .01+.05*j, int((b+g+j+rep)%4==0),g,M.ORIGIN+182*b+10+j))
    a=np.array(rows)
    return dict(p=a[:,0],y=a[:,1],sg=a[:,2].astype(int),day=a[:,3].astype(int))


class Tests(unittest.TestCase):
    def test_original_weighted_quantile_formula(self):
        x=np.array([9.,1.,3.]);w=np.array([90.,1.,9.]);q=np.array([.05,.95])
        o=np.argsort(x)
        np.testing.assert_array_equal(M.wquant(x,w,q),np.interp(q,np.cumsum(w[o])/sum(w),x[o]))
        self.assertFalse(np.array_equal(M.wquant(x,w,q),np.quantile(x,q)))

    def test_both_cells_and_no_mutation(self):
        d=fixture();before={k:v.copy() for k,v in d.items()}
        out=M.primary_pair({k:d for k in M.CELLS})
        self.assertEqual([r['cell'][:2] for r in out],[[24,5],[72,7]])
        for k in d:np.testing.assert_array_equal(d[k],before[k])
        for r in out:
            self.assertEqual(r['native_rows'],len(d['p']))
            self.assertGreater(r['views'][0]['arms']['F']['groups'],0)
            self.assertTrue(all(f['max_past_label_day']<f['block_start_day'] for f in r['folds'] if f['clock_target']))

    def test_horizon_clock_boundary(self):
        d=fixture();d['day']=d['day'].copy()
        # Put first-block rows exactly two days before next block: H24 eligible, H72 not.
        d['day'][d['day']<M.ORIGIN+182]=M.ORIGIN+180
        a=M.cell(**d,horizon=24,level_index=5);b=M.cell(**d,horizon=72,level_index=7)
        fa=next(f for f in a['folds'] if f['block']==1 and f['sg']==0)
        fb=next(f for f in b['folds'] if f['block']==1 and f['sg']==0)
        self.assertGreater(fa['past_rows'],fb['past_rows'])
        self.assertFalse(fb['clock_target'])

    def test_future_labels_cannot_change_forward_fit(self):
        d=fixture();a=M.cell(**d,horizon=24,level_index=5)
        d['y']=d['y'].copy();d['y'][d['day']>=M.ORIGIN+3*182]=1-d['y'][d['day']>=M.ORIGIN+3*182]
        b=M.cell(**d,horizon=24,level_index=5)
        for x,z in zip(a['folds'],b['folds']):
            if x['block']<=3:self.assertEqual(x['arms']['F'],z['arms']['F'])
        np.testing.assert_array_equal(a['private_arrays']['arm_eligible']['F'],b['private_arrays']['arm_eligible']['F'])

    def test_unavailable_folds_do_not_suppress_other_scores(self):
        d=fixture();r=M.cell(**d,horizon=24,level_index=5)
        self.assertFalse(r['full_clock_target_available']['F'])
        self.assertIsNotNone(r['views'][0]['arms']['F']['coverage'])
        self.assertGreater(r['views'][0]['arms']['F']['unavailable_rows'],0)
        self.assertGreater(r['views'][0]['pairs']['Rclock']['excluded_clock_rows'],0)
        self.assertIn('predeclared',r['views'][0]['pairs']['Rclock']['support_label'])
        fold_views=[v for v in r['views'] if '/' in v['view']]
        self.assertEqual(len(fold_views),len(r['folds']))
        self.assertEqual(sum(v['arms']['F']['native_rows'] for v in fold_views),r['native_rows'])
        pair=r['views'][0]['pairs']['Rclock']
        self.assertEqual(pair['coverage_delta'],pair['F']['coverage']-pair['reference']['coverage'])
        self.assertEqual(pair['row_median_width_delta_pp'],pair['F']['row_median_width_pp']-pair['reference']['row_median_width_pp'])

    def test_pair_support_is_whole_fold_and_declared_before_labels(self):
        d=fixture();r=M.cell(**d,horizon=24,level_index=5)
        a=r['private_arrays'];selected=a['clock_target']&a['arm_eligible']['F']&a['arm_eligible']['Rclock']
        for g,b in np.unique(np.column_stack((a['sg'],a['block'])),axis=0):
            m=(a['sg']==g)&(a['block']==b)
            self.assertIn(int(selected[m].sum()),(0,int(m.sum())))
        pair=r['views'][0]['pairs']['Rclock']
        self.assertEqual(pair['comparable_rows'],int(selected.sum()))
        self.assertEqual(pair['completeness'],'PARTIAL_OR_EMPTY_CLOCK_TARGET')
        d['y']=1-d['y'];t=M.cell(**d,horizon=24,level_index=5)
        np.testing.assert_array_equal(a['arm_eligible']['F'],t['private_arrays']['arm_eligible']['F'])
        # Declaration remains separate even if supplied bounds are unexpectedly absent.
        n=len(d['p']);metric=M._metric(d['p'],d['y'],a['sg'],a['block'],a['past_bins'],
            np.full(n,np.nan),np.full(n,np.nan),np.ones(n,bool),a['arm_eligible']['F'])
        self.assertGreater(metric['eligible_rows'],0)
        self.assertEqual(metric['evaluated_rows'],0)

    def test_zero_predictions_preserve_all_rows(self):
        d=fixture();d['p']=np.zeros_like(d['p']);r=M.cell(**d,horizon=24,level_index=5)
        self.assertEqual(r['native_rows'],len(d['p']))
        self.assertIsNone(r['views'][0]['arms']['F']['coverage'])
        self.assertTrue(np.isnan(r['private_arrays']['bounds']['F'][0]).all())

    def test_invalid_schema(self):
        d=fixture()
        with self.assertRaises(ValueError):M.primary_pair({(24,5):d})
        d['p'][0]=np.nan
        with self.assertRaises(ValueError):M.cell(**d,horizon=24,level_index=5)
        with self.assertRaises(ValueError):M.cell(**fixture(),horizon=24,level_index=4)

    def test_score_hand_calculation(self):
        p=np.array([.2,.2]);y=np.array([0.,1.]);g=np.array([0,0]);b=np.array([1,1]);bins=np.array([0,0]);mask=np.ones(2,bool)
        r=M._metric(p,y,g,b,bins,np.array([.1,.1]),np.array([.3,.3]),mask)
        self.assertAlmostEqual(r['interval_score_pp'],420.)
        self.assertAlmostEqual(r['row_median_width_pp'],20.)
        self.assertEqual((r['below'],r['above']),(0,1))

if __name__=='__main__':unittest.main()
