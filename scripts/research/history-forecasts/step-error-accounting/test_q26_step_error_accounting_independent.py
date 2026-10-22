"""Independent semantic counterexamples; synthetic records only, no bootstrap."""
import importlib.util
from pathlib import Path
import math
import unittest

s=importlib.util.spec_from_file_location('independent_accounting',Path(__file__).with_name('q26-step-error-accounting-check.py'))
C=importlib.util.module_from_spec(s);s.loader.exec_module(C)


def row(y,p=.5,**changes):
    r=dict(series='toy',cluster='toy',i0=0,T=24,k=0,block182=0,y=y,
        p_fH=p,p_rec12=p,p_base12=p,p_garch=p,p_h3=p)
    r.update(changes);return r


class IndependentTests(unittest.TestCase):
    def test_event_and_nonevent_accounting_use_total_denominator(self):
        rows=[row(1.,p_garch=0.)]+[row(0.,p_garch=.25) for _ in range(3)]
        a=C.metrics(rows,C.BASE)['models']['garch']
        self.assertEqual(a['event_loss_contribution'],.25)
        self.assertEqual(a['non_event_loss_contribution'],3*.0625/4)
        self.assertEqual(a['event_mean_loss'],1.)
        self.assertEqual(a['non_event_mean_loss'],.0625)
        self.assertEqual(a['Brier'],.296875)

    def test_exact_wrong_certainty_not_near_endpoint(self):
        rows=[row(1.,p_garch=0.),row(1.,p_garch=1e-15),row(0.,p_garch=1.),row(0.,p_garch=1-1e-15),row(0.,p_garch=0.),row(1.,p_garch=1.)]
        r=C.metrics(rows,C.BASE)['models']['garch']
        self.assertEqual((r['p0_count'],r['p1_count']),(2,2))
        self.assertEqual((r['wrong_p0_events'],r['wrong_p1_non_events']),(1,1))

    def test_four_common_is_not_five_common(self):
        rows=[row(1.,p_h3=None),row(0.),row(1.,p_garch=None),row(None,p_h3=None)]
        four,why4=C.choose(rows,False);five,why5=C.choose(rows,True)
        self.assertEqual(four,{0,1});self.assertEqual(five,{1})
        self.assertEqual(why5[0],'missing_h3')
        self.assertEqual(why5[2],'missing_garch')
        self.assertEqual(why5[3],'invalid_outcome')
        self.assertNotIn(0,why4)

    def test_missing_precedes_invalid_and_h3_cannot_override_base(self):
        rows=[row(0.,p_garch=None,p_fH=2.,p_h3=None),row(1.,p_fH=-.1,p_h3=None),row(0.,p_h3=math.inf)]
        good,reasons=C.choose(rows,True)
        self.assertEqual(good,set())
        self.assertEqual(reasons,{0:'missing_garch',1:'invalid_prediction',2:'invalid_h3'})
        self.assertFalse(C.finite_probability(True))
        self.assertFalse(C.finite_probability(10**400))

    def test_empty_events_and_zero_brier_denominator(self):
        a=C.metrics([row(0.,p=0.)],C.BASE)
        self.assertIsNone(a['models']['fH']['event_mean_loss'])
        self.assertIsNone(a['models']['garch']['R'])
        self.assertIsNone(a['models']['garch']['BSS_vs_fH'])
        e=C.metrics([],C.BASE)
        self.assertEqual(e['n_rows'],0);self.assertIsNone(e['models']['garch'])

    def test_event_benefit_can_be_cancelled_by_nonevent_harm(self):
        rows=[row(1.,p_fH=0.,p_garch=1.),row(0.,p_fH=0.,p_garch=1.)]
        good,_=C.choose(rows,False)
        v=C.value_view(rows,[0,1],good,{},C.PRIORITY[:4])
        delta=v['pair_deltas']['garch_minus_fH']
        self.assertEqual(delta,dict(brier=0.,event_contribution=-.5,non_event_contribution=.5))
        self.assertEqual(v['events']+v['non_events'],v['common_rows'])

    def test_complete_public_accounting_and_source_summary_corruptions(self):
        import copy,types
        path=Path(__file__).with_name('test_q26_step_error_accounting.py')
        F=types.ModuleType('invented_accounting_fixture');F.__file__=str(path)
        exec(compile(path.read_bytes(),str(path),'exec'),vars(F))
        I,S=F.fixture();public=F.M.analyze(I,S)
        proof=C.check(I,S,public)
        self.assertTrue(proof['accepted']);self.assertEqual(proof['historical_band_summaries_checked'],36)
        bad=copy.deepcopy(public);bad['supports'][0]['views'][0]['native_availability']['garch']['valid']+=1
        with self.assertRaises(ValueError):C.check(I,S,bad)
        bad=copy.deepcopy(public);bad['supports'][0]['views'].pop()
        with self.assertRaises(ValueError):C.check(I,S,bad)
        old=copy.deepcopy(S);old['summaries'][0]['models']['garch']['Brier']+=.001
        with self.assertRaises(ValueError):C.check(I,old,public)
        wrong=copy.deepcopy(I);wrong['config']['prior_signature']='wrong-source'
        with self.assertRaises(ValueError):C.check(wrong,S,public)

    def test_exact_schema_counts_and_float_policy_are_distinct(self):
        with self.assertRaises(ValueError):C.equal({'count':True},{'count':1})
        with self.assertRaises(ValueError):C.equal({'count':2},{'count':1})
        C.equal(1.+5e-13,1.)
        with self.assertRaises(ValueError):C.equal(1.+5e-10,1.)
        with self.assertRaises(ValueError):C.equal(float('nan'),1.)

if __name__=='__main__':unittest.main()
