"""Independent small rational, saved-basis, metadata and no-refit contracts."""
import copy
from fractions import Fraction
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock
import zipfile

import numpy as np

spec=importlib.util.spec_from_file_location('independent_depth_checker',Path(__file__).with_name('depth_check.py'))
C=importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)


def rat(value):
    return Fraction(int(value['numerator']),int(value['denominator']))


class DepthCheckTests(unittest.TestCase):
    def rows(self):
        return (np.array([-1,1,1,0,0,-1,2,1],'<f8'),
                np.array([0,0,0,1,0,1,1,-1],'i1'),
                np.array([200,200,200,200,0,0,0,-1],'<i8'))

    def basis(self):
        z,states,ends=self.rows();n=len(z)
        accepted=dict(main_index=np.arange(n,dtype='<i8'),main_label_end=ends,
                      main_state=states,D_original=np.where(states==-1,np.nan,states).astype('<f4'),
                      unknown_partition=np.where(states==-1,0,-1).astype('i1'))
        actual=dict(accepted)
        status={}
        for name,raw in [('current',(np.ones(n,'<f8'),z,np.ones(n,bool))),('previous',(None,None,None))]:
            rows,status[name]=C.vintage_rows(*raw,np.arange(n,dtype='<i8'))
            actual.update({name+'_'+k:v for k,v in rows.items()})
        report,knots,counts=C.recount(z,states,ends,100)
        basis=dict(actual,current_knots=knots,current_counts=counts,
                   previous_knots=np.empty(0,'<f8'),previous_counts=np.empty((0,6),'<i8'))
        return basis,actual,status,accepted

    def test_hand_rational_oracle_and_finite_left_tail(self):
        report,knots,table=C.recount(*self.rows(),100)
        self.assertEqual(knots.tolist(),[-1.,0.,1.,2.])
        self.assertEqual(table.tolist(),[[0]*6,[1,0,0,1,0,0],[1,1,1,1,0,0],
                                        [3,1,1,1,0,1],[3,1,1,2,0,1]])
        den=int(report['common_denominator'])
        coeff={k:[int(x) for x in v] for k,v in report['integer_coefficients'].items()}
        oracle=[(0,0,0,0),(Fraction(1,48),Fraction(-1,48),0,0),
                (Fraction(7,48),Fraction(-7,48),0,0),
                (Fraction(5,16),Fraction(3,16),Fraction(-1,4),Fraction(1,4)),
                (Fraction(1,4),0,Fraction(-1,4),0)]
        for row,expected in zip(table,oracle):
            for name,value in zip(C.NAMES[:4],(expected[3],expected[0],expected[1],expected[2])):
                self.assertEqual(Fraction(sum(c*x for c,x in zip(coeff[name],list(map(int,row))+[1])),den),value)
        self.assertEqual(rat(report['suprema']['composition_lower']),Fraction(1,8))
        observed_only=max(abs(Fraction(sum(c*x for c,x in zip(coeff['composition_lower'],list(map(int,row))+[1])),den)) for row in table[1:])
        self.assertEqual(observed_only,Fraction(5,48))
        self.assertEqual(rat(report['suprema']['date_gap']),Fraction(1,4))
        self.assertEqual(rat(report['suprema']['common_composition']),Fraction(5,16))
        self.assertEqual(rat(report['suprema']['common_within']),Fraction(3,16))
        self.assertEqual(rat(report['each_allocation_width']),Fraction(1,8))

    def test_linked_endpoints_not_rectangle(self):
        report,_,table=C.recount(*self.rows(),100);den=int(report['common_denominator'])
        values={k:Fraction(sum(int(c)*x for c,x in zip(v,list(map(int,table[3]))+[1])),den)
                for k,v in report['integer_coefficients'].items()}
        self.assertEqual(values['composition_lower'],Fraction(1,16))
        self.assertEqual(values['within_upper'],Fraction(3,16))
        self.assertEqual(values['composition_lower']+values['within_upper'],values['date_gap'])
        self.assertNotEqual(values['composition_lower']+values['within_lower'],values['date_gap'])

    def test_ties_signed_zero_and_right_tail_complete(self):
        z,s,e=self.rows();z[4]=-0.
        report,knots,counts=C.recount(z,s,e,100)
        self.assertFalse(np.signbit(knots[knots==0]).any())
        self.assertEqual(counts[-1].tolist(),report['state_date_rows'])
        self.assertEqual(counts[2].tolist(),[1,1,1,1,0,0])
        self.assertEqual(rat(report['left_state']['finite_exact_coordinate']),Fraction(-2))

    def test_nonfinite_depth_refuses_whole_vintage(self):
        z,s,e=self.rows()
        for value in [np.nan,np.inf,-np.inf]:
            bad=z.copy();bad[0]=value
            with self.assertRaises(ValueError):C.recount(bad,s,e,100)

    def test_missing_known_support_or_wrong_unknown_dates_refused(self):
        for totals in [[3,0,1,2,0,1],[4,3,0,0,0,1],[3,1,1,2,1,1]]:
            with self.assertRaises(ValueError):C.cdf_forms(totals)
        z,s,e=self.rows();e[-1]=100
        with self.assertRaises(ValueError):C.recount(z,s,e,100)

    def test_all_fifteen_saved_fields_bound(self):
        basis,actual,status,accepted=self.basis()
        reports=C.verify_saved(basis,actual,status,accepted,dict(previous_cutoff=100))
        self.assertTrue(reports['current']['available']);self.assertFalse(reports['previous']['available'])
        self.assertEqual(reports['previous']['vintage_status']['stored_fixed_rows'],0)
        for name in basis:
            bad={k:v.copy() for k,v in basis.items()}
            if bad[name].size:
                flat=bad[name].reshape(-1)
                flat[0]=not flat[0] if flat.dtype==bool else flat[0]+1
            else:
                bad[name]=np.zeros((1,6) if name.endswith('_counts') else (1,),dtype=basis[name].dtype)
            with self.subTest(field=name),self.assertRaises(ValueError):
                C.verify_saved(bad,actual,status,accepted,dict(previous_cutoff=100))

    def test_each_original_witness_field_exact(self):
        basis,actual,status,accepted=self.basis()
        for name in accepted:
            changed={k:v.copy() for k,v in actual.items()};changed[name].reshape(-1)[0]+=1
            with self.subTest(field=name),self.assertRaises(ValueError):
                C.verify_saved(basis,changed,status,accepted,dict(previous_cutoff=100))

    def test_float_bits_and_dtype_not_numeric_equality(self):
        zero=np.array([-0.],'<f8');plus=np.array([0.],'<f8')
        with self.assertRaises(ValueError):C.exact_arrays({'a':zero},{'a':plus})
        a=np.array([0x7ff8000000000001],'<u8').view('<f8')
        b=np.array([0x7ff8000000000002],'<u8').view('<f8')
        with self.assertRaises(ValueError):C.exact_arrays({'a':a},{'a':b})
        with self.assertRaises(ValueError):C.exact_arrays({'a':np.array([1],'<i4')},{'a':np.array([1],'<i8')})

    def test_whole_vintage_unavailability_and_raw_retention(self):
        indices=np.arange(3,dtype='<i8');z=np.array([-1.,-0.,np.nan],'<f8')
        for value in [0.,-1.,np.nan,np.inf]:
            sigma=np.ones(3,'<f8');sigma[1]=value
            rows,status=C.vintage_rows(sigma,z,np.ones(3,bool),indices)
            self.assertFalse(status['available']);self.assertEqual(status['stored_fixed_rows'],3)
            self.assertEqual(rows['z'].tobytes(),z.tobytes())
        rows,status=C.vintage_rows(None,None,None,indices)
        self.assertFalse(status['available']);self.assertEqual(rows['sigma'].shape,(0,))
        self.assertIsNone(status['nonpositive_sigma_rows'])
        with self.assertRaises(ValueError):C.vintage_rows(None,z,np.ones(3,bool),indices)

    def record_fixture(self,missing):
        q=1704067200;base=q-28*3600;n=6;called=[]
        class Prep:
            n=6
            okH=np.array([True]+[False]*5) if missing else np.ones(6,bool)
            P=types.SimpleNamespace(valid={1.:np.ones(6,bool)})
            def sigma_H(self,coef):called.append(coef);return np.ones(n,'<f8')
            def z_of(self,sigma):return np.zeros(n,'<f8'),np.ones(n,bool)
        record=dict(quarter_cutoff=q,n_reg=1 if missing else 5,coef=None if missing else [0.]*4,
                    har_label_end_min=base+24*3600,har_label_end_max=base+24*3600 if missing else q,
                    library_label_end_max=q,fallback_library_label_end_max=q)
        return Prep(),types.SimpleNamespace(base_ts=base),record,called

    def test_none_verifies_original_metadata_but_not_fallback_basis(self):
        prep,ser,record,called=self.record_fixture(True)
        sigma,z,valid,main=C.retained_record(prep,ser,record)
        self.assertEqual(called,[None]);self.assertIsNone(sigma);self.assertIsNone(z);self.assertIsNone(valid)
        self.assertEqual(main,[0,1,2,3,4])
        rows,status=C.vintage_rows(sigma,z,valid,np.array(main,'<i8'))
        self.assertEqual(rows['sigma'].size,0);self.assertFalse(status['available'])

    def test_record_maturity_and_coefficient_tamper(self):
        prep,ser,record,_=self.record_fixture(False)
        C.retained_record(prep,ser,record)
        for key,value in [('n_reg',4),('library_label_end_max',record['quarter_cutoff']+3600),('coef',None)]:
            bad=dict(record,**{key:value})
            with self.assertRaises(ValueError):C.retained_record(prep,ser,bad)

    def test_bounded_headers_without_np_load(self):
        basis,_,_,_=self.basis()
        with tempfile.TemporaryDirectory() as d:
            p=Path(d).resolve()/'basis.npz';np.savez_compressed(p,**basis)
            with mock.patch.object(np,'load',side_effect=AssertionError('array decode')):C.basis_headers(p)
            for name,value in [('current_counts',basis['current_counts'].astype('<i4')),
                               ('previous_counts',np.zeros((1,6),'<i8')),
                               ('D_original',basis['D_original'].astype('<f8'))]:
                bad=dict(basis,**{name:value});np.savez_compressed(p,**bad)
                with self.subTest(field=name),self.assertRaises(ValueError):C.basis_headers(p)

    def test_truncated_npy_member_and_duplicate_members_refused(self):
        basis,_,_,_=self.basis()
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();p=root/'basis.npz';np.savez_compressed(p,**basis)
            with zipfile.ZipFile(p) as a:members={name:a.read(name) for name in a.namelist()}
            bad=root/'truncated.npz'
            with zipfile.ZipFile(bad,'w') as a:
                for name,data in members.items():a.writestr(name,data[:-1] if name=='main_index.npy' else data)
            with self.assertRaises(ValueError):C.basis_headers(bad)
            with zipfile.ZipFile(bad,'w') as a:
                for name,data in members.items():a.writestr(name,data)
                with self.assertWarns(UserWarning):a.writestr('main_index.npy',members['main_index.npy'])
            with self.assertRaises(ValueError):C.basis_headers(bad)

    def terminal_fixture(self):
        p=lambda name:dict(path='/synthetic/'+name,size=1,sha256='a'*64)
        pins={k:p(k) for k in ('producer_request','producer_source','result','basis','started')}
        plan=dict(runtime=dict(python_path='/synthetic/python'))
        request=dict(out='/synthetic/out')
        body=dict(schema='q26-fh-depth-producer-terminal-v1',request=pins['producer_request'],
                  argv=['/synthetic/python','-B',pins['producer_source']['path'],'--request',pins['producer_request']['path'],
                        '--request-sha256',pins['producer_request']['sha256'],'--out',request['out']],
                  complete=True,exit_code=0,reaped=True,no_live_members=True,elapsed_seconds=.125,charged_seconds=1,
                  output_pins={k:pins[k] for k in ('result','basis','started')})
        return body,pins,request,plan

    def test_exact_terminal_and_charge_bindings(self):
        body,pins,request,plan=self.terminal_fixture();C.terminal_check(body,pins,request,plan)
        variants=[('complete',False),('reaped',False),('no_live_members',False),('exit_code',False),
                  ('elapsed_seconds',float('nan')),('elapsed_seconds',61.),('charged_seconds',0),('argv',body['argv'][:-1])]
        for key,value in variants:
            bad=copy.deepcopy(body);bad[key]=value
            with self.subTest(field=key),self.assertRaises(ValueError):C.terminal_check(bad,pins,request,plan)
        bad=copy.deepcopy(body);bad['output_pins']['basis']['sha256']='b'*64
        with self.assertRaises(ValueError):C.terminal_check(bad,pins,request,plan)

    def test_external_sha_and_source_pin_drift_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d).resolve()/'request.json';p.write_bytes(b'invalid json')
            with self.assertRaisesRegex(ValueError,'external bounded request SHA'):C.authenticate(p,'0'*64)
            value=C.pin(p);p.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'byte pin mismatch'):C.check(value)
            alias=p.with_name('alias');alias.symlink_to(p)
            with self.assertRaises(ValueError):C.pin(alias)

    def test_strict_report_tree_tamper_and_json_ambiguity(self):
        report,_,_=C.recount(*self.rows(),100);bad=copy.deepcopy(report)
        bad['common_denominator']='1'
        with self.assertRaises(ValueError):C.tree(bad,report)
        with self.assertRaises(ValueError):C.tree(True,1)
        with tempfile.TemporaryDirectory() as d:
            p=Path(d).resolve()/'a.json'
            for data in ['{"x":1,"x":2}','{"x":NaN}']:
                p.write_text(data)
                with self.assertRaises(ValueError):C.read(p)

    def test_exact_scope_claim_not_just_field_presence(self):
        C.scope_claims(C.CLAIMS)
        for value in [None,True,1,C.CLAIMS+' Causal skill established.','']:
            with self.assertRaisesRegex(ValueError,'exact bounded claims'):C.scope_claims(value)

    def test_nested_original_outputs_mutated_after_authentication_are_rehashed(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d).resolve();oldroot=root/'old';newroot=root/'new'
            oldroot.mkdir(mode=0o700);newroot.mkdir(mode=0o700)
            def put(path,data):
                path.write_bytes(data);path.chmod(0o600);return C.pin(path)
            oldpins={}
            for role,name in [('result','result.json'),('started','started.json'),('witness','witness.npz')]:
                oldpins[role]=put(oldroot/name,('old-'+role).encode())
            for role in ['plan','acceptance','python','implementation']:
                oldpins[role]=put(root/('old-'+role),role.encode())
            support=root/'support.json';put(support,(json.dumps({'pins':oldpins})+'\n').encode())
            pins={'support_request':C.pin(support)}
            for role,name in [('result','result.json'),('basis','basis.npz'),('started','started.json')]:
                pins[role]=put(newroot/name,('new-'+role).encode())
            request=root/'checker.json';put(request,b'checkpoint\n')
            q=dict(pins=pins);plan=dict(files=[],out=str(oldroot));producer=dict(out=str(newroot))
            sha=C.pin(request)['sha256']
            # The authenticated checkpoint passes before a concurrent nested-output change.
            for value in oldpins.values():C.check(value)
            C.final_checks(q,plan,producer,request,sha)
            for role in ['result','started']:
                p=Path(oldpins[role]['path']);original=p.read_bytes();p.write_bytes(b'changed nested output')
                try:
                    with self.subTest(role=role),self.assertRaisesRegex(ValueError,'byte pin mismatch'):
                        C.final_checks(q,plan,producer,request,sha)
                finally:p.write_bytes(original)

    def test_no_fit_prediction_guards_restore(self):
        class Prep:
            def har_coef(self):return 'fit'
            def fh_w(self):return 'prediction'
        A6=types.SimpleNamespace(Prep6=Prep);M2=types.SimpleNamespace(fhs_predict=lambda:'prediction')
        original=np.linalg.solve
        with C.no_models(A6,M2):
            for f in (Prep().har_coef,Prep().fh_w,M2.fhs_predict,np.linalg.solve,np.linalg.lstsq):
                with self.assertRaisesRegex(RuntimeError,'forbidden'):f()
        self.assertIs(np.linalg.solve,original);self.assertEqual(Prep().har_coef(),'fit')


if __name__=='__main__':unittest.main()
