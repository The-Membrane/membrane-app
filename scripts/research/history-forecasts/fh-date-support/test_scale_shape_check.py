"""Tiny brute-force rational oracles for the independent saved-only checker."""
from fractions import Fraction
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np

spec=importlib.util.spec_from_file_location('independent_scale_shape_checker',Path(__file__).with_name('scale_shape_check.py'))
C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)


def f(value):return Fraction(int(value['numerator']),int(value['denominator']))
def a(values):return np.asarray(values,dtype='<f8')


def brute(recent,older):
    support=set(recent)|set(older)
    return max(abs(Fraction(sum(x<=u for x in recent),len(recent))-
                   Fraction(sum(x<=u for x in older),len(older))) for u in support)


class ScaleShapeCheckTests(unittest.TestCase):
    def compare_oracle(self,recent,older):
        recent,older=a(recent),a(older);report=C.analyze_pair(recent,older)
        r=[Fraction.from_float(float(x)) for x in recent]
        o=[Fraction.from_float(float(x)) for x in older]
        self.assertEqual(f(report['raw_ks']),brute(r,o))
        rm,om=sorted(r)[(len(r)-1)//2],sorted(o)[(len(o)-1)//2]
        if min(rm,om)>0:
            self.assertTrue(report['normalization']['available'])
            self.assertEqual(f(report['normalization']['normalized_ks']),brute([x/rm for x in r],[x/om for x in o]))
        else:self.assertFalse(report['normalization']['available'])
        return report

    def test_pure_scale_has_zero_normalized_distance(self):
        report=self.compare_oracle([2,4,8,16],[1,2,4,8])
        self.assertEqual(f(report['raw_ks']),Fraction(1,4))
        self.assertEqual(f(report['normalization']['normalized_ks']),0)
        self.assertEqual(report['normalization']['direction'],'reduced')
        self.assertEqual([f(v) for v in report['normalization']['median_relative_profiles']['recent']],
                         [Fraction(1,2),Fraction(1,2),1,2,4,4,4])

    def test_tail_change_with_same_median_survives_normalization(self):
        report=self.compare_oracle([1,2,4,8,64],[1,2,4,8,16])
        self.assertEqual(f(report['raw_ks']),Fraction(1,5))
        self.assertEqual(f(report['normalization']['normalized_ks']),Fraction(1,5))
        self.assertEqual(report['normalization']['direction'],'equal')
        self.assertEqual(f(report['normalization']['median_relative_profiles']['recent'][-1]),16)
        self.assertEqual(f(report['normalization']['median_relative_profiles']['older'][-1]),4)

    def test_unequal_groups_and_ties_use_complete_counts(self):
        self.compare_oracle([1,1,4],[1,2,3,4,5])
        self.compare_oracle([0,0,1,1,2,7],[0,1,1])
        self.compare_oracle([1],[2,2,2,3])

    def test_nearest_rank_and_lower_even_median(self):
        report=C.analyze_pair(a([1,2,3,100]),a([1,2,3,100]))
        self.assertEqual([v['rank'] for v in report['quantiles']['recent']],[1,1,2,3,4,4,4])
        self.assertEqual(f(report['normalization']['medians']['recent']),2)
        self.assertNotEqual(f(report['normalization']['medians']['recent']),Fraction(5,2))
        self.assertEqual(report['quantiles']['recent'][2]['probability'],[1,2])

    def test_nonpositive_median_keeps_raw_statistics_and_all_rows(self):
        for recent in [[-2,0,1],[-3,-1,2],[0]]:
            report=self.compare_oracle(recent,[1,2,4])
            norm=report['normalization']
            self.assertEqual(norm['reason'],'nonpositive_median')
            self.assertIsNone(norm['normalized_ks']);self.assertIsNone(norm['direction'])
            self.assertIsNone(norm['median_relative_profiles'])
            self.assertEqual(report['recent_rows'],len(recent));self.assertEqual(len(report['quantiles']['recent']),7)

    def test_signed_favorable_values_not_folded_or_clipped(self):
        report=self.compare_oracle([-2,1,2,4],[-1,1,3,7])
        self.assertEqual(f(report['quantiles']['recent'][0]['exact_value']),-2)
        self.assertEqual(f(report['normalization']['median_relative_profiles']['recent'][0]),-2)

    def test_binary64_extreme_ratios_do_not_overflow_into_false_ties(self):
        tiny=float.fromhex('0x0.0000000000001p-1022')
        maximum=float.fromhex('0x1.fffffffffffffp+1023')
        report=self.compare_oracle([tiny,tiny,1.],[2*tiny,2*tiny,1.])
        self.assertEqual(f(report['normalization']['normalized_ks']),Fraction(1,3))
        self.assertEqual(f(report['raw_ks']),Fraction(2,3))
        self.assertGreater(f(report['normalization']['median_relative_profiles']['recent'][-1]),Fraction.from_float(maximum))
        second=self.compare_oracle([tiny,tiny,maximum],[tiny,tiny,maximum/2])
        self.assertEqual(f(second['normalization']['normalized_ks']),Fraction(1,3))

    def test_signed_zero_coordinate_is_canonical(self):
        report=self.compare_oracle([-0.,1,2],[0.,1,2])
        self.assertEqual(report['quantiles']['recent'][0]['value_hex'],0.0.hex())
        self.assertEqual(f(report['raw_ks']),0)

    def test_invalid_group_refuses_without_finite_subset(self):
        for recent in [a([]),a([1,np.nan]),a([1,np.inf]),np.array([1,2],'<f4'),a([[1,2]])]:
            with self.assertRaises(ValueError):C.analyze_pair(recent,a([1,2]))

    def full_fixture(self):
        q=1704067200;p=C.predecessor(q)
        ends=np.array([p+i*3600 for i in (-5,-4,-3,-2,-1,1,2,3,4)],'<i8')
        states=np.array([0,0,1,1,-1,0,0,1,1],'i1')
        z=a([2,-1,-1,-2,-.5,-2,-4,-3,-6])
        one=dict(available=True,rows=9,date_rows=[4,5],state_date_rows=[2,2,2,2,0,1])
        return z,2*z,states,ends,p,q,dict(current=dict(one),previous=dict(one))

    def test_all_four_pairs_fixed_signed_orientation_and_unknown_provenance(self):
        args=self.full_fixture();report=C.analyze_basis(*args)
        self.assertEqual(set(report['pairs']),{'current_state_0','current_state_1','previous_state_0','previous_state_1'})
        self.assertEqual(report['target'],'signed_adverse_excursion_X_equals_minus_Z')
        self.assertEqual(report['provenance_counts']['unknown_rows'],1)
        self.assertEqual(report['provenance_counts']['state_date_rows'],[2,2,2,2,0,1])
        self.assertEqual(f(report['pairs']['current_state_0']['quantiles']['older'][0]['exact_value']),-2)
        self.assertFalse(report['pairs']['current_state_0']['normalization']['available'])
        self.assertEqual(f(report['pairs']['current_state_1']['normalization']['normalized_ks']),0)

    def test_full_cohort_or_accepted_metadata_mismatch_refused(self):
        args=list(self.full_fixture())
        for index,value in [(0,args[0][:-1]),(1,args[1].astype('<f4')),
                            (2,np.array([7]+args[2][1:].tolist(),'i1')),
                            (3,args[3][::-1])]:
            bad=list(args);bad[index]=value
            with self.subTest(field=index),self.assertRaises(ValueError):C.analyze_basis(*bad)
        for field,value in [('rows',8),('date_rows',[5,4]),('state_date_rows',[1,3,2,2,0,1]),('available',False)]:
            bad=list(args);bad[-1]={k:dict(v) for k,v in args[-1].items()};bad[-1]['current'][field]=value
            with self.subTest(metadata=field),self.assertRaises(ValueError):C.analyze_basis(*bad)

    def test_exact_predecessor_equality_stays_older(self):
        args=list(self.full_fixture());args[3]=args[3].copy();args[3][4]=args[4]
        report=C.analyze_basis(*args)
        self.assertEqual(report['provenance_counts']['date_rows'],[4,5])
        bad=list(args);bad[4]+=3600
        with self.assertRaises(ValueError):C.analyze_basis(*bad)

    def test_external_request_sha_before_json_and_symlink_source_drift(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d).resolve()/'request';p.write_bytes(b'not json')
            with self.assertRaisesRegex(ValueError,'external checker request SHA'):C.authenticate(p,'0'*64)
            value=C.pin(p);p.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'byte pin mismatch'):C.check(value)
            alias=p.with_name('alias');alias.symlink_to(p)
            with self.assertRaises(ValueError):C.pin(alias)

    def test_strict_saved_report_and_json_ambiguity(self):
        report=self.compare_oracle([2,4,8],[1,2,4]);bad=json.loads(json.dumps(report))
        bad['normalization']['normalized_ks']['numerator']='1'
        with self.assertRaises(ValueError):C.same(bad,report)
        with self.assertRaises(ValueError):C.same(True,1)
        with tempfile.TemporaryDirectory() as d:
            p=Path(d).resolve()/'a.json'
            for text in ['{"x":1,"x":2}','{"x":Infinity}']:
                p.write_text(text)
                with self.assertRaises(ValueError):C.read(p)

    def test_phase_root_rejects_relocated_parent_and_protected_outputs_before_decode(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();old=root/'accepted';producer=old/'producer';new=root/'new'
            producer.mkdir(parents=True);new.mkdir()
            pins={k:{'path':str(old/n)} for k,n in [('phase','phase.json'),('parent','parent-acceptance.json'),('closed','closed-phase.json')]}
            with mock.patch.object(np,'load',side_effect=AssertionError('no data decoding')):
                self.assertEqual(C.accepted_root(pins,str(producer)),old)
                self.assertEqual(C.outside_old(new/'receipt.json',old),new/'receipt.json')
                relocated={k:dict(v) for k,v in pins.items()};relocated['parent']['path']=str(new/'parent.json')
                with self.assertRaisesRegex(ValueError,'phase-derived accepted root'):C.accepted_root(relocated,str(producer))
                for target in [old/'receipt.json',producer/'receipt.json',old/'nested'/'analysis.json']:
                    with self.subTest(target=str(target)),self.assertRaisesRegex(ValueError,'whole accepted evidence root'):
                        C.outside_old(target,old)
                with self.assertRaises(ValueError):C.accepted_root(pins,str(new/'producer'))


if __name__=='__main__':unittest.main()
