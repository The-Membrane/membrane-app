"""Synthetic only. No historical arrays or original scientific code execution."""
import copy
from fractions import Fraction as Q
import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock
import numpy as np

spec = importlib.util.spec_from_file_location('depth_accounting_tested', Path(__file__).with_name('depth_accounting.py'))
D = importlib.util.module_from_spec(spec)
spec.loader.exec_module(D)


def fixture():
    p = 1704067200
    # Recent state0[-1,1,1],state1[0]; older state0[0],state1[-1,2],unknown[1].
    z = np.array([-1, 1, 1, 0, 0, -1, 2, 1], dtype='<f8')
    state = np.array([0, 0, 0, 1, 0, 1, 1, -1], dtype='i1')
    ends = p + 3600 * np.array([1, 2, 3, 4, -4, -3, -2, -1], dtype='<i8')
    return z, state, ends, p


def evaluate(report, row):
    den = int(report['common_denominator'])
    x = tuple(int(v) for v in row) + (1,)
    return {name: Q(sum(int(c) * v for c, v in zip(coef, x)), den)
            for name, coef in report['integer_coefficients'].items()}


def oracle(z, state, ends, p, u):
    """Independent tiny-fixture direct row iteration and Fraction arithmetic."""
    recent, older = [], []
    for j in range(len(z)):
        (recent if int(ends[j]) > p else older).append(j)
    nr, no = len(recent), len(older)
    def f(rows):
        return Q(sum(Q.from_float(float(z[i])) <= u for i in rows), len(rows))
    delta = f(recent) - f(older)
    common_c, common_w = Q(0), Q(0)
    for g in (0, 1):
        r = [i for i in recent if int(state[i]) == g]
        o = [i for i in older if int(state[i]) == g]
        if not r and not o:
            continue
        pr, po = Q(len(r), nr), Q(len(o), no)
        fr, fo = f(r), f(o)
        common_c += (pr - po) * (fr + fo) / 2
        common_w += (pr + po) * (fr - fo) / 2
    unknown = [i for i in older if int(state[i]) == -1]
    alpha, fu = Q(len(unknown), no), f(unknown)
    return {'date_gap': delta, 'common_composition': common_c, 'common_within': common_w,
            'unknown_net': -alpha * fu, 'composition_lower': common_c - alpha * (1 + fu) / 2,
            'composition_upper': common_c - alpha * fu / 2, 'within_lower': common_w - alpha * fu / 2,
            'within_upper': common_w + alpha * (1 - fu) / 2}


