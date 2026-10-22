"""Invented O12-format reports only. fixture() is shared transport-test input.
No fitted states, research archive, prices, simulation or bootstrap is read/run.
"""
import copy
import itertools
import math
from pathlib import Path
import types
import unittest

PATH=str(Path(__file__).with_name('q26-step-error-accounting.py'))
M=types.ModuleType('q26_step_accounting_subject');M.__file__=PATH
exec(compile(Path(PATH).read_bytes(),PATH,'exec'),vars(M))


def original_summary(rows,h3=False):
    """Tiny independent scalar producer of the original 12-summary schema.
    Bootstrap fields are explicitly absent evidence (null/zero), not simulated.
    """
    summaries=[];models=('garch','fH','rec12','base12')
    for H in (24,72,168,720):
        for band,ks in (('all',range(10)),('mid',range(4,7)),('deep',range(7,10))):
            rr=[r for r in rows if r['T']==H and r['k'] in ks]
            if not rr:continue
            n=len(rr);ys=math.fsum(r['y'] for r in rr)
            def prob(r,a):return r['p_h3'] if h3 and a=='garch' else r['p_'+a]
            losses={a:[(prob(r,a)-r['y'])**2 for r in rr] for a in models}
            base=math.fsum(losses['fH'])/n
            mm={a:dict(Brier=math.fsum(losses[a])/n,
                BSS_vs_fH=1-(math.fsum(losses[a])/n)/base if base else None,
                R=math.fsum(prob(r,a) for r in rr)/ys if ys else None) for a in models}
            dd={a:dict(delta=math.fsum(x-y for x,y in zip(losses[a],losses['fH']))/n,
                delta_ci90=None,bootstrap_sd=None,z=None) for a in models}
            if h3:mm['h3']=mm.pop('garch');dd['h3']=dd.pop('garch')
            summaries.append(dict(horizon=H,primary=H in (72,168),band=band,n_rows=n,
                n_origins=len({(r['series'],r['i0']) for r in rr}),n_series=len({r['series'] for r in rr}),
                n_clusters=len({r['cluster'] for r in rr}),n_blocks=len({r['block182'] for r in rr}),
                base_rate=ys/n,bss_denominator_stored_fH=base,models=mm,paired_vs_fH=dd,
                bootstrap_successful=0,bootstrap_requested=0))
    return dict(paired_rows=len(rows),censored_pairs=0,censor_reasons={},summaries=summaries)


def fixture():
    selected=['invented-alpha','invented-beta'];rows=[]
    for s,series in enumerate(selected):
        for b,origin in ((2,100),(7,200)):
            for H,k in itertools.product((24,72,168,720),range(10)):
                y=float((s+b+k)%2)
                rows.append(dict(series=series,cluster=series,i0=origin,T=H,k=k,block182=b,y=y,
                    p_garch=.25 if y else .75,p_fH=.5,p_rec12=.4,p_base12=.6,
                    p_h3=.75 if y else .25,unavailable_reason=None,h3_unavailable_reason=None))
    rows[0]['p_garch']=1.;rows[1]['p_garch']=0.;rows[0]['p_h3']=None
    rows.append(dict(rows[2],i0=5000,block182=8,y=None))
    rows.append(dict(rows[3],i0=6000,block182=9,p_garch=None,unavailable_reason='invented unavailable'))
    common4=[r for r in rows if r['y'] in (0.,1.) and all(r['p_'+a] is not None for a in ('garch','fH','rec12','base12'))]
    common5=[r for r in common4 if r['p_h3'] is not None]
    censored=[dict(i0=7777,reason='no_fold',stored_rows=40)]
    cfg=dict(selected_series=selected,pin='invented-spent-development-pin',paths=1000,origin_every=28,sources={},runtime={})
    step=original_summary(common4);step.update(signature='invented-original-signature',config=copy.deepcopy(cfg),
        prediction_rows=len(rows),censored_pairs=len(rows)-len(common4),censored_origin_rows=40,
        censor_reasons={'invalid_outcome':1,'missing_garch':1},
        total_censored_pairs_including_origins=len(rows)-len(common4)+40,
        selected_series=2,verified_universe_series=42,
        series=[dict(series=s,censored_origins=copy.deepcopy(censored) if i==0 else []) for i,s in enumerate(selected)])
    intraday=dict(signature='invented-intraday-signature',config=dict(cfg,prior_signature=step['signature'],prior_inputs={s:'invented-checkpoint' for s in selected}),
        rows=rows,prediction_rows=len(rows),paired_rows=len(common5),excluded_rows=len(rows)-len(common5),
        inherited_censored_origins=censored,garch=original_summary(common5),h3=original_summary(common5,h3=True))
    return intraday,step


