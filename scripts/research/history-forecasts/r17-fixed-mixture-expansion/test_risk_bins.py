import math
import unittest
import numpy as np
import risk_bins as R

class RiskBins(unittest.TestCase):
    def rows(self):
        A=np.array([0.,.01,.02,.05,.1,.2,.4,.6,.8,1.],np.float64)
        return (np.arange(10,dtype=np.int32),np.array([1704067200]*5+[1735689600]*5,np.int64),A,np.array([.1,.02,.04,.06,.2,.1,.3,.5,.9,.99]),np.array([1,0,1,0,1,0,1,0,1,255],np.uint8),np.array([1]*9+[0],bool))
    def analyze(self,rows=None):return R.analyze(*(self.rows() if rows is None else rows),status=R.READY)
    def test_boundaries_partition_overlap(self):
        v=self.analyze()['views']['pooled'];self.assertEqual([x['J_n'] for x in v['bins']],[1]*8+[2]);self.assertEqual(v['A_exact_zero_overlapping_control']['J_n'],1)
        self.assertEqual(sum(x['J_n']for x in v['bins']),10);self.assertEqual(v['bins'][-1]['unknown_n'],1)
    def test_same_A_membership_not_C(self):
        rows=list(self.rows());rows[3]=1-rows[2];v=self.analyze(rows)['views']['pooled'];self.assertEqual([x['J_n']for x in v['bins']],[1]*8+[2]);self.assertEqual(v['bins'][0]['observed']['sumC'],1.)
    def test_scalar_oracle_and_typed_labels(self):
        sid,ts,A,C,y,k=self.rows();v=self.analyze()['views']['pooled']
        for label in(0,1):
            B=[];L=[]
            for a,c,yy,valid in zip(A,C,y,k):
                z=int(yy)if valid else label;a1=min(max(float(a),1e-6),1-1e-6);c1=min(max(float(c),1e-6),1-1e-6)
                B.append((c-z)**2-(a-z)**2);L.append((-z*math.log(c1)-(1-z)*math.log1p(-c1))-(-z*math.log(a1)-(1-z)*math.log1p(-a1)))
            got=v['total']['unknown_completions'][str(label)]['paired']['sum']
            self.assertAlmostEqual(got[0],math.fsum(B),places=14);self.assertAlmostEqual(got[1],math.fsum(L),places=13)
    def test_contributions_and_bias(self):
        v=self.analyze()['views']['pooled'];total=v['total'];n=total['known_n']
        for j in(0,1):
            self.assertAlmostEqual(sum(x['observed']['paired']['global_calendar_contribution'][j]for x in v['bins']),total['observed']['paired']['mean'][j],places=14)
            self.assertAlmostEqual(total['observed']['event_paired']['sum'][j]+total['observed']['non_event_paired']['sum'][j],total['observed']['paired']['sum'][j],places=14)
        self.assertEqual(total['observed']['meanY_minus_meanA'],(total['observed']['sumY']-total['observed']['sumA'])/n)
    def test_bias_change_scalar_and_empty(self):
        v=self.analyze()['views']['pooled'];o=v['bins'][0]['observed']
        # The A=0,C=.1,Y=1 case has signed biases1,.9 and absolute bias reduction.1.
        self.assertAlmostEqual(o['C_minus_A_signed_bias_change'],-.1)
        self.assertAlmostEqual(o['C_minus_A_absolute_bias_change'],-.1)
        rows=list(self.rows());rows[2]=np.full(10,.2);rows[3]=np.full(10,.8);rows[4]=np.zeros(10,np.uint8);rows[-1]=np.ones(10,bool)
        o=self.analyze(rows)['views']['pooled']['total']['observed']
        self.assertAlmostEqual(o['C_minus_A_signed_bias_change'],-.6)
        self.assertAlmostEqual(o['C_minus_A_absolute_bias_change'],.6)
        e=self.analyze(tuple(x[:1]for x in self.rows()))['views']['2025']['total']['observed']
        self.assertIsNone(e['C_minus_A_signed_bias_change']);self.assertIsNone(e['C_minus_A_absolute_bias_change'])
    def test_unknown_placeholder_irrelevant(self):
        rows=list(self.rows());before=self.analyze(rows);rows[4]=rows[4].copy();rows[4][-1]=0;self.assertEqual(before,self.analyze(rows))
    def test_empty_cells_and_year(self):
        rows=tuple(v[:1]for v in self.rows());v=self.analyze(rows)['views']['2025'];self.assertIsNone(v['total']['observed']['paired']['mean']);self.assertTrue(all(x['J_n']==0 for x in v['bins']))
    def test_immutable_and_permutation(self):
        rows=self.rows();copies=[x.tobytes()for x in rows];a=self.analyze(rows);b=self.analyze(tuple(x[::-1].copy()for x in rows));self.assertEqual(a,b);self.assertEqual(copies,[x.tobytes()for x in rows])
    def test_invalid_and_DRAFT(self):
        with self.assertRaisesRegex(ValueError,'DRAFT'):R.analyze(*self.rows())
        with self.assertRaisesRegex(ValueError,'DRAFT'):R.read_saved_rows(None,None,None)
        for index,value in[(2,np.nan),(3,1.01)]:
            rows=list(self.rows());rows[index]=rows[index].copy();rows[index][0]=value
            with self.assertRaises(ValueError):self.analyze(rows)
        rows=list(self.rows());rows[4]=rows[4].astype(float)
        with self.assertRaisesRegex(ValueError,'typed'):self.analyze(rows)
    def test_multiple_unknown_refused(self):
        rows=list(self.rows());rows[-1]=rows[-1].copy();rows[-1][0]=False
        with self.assertRaisesRegex(ValueError,'at most one'):self.analyze(rows)
    def test_accepted_reconciliation_and_tamper(self):
        report=self.analyze();component={'views':[]};precision={'views':{}}
        for name,v in report['views'].items():
            t=v['total'];paired={}
            for j,loss in enumerate(('brier','bounded_logloss')):
                values=[t['unknown_completions'][k]['paired']['mean'][j]for k in('0','1')]
                paired[loss+'_delta']=[0.,0.,t['observed']['paired']['mean'][j]]
                paired.setdefault('all_common_issued_bounds',{})[loss]={'lower':[0.,0.,min(values)],'upper':[0.,0.,max(values)]}
            component['views'].append({'view_type':'calendar','view':name,'forecast_J_n':t['J_n'],'scored_L24_n':t['known_n'],'paired':{'C_conditional_minus_A_raw_fH':paired}})
            precision['views'][name]={'J_n':t['J_n'],'known_n':t['known_n'],'observed_delta':t['observed']['paired']['mean']}
        self.assertTrue(R.reconcile(report,component,precision))
        with self.assertRaisesRegex(ValueError,'exact report calendar'):R.reconcile({'views':{}},component)
        with self.assertRaisesRegex(ValueError,'exact accepted calendar'):R.reconcile(report,{'views':component['views'][:-1]})
        with self.assertRaisesRegex(ValueError,'exact accepted calendar'):R.reconcile(report,{'views':component['views']+[component['views'][0]]})
        with self.assertRaisesRegex(ValueError,'exact precision calendar'):R.reconcile(report,component,{'views':{}})
        component['views'][0]['paired']['C_conditional_minus_A_raw_fH']['brier_delta'][2]+=1e-6
        with self.assertRaisesRegex(ValueError,'accepted observed'):R.reconcile(report,component,precision)
    def test_duplicate_key_refused(self):
        rows=list(self.rows());rows[0]=rows[0].copy();rows[0][1]=0
        with self.assertRaisesRegex(ValueError,'unique'):self.analyze(rows)

if __name__=='__main__':unittest.main()