class KernelTests(unittest.TestCase):
    def test_independent_fraction_oracle_all_rows_and_exact_known_answers(self):
        z, state, ends, p = fixture()
        report, knots, table = D.accounting(z, state, ends, p)
        self.assertEqual(knots.tolist(), [-1.0, 0.0, 1.0, 2.0])
        self.assertEqual(table.shape, (5, 6))
        left = report['left_state']['finite_exact_coordinate']
        thresholds = [Q(int(left['numerator']), int(left['denominator']))] + [Q.from_float(float(u)) for u in knots]
        expected = [(Q(0), Q(0), Q(0), Q(0)),
                    (Q(1,48), Q(-1,48), Q(0), Q(0)),
                    (Q(7,48), Q(-7,48), Q(0), Q(0)),
                    (Q(5,16), Q(3,16), Q(-1,4), Q(1,4)),
                    (Q(1,4), Q(0), Q(-1,4), Q(0))]
        for i, u in enumerate(thresholds):
            values = evaluate(report, table[i])
            self.assertEqual(values, oracle(z, state, ends, p, u))
            self.assertEqual(tuple(values[k] for k in ('common_composition', 'common_within', 'unknown_net', 'date_gap')), expected[i])
            self.assertEqual(values['composition_lower'] + values['within_upper'], values['date_gap'])
            self.assertEqual(values['composition_upper'] + values['within_lower'], values['date_gap'])
        self.assertEqual(report['suprema']['composition_lower'], {'numerator': '1', 'denominator': '8'})
        self.assertEqual(report['suprema']['common_composition'], {'numerator': '5', 'denominator': '16'})
        self.assertEqual(report['suprema']['common_within'], {'numerator': '3', 'denominator': '16'})

    def test_finite_left_envelopes_do_not_collapse_to_zero(self):
        z, state, ends, p = fixture()
        r, _, t = D.accounting(z, state, ends, p)
        left = evaluate(r, t[0])
        self.assertEqual((left['composition_lower'], left['composition_upper'], left['within_lower'], left['within_upper']),
                         (Q(-1,8), Q(0), Q(0), Q(1,8)))
        self.assertEqual(left['date_gap'], 0)
        self.assertEqual(r['left_state']['kind'], 'BEFORE_MIN')

    def test_linked_extrema_cannot_be_added_as_independent_allocations(self):
        z, state, ends, p = fixture()
        r, _, t = D.accounting(z, state, ends, p)
        at_one = evaluate(r, t[3])
        self.assertEqual(at_one['composition_lower'] + at_one['within_upper'], at_one['date_gap'])
        self.assertNotEqual(at_one['composition_lower'] + at_one['within_lower'], at_one['date_gap'])
        self.assertEqual(at_one['composition_upper'] - at_one['composition_lower'], Q(1,8))

    def test_unequal_group_denominator_and_absent_known_state_refusal(self):
        z = np.arange(7, dtype='<f8')
        s = np.array([-1,0,1,0,0,1,1], dtype='i1')
        ends = np.array([-3,-2,-1,1,2,3,4], dtype='<i8') * 3600
        r, knots, t = D.accounting(z, s, ends, 0)
        self.assertEqual(r['alpha_older_unknown_over_older_all'], {'numerator':'1','denominator':'3'})
        self.assertEqual(r['each_allocation_width'], {'numerator':'1','denominator':'6'})
        for j, u in enumerate(knots, 1):
            self.assertEqual(evaluate(r,t[j]), oracle(z,s,ends,0,Q.from_float(float(u))))
        s[s == 1] = 0
        with self.assertRaisesRegex(ValueError, 'both known states'):
            D.accounting(z,s,ends,0)

    def test_signed_zero_canonicalized_and_extreme_finite_left_coordinate(self):
        z, s, e, p = fixture()
        z[0], z[1] = -0.0, 0.0
        r, knots, _ = D.accounting(z,s,e,p)
        self.assertEqual(np.count_nonzero(knots == 0), 1)
        self.assertFalse(np.signbit(knots[knots == 0])[0])
        z[0] = -np.finfo(np.float64).max
        r, _, _ = D.accounting(z,s,e,p)
        left = r['left_state']['finite_exact_coordinate']
        self.assertLess(Q(int(left['numerator']), int(left['denominator'])), Q.from_float(float(z[0])))

    def test_one_sided_unknown_or_known_state_and_nonfinite_refuse(self):
        for kind in ('unknown_recent','unknown_equal','unknown_absent','known_one_side','nan','inf','dtype','shape'):
            z,s,e,p = fixture()
            if kind == 'unknown_recent': e[-1] = p+3600
            elif kind == 'unknown_equal': e[-1] = p
            elif kind == 'unknown_absent': s[-1] = 0
            elif kind == 'known_one_side': s[:3] = 1
            elif kind == 'nan': z[0] = np.nan
            elif kind == 'inf': z[0] = np.inf
            elif kind == 'dtype': z = z.astype('f4')
            else: e = e.reshape(2,4)
            with self.subTest(kind=kind), self.assertRaises(ValueError): D.accounting(z,s,e,p)