class Tests(unittest.TestCase):
    def test_populated_all_cells_supports_and_original_bands(self):
        I,S=fixture();r=M.analyze(I,S)
        self.assertEqual(r['logloss_status'],'not_defined_in_O12')
        self.assertEqual(r['input_coverage']['inherited_censored_rows'],40)
        four,five=r['supports'];self.assertEqual(four['common_rows'],160);self.assertEqual(five['common_rows'],159)
        self.assertEqual(four['reason_counts'],{'invalid_outcome':1,'missing_garch':1})
        self.assertEqual(five['reason_counts'],{'invalid_outcome':1,'missing_garch':1,'missing_h3':1})
        allviews=[v for v in four['views'] if v['scope']=='all']
        self.assertEqual(len(allviews),52)
        self.assertEqual(sum(v['common_rows'] for v in allviews if v['depth'].startswith('k')),160)
        self.assertTrue(all(v['models']['garch']['brier'] is not None for v in allviews))

    def test_allrow_denominator_components_and_direct_paired_difference(self):
        I,S=fixture();r=M.analyze(I,S)
        v=next(v for v in r['supports'][0]['views'] if (v['scope'],v['horizon'],v['depth'])==('all',24,'k0'))
        rr=[x for x in I['rows'] if x['T']==24 and x['k']==0 and x['y'] in (0.,1.)]
        n=len(rr);m=v['models']['garch']
        expected=math.fsum((x['p_garch']-1)**2 for x in rr if x['y']==1)/n
        self.assertEqual(m['event_contribution'],expected)
        self.assertAlmostEqual(m['event_contribution']+m['non_event_contribution'],m['brier'])
        pair=v['pair_deltas']['garch_minus_fH']
        self.assertEqual(pair['brier'],math.fsum((x['p_garch']-x['y'])**2-(x['p_fH']-x['y'])**2 for x in rr)/n)

    def test_exact_wrong_certainty_is_valid_not_missing(self):
        I,S=fixture();r=M.analyze(I,S)
        vv=[v for v in r['supports'][0]['views'] if v['scope']=='all' and v['depth'].startswith('k')]
        self.assertEqual(sum(v['models']['garch']['zero_events'] for v in vv),1)
        self.assertEqual(sum(v['models']['garch']['one_non_events'] for v in vv),1)
        self.assertEqual(sum(v['models']['garch']['exact_zero'] for v in vv),1)

    def test_duplicate_boolean_and_bad_clock_refused(self):
        for mutation in ('duplicate','boolean','clock'):
            I,S=fixture()
            if mutation=='duplicate':I['rows'].append(copy.deepcopy(I['rows'][0]));I['prediction_rows']+=1
            elif mutation=='boolean':I['rows'][0]['p_fH']=False
            else:I['rows'][1]['block182']+=1
            with self.assertRaises(ValueError):M.analyze(I,S)

    def test_zero_support_empty_views_remain_and_native_unavailability_counted(self):
        I,S=fixture();r=M.analyze(I,S)
        # The invalid-outcome-only block must remain, with native predictions
        # counted as available despite its absence from common loss support.
        v=next(v for v in r['supports'][0]['views'] if (v['scope'],v['horizon'],v['depth'])==('block_8',24,'k2'))
        self.assertEqual((v['native_rows'],v['common_rows']),(1,0))
        self.assertEqual(v['native_availability']['garch'],dict(valid=1,missing=0,invalid=0))
        self.assertIsNone(v['models']['garch']['brier'])
        self.assertEqual(v['models']['garch']['zero_events'],0)

    def test_anonymous_views_no_native_identity_and_no_censored_zero_loss(self):
        import json
        I,S=fixture();r=M.analyze(I,S);text=json.dumps(r,allow_nan=False)
        self.assertNotIn('invented-alpha',text);self.assertNotIn('invented-beta',text)
        self.assertEqual(r['input_coverage']['native_rows'],162)
        self.assertEqual(r['supports'][0]['common_rows'],160)
        self.assertNotIn('i0',text)

    def test_parent_scope_and_prior_lineage_are_not_silently_rebased(self):
        I,S=fixture();I['config']['prior_signature']='wrong'
        with self.assertRaises(ValueError):M.analyze(I,S)
        I,S=fixture();S['config']['selected_series'].append('invented-wider')
        S['prediction_rows']+=40;S['paired_rows']+=40
        r=M.analyze(I,S)
        self.assertFalse(r['input_coverage']['original_four_summary_scope_match'])
        self.assertEqual(r['supports'][0]['common_rows'],160)


if __name__=='__main__':unittest.main()