class VintageTests(unittest.TestCase):
    def test_missing_previous_has_no_fabricated_raw_values(self):
        main = np.array([0,1], dtype='<i8')
        arrays, status = D.fixed_vintage(None,None,None,main)
        self.assertFalse(status['available'])
        self.assertEqual(status['reason'], 'missing_predecessor_coefficient')
        self.assertTrue(all(a.size == 0 for a in arrays.values()))

    def test_any_original_invalid_or_nonfinite_fixed_row_disables_whole_vintage(self):
        main = np.array([0,1,2], dtype='<i8')
        for kind in ('valid','sigma','zero_sigma','negative_sigma','z'):
            sigma,z,valid = np.ones(3),np.array([-1.0,0.0,1.0]),np.ones(3,dtype=bool)
            if kind == 'valid': valid[1] = False
            elif kind == 'sigma': sigma[1] = np.inf
            elif kind == 'zero_sigma': sigma[1] = 0.0
            elif kind == 'negative_sigma': sigma[1] = -1.0
            else: z[1] = np.nan
            arrays, status = D.fixed_vintage(sigma,z,valid,main)
            self.assertFalse(status['available'])
            self.assertEqual(status['stored_fixed_rows'],3)
            for key,value in [('sigma',sigma),('z',z),('valid',valid)]:
                self.assertEqual(arrays[key].tobytes(),value.tobytes())

    def test_finite_depth_does_not_override_original_invalidity(self):
        arrays,status = D.fixed_vintage(np.ones(2),np.zeros(2),np.array([True,False]),np.array([0,1]))
        self.assertFalse(status['available'])
        self.assertEqual(status['invalid_rows'],1)

    def test_all_five_witness_arrays_require_exact_float_bits(self):
        w = {'main_index':np.array([0,1],dtype='<i8'),'main_label_end':np.array([3600,7200],dtype='<i8'),
             'main_state':np.array([0,-1],dtype='i1'),'D_original':np.array([-0.0,np.nan],dtype='<f4'),
             'unknown_partition':np.array([-1,0],dtype='i1')}
        D.exact_witness(w,copy.deepcopy(w))
        for key in w:
            altered = copy.deepcopy(w)
            if key == 'D_original': altered[key].view('<u4')[0] = 0
            else: altered[key][0] += 1
            with self.subTest(key=key), self.assertRaises(ValueError): D.exact_witness(altered,w)
        changed = copy.deepcopy(w)
        changed['D_original'].view('<u4')[1] = 0x7fc00001
        with self.assertRaises(ValueError): D.exact_witness(changed,w)

    def test_original_record_none_validates_original_metadata_but_remains_unavailable(self):
        class Prep:
            n=5
            okH=np.zeros(5,dtype=bool)
            P=types.SimpleNamespace(valid={1.:np.ones(5,dtype=bool)})
            calls=[]
            def sigma_H(self,coef):
                self.calls.append(('sigma_H',coef))
                return np.full(5,np.nan)
            def z_of(self,sigma):
                self.calls.append(('z_of',None))
                return np.full(5,np.nan),np.zeros(5,dtype=bool)
        ser = types.SimpleNamespace(base_ts=1704067200)
        record={'quarter_cutoff':1704067200,'n_reg':0,'coef':None,
                'har_label_end_max':None,'har_label_end_min':None,'library_label_end_max':None,
                'fallback_library_label_end_max':None}
        prep=Prep()
        sigma,z,valid,main=D.original_record(prep,ser,record)
        self.assertEqual(prep.calls,[('sigma_H',None),('z_of',None)])
        self.assertIsNone(sigma);self.assertIsNone(z);self.assertIsNone(valid);self.assertEqual(len(main),0)
        record['n_reg']=1
        with self.assertRaises(ValueError): D.original_record(Prep(),ser,record)

    def test_none_still_validates_populated_own_metadata(self):
        base=1704067200
        class Prep:
            n=5
            okH=np.zeros(5,dtype=bool)
            P=types.SimpleNamespace(valid={1.:np.ones(5,dtype=bool)})
            def sigma_H(self,coef):
                if coef is not None: raise AssertionError('fixture exercises None')
                return np.ones(5)
            def z_of(self,sigma):return np.zeros(5),np.ones(5,dtype=bool)
        record={'quarter_cutoff':base+100*3600,'n_reg':0,'coef':None,
                'har_label_end_max':None,'har_label_end_min':None,
                'library_label_end_max':base+28*3600,'fallback_library_label_end_max':base+28*3600}
        sigma,z,valid,main=D.original_record(Prep(),types.SimpleNamespace(base_ts=base),record)
        self.assertIsNone(sigma);self.assertIsNone(z);self.assertIsNone(valid)
        self.assertEqual(main.tolist(),[0,1,2,3,4])
        record['library_label_end_max']-=3600
        with self.assertRaises(ValueError):D.original_record(Prep(),types.SimpleNamespace(base_ts=base),record)


class AuthorityTests(unittest.TestCase):
    def run_fixture(self, root):
        # Explicit orchestration seam: admission/reconstruction mocked in these
        # tests, so this is not qualification of full frozen scientific auth.
        z,state,ends,p=fixture();order=np.argsort(ends);z=z[order];state=state[order];ends=ends[order]
        accepted={'main_index':np.arange(len(z),dtype='<i8'),'main_label_end':ends,'main_state':state,
                  'D_original':np.where(state==-1,np.nan,np.where(state==0,-1.,1.)).astype('<f4'),
                  'unknown_partition':np.where(state==-1,0,-1).astype('i1')}
        old=root/'old';old.mkdir()
        np.savez_compressed(old/'witness.npz',**accepted)
        (old/'started.json').write_text('{}');(old/'result.json').write_text('{}')
        request={'pins':{'witness':D.pin(old/'witness.npz'),'source':D.pin(Path(D.__file__).absolute())},'out':str(root/'new')}
        request_path=root/'request.json'
        import json
        request_path.write_text(json.dumps(request));sha=D.pin(request_path)['sha256']
        plan={'out':str(old),'files':[],'pilot':{'previous_cutoff':p,'current_cutoff':1711929600}}
        arrays=dict(accepted);status={}
        for name,scale in [('current',1.),('previous',2.)]:
            arrays[name+'_sigma']=np.full(len(z),scale,dtype='<f8')
            arrays[name+'_z']=z/scale
            arrays[name+'_valid']=np.ones(len(z),dtype=bool)
            status[name]={'available':True,'reason':None,'stored_fixed_rows':len(z),'invalid_rows':0,
                          'nonfinite_sigma_rows':0,'nonpositive_sigma_rows':0,'nonfinite_z_rows':0}
        checker=types.SimpleNamespace(witness_header_check=mock.Mock())
        return request_path,sha,request,plan,arrays,status,checker

    def test_mocked_positive_run_persists_lossless_basis_and_keeps_old_inventory(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t).resolve();rp,sha,request,plan,arrays,status,checker=self.run_fixture(root)
            old_before={v.name:v.read_bytes() for v in Path(plan['out']).iterdir()}
            with mock.patch.object(D,'authenticate',return_value=(request,plan,{},None,checker,None)), \
                 mock.patch.object(D,'reconstruct',return_value=(arrays,status)):
                result=D.run(rp,sha,request['out'])
            self.assertTrue(result['complete'])
            self.assertEqual(set(v.name for v in Path(request['out']).iterdir()),{'started.json','basis.npz','result.json'})
            self.assertEqual({v.name:v.read_bytes() for v in Path(plan['out']).iterdir()},old_before)
            with np.load(Path(request['out'])/'basis.npz',allow_pickle=False) as saved:
                self.assertEqual(len(saved.files),15)
                self.assertEqual(saved['current_counts'].shape[1],6)
                self.assertEqual(saved['current_counts'][0].tolist(),[0]*6)
            self.assertEqual((Path(request['out'])/'basis.npz').stat().st_mode&0o777,0o600)
            checker.witness_header_check.assert_called_once()

    def test_header_refusal_precedes_witness_decode(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t).resolve();rp,sha,request,plan,arrays,status,checker=self.run_fixture(root)
            checker.witness_header_check.side_effect=ValueError('bad header')
            with mock.patch.object(D,'authenticate',return_value=(request,plan,{},None,checker,None)), \
                 mock.patch.object(D.np,'load') as load, self.assertRaisesRegex(ValueError,'bad header'):
                D.run(rp,sha,request['out'])
            load.assert_not_called()

    def test_noncanonical_input_or_output_alias_refused(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t).resolve()
            for value in (root/'sub'/'..'/'new.json',root/'..'/root.name/'new.json'):
                with self.assertRaises(ValueError): D.canonical(value)
            link=root/'alias';link.symlink_to(root)
            with self.assertRaises(ValueError): D.canonical(link/'new.json')

    def test_wrong_outer_sha_refuses_before_private_decode_or_helper_import(self):
        with tempfile.TemporaryDirectory() as t:
            request=Path(t).resolve()/'request.json';request.write_text('{}')
            with mock.patch.object(D.np,'load') as load, mock.patch.object(D,'module') as imported, self.assertRaises(ValueError):
                D.authenticate(request,'0'*64)
            load.assert_not_called();imported.assert_not_called()

    def test_pin_tamper_and_nonexclusive_output_refused(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t).resolve()/'p';p.write_bytes(b'original')
            saved=D.pin(p);p.write_bytes(b'changed')
            with self.assertRaises(ValueError): D.checked(saved)
            with self.assertRaises(FileExistsError): D.write_json(p,{'complete':True})


if __name__=='__main__':
    unittest.main()
