"""Synthetic only; no historical series, basis arrays or scientific execution."""
import copy
from fractions import Fraction
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import numpy as np

HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('scale_shape_tested',HERE/'scale_shape.py')
S=importlib.util.module_from_spec(spec);spec.loader.exec_module(S)


def value(record):return Fraction(int(record['numerator']),int(record['denominator']))


def brute_ks(a,b,ma=1.,mb=1.):
    # Tiny-fixture oracle: deliberately direct and quadratic, never real data.
    aa=[Fraction.from_float(float(x))/Fraction.from_float(float(ma)) for x in a]
    bb=[Fraction.from_float(float(x))/Fraction.from_float(float(mb)) for x in b]
    return max((abs(Fraction(sum(x<=u for x in aa),len(aa))-Fraction(sum(x<=u for x in bb),len(bb))) for u in set(aa+bb)),default=Fraction(0))


def basis_fixture():
    p,q=1704067200,1711929600
    ends=p+3600*np.array([-5,-4,-3,-2,-1,1,2,3,4],dtype='<i8')
    state=np.array([0,0,1,1,-1,0,0,1,1],dtype='i1')
    current=-np.array([1.,2.,2.,3.,4.,2.,4.,4.,6.],dtype='<f8')
    previous=current/2
    reports={k:{'available':True,'rows':9,'date_rows':[4,5],'state_date_rows':[2,2,2,2,0,1]} for k in ('current','previous')}
    return current,previous,state,ends,p,q,reports


class PureKernel(unittest.TestCase):
    def test_pure_scale_shift_normalizes_to_zero(self):
        r=S.analyze_pair(np.array([2.,4.,6.,8.]),np.array([1.,2.,3.,4.]))
        self.assertEqual(value(r['raw_ks']),Fraction(1,2))
        self.assertEqual(value(r['normalization']['normalized_ks']),0)
        self.assertEqual(r['normalization']['direction'],'reduced')
        self.assertEqual(r['normalization']['median_relative_profiles']['recent'],r['normalization']['median_relative_profiles']['older'])

    def test_same_median_tail_change_retains_distance(self):
        r=S.analyze_pair(np.array([1.,2.,3.,4.,50.]),np.array([1.,2.,3.,4.,5.]))
        self.assertEqual(value(r['raw_ks']),Fraction(1,5))
        self.assertEqual(value(r['normalization']['normalized_ks']),Fraction(1,5))
        self.assertEqual(r['normalization']['direction'],'equal')
        self.assertEqual(value(r['normalization']['median_relative_profiles']['recent'][-1]),Fraction(50,3))

    def test_normalization_can_increase_distance_without_changing_verdict_policy(self):
        a=np.array([2.,3.,100.,101.]);b=np.array([1.,2.,100.,101.])
        r=S.analyze_pair(a,b)
        self.assertEqual(value(r['raw_ks']),Fraction(1,4))
        self.assertEqual(value(r['normalization']['normalized_ks']),Fraction(1,2))
        self.assertEqual(r['normalization']['direction'],'increased')

    def test_unequal_counts_ties_signedzero_and_all_fixed_ranks(self):
        a=np.array([-0.,0.,1.,2.]);b=np.array([0.,1.,1.,2.,3.])
        r=S.analyze_pair(a,b)
        self.assertEqual(value(r['raw_ks']),brute_ks(a,b))
        self.assertEqual([v['probability'] for v in r['quantiles']['recent']],[list(q) for q in S.QUANTILES])
        self.assertEqual([v['rank'] for v in r['quantiles']['recent']],[1,1,2,3,4,4,4])
        self.assertEqual(r['quantiles']['recent'][2]['value_hex'],0.0.hex())
        self.assertFalse(r['normalization']['available'])  # lower-even median is zero.
        self.assertIsNone(r['normalization']['median_relative_profiles'])

    def test_nonpositive_medians_do_not_drop_raw_rows_or_quantiles(self):
        for a in (np.array([-2.,-1.,0.]),np.array([-1.,0.,1.])):
            r=S.analyze_pair(a,np.array([1.,2.,3.]))
            self.assertFalse(r['normalization']['available'])
            self.assertEqual(r['normalization']['reason'],'nonpositive_median')
            self.assertEqual(r['recent_rows'],3)
            self.assertEqual(len(r['quantiles']['recent']),7)
            self.assertEqual(value(r['raw_ks']),brute_ks(a,[1.,2.,3.]))

    def test_negative_oriented_values_remain_valid_without_abs_or_clipping(self):
        a=np.array([-3.,1.,2.,4.,5.]);b=np.array([-2.,1.,2.,3.,4.])
        r=S.analyze_pair(a,b)
        self.assertTrue(r['normalization']['available'])
        self.assertEqual(value(r['quantiles']['recent'][0]['exact_value']),-3)
        self.assertEqual(value(r['normalization']['normalized_ks']),brute_ks(a,b,2.,2.))

    def test_exact_normalized_ratios_survive_float_overflow_tie_collapse(self):
        tiny=np.nextafter(np.float64(0),np.float64(1))
        a=np.array([tiny,tiny,tiny,2.,4.]);b=np.array([tiny,tiny,tiny,1.,2.])
        with np.errstate(over='ignore'):
            self.assertTrue(np.array_equal(a/tiny,b/tiny))
        r=S.analyze_pair(a,b)
        self.assertEqual(value(r['normalization']['normalized_ks']),Fraction(1,5))
        self.assertEqual(value(r['normalization']['normalized_ks']),brute_ks(a,b,tiny,tiny))

    def test_exact_order_oracle_many_small_deterministic_cases(self):
        cases=[([1.,2.,2.,3.],[1.,1.,2.,4.,5.]),([-2.,1.,4.],[-1.,2.,5.,6.]),([1e-300,1.,2.],[2e-300,2.,3.])]
        for aa,bb in cases:
            a,b=np.array(aa),np.array(bb);r=S.analyze_pair(a,b)
            self.assertEqual(value(r['raw_ks']),brute_ks(a,b))
            ma,mb=sorted(a)[(len(a)-1)//2],sorted(b)[(len(b)-1)//2]
            if ma>0 and mb>0:self.assertEqual(value(r['normalization']['normalized_ks']),brute_ks(a,b,ma,mb))

    def test_full_four_pairs_orient_signed_z_and_retain_unknown_provenance(self):
        args=list(basis_fixture());r=S.analyze_basis(*args)
        self.assertEqual(set(r['pairs']),{'current_state_0','current_state_1','previous_state_0','previous_state_1'})
        self.assertEqual(r['target'],'signed_adverse_excursion_X_equals_minus_Z')
        self.assertEqual(r['provenance_counts']['unknown_rows'],1)
        self.assertEqual(sum(r['provenance_counts']['date_rows']),9)
        # A favorable positive Z remains negative adverse-oriented X.
        args[0][0]=3.;r=S.analyze_basis(*args)
        self.assertEqual(value(r['pairs']['current_state_0']['quantiles']['older'][0]['exact_value']),-3)

    def test_complete_typed_finite_arrays_and_accepted_counts_required(self):
        for kind in ('dtype','nonfinite_unknown','count','date','state','order'):
            args=list(basis_fixture())
            if kind=='dtype':args[0]=args[0].astype('f4')
            elif kind=='nonfinite_unknown':args[0][4]=np.nan
            elif kind=='count':args[-1]['current']['state_date_rows'][0]+=1
            elif kind=='date':args[-1]['previous']['date_rows'][0]+=1
            elif kind=='state':args[2][0]=2
            else:args[3][1]=args[3][0]
            with self.subTest(kind=kind),self.assertRaises(ValueError):S.analyze_basis(*args)


class SavedAuthority(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve()
        self.env=mock.patch.dict(os.environ,dict(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1',PYTHONOPTIMIZE='0'))
        self.env.start();self.addCleanup(self.env.stop)

    def write(self,path,obj):path.write_text(json.dumps(obj));return S.pin(path)

    def fixture(self):
        r1=self.root/'old';r1.mkdir();prod=r1/'producer';prod.mkdir()
        cz,pz,state,ends,p,q,reports=basis_fixture();n=len(cz)
        arrays=dict(main_index=np.arange(n,dtype='<i8'),main_label_end=ends,main_state=state,
            D_original=np.where(state==-1,np.nan,0).astype('<f4'),unknown_partition=np.where(state==-1,0,-1).astype('i1'))
        for name,z in [('current',cz),('previous',pz)]:
            arrays.update({name+'_sigma':np.ones(n),name+'_z':z,name+'_valid':np.ones(n,dtype=bool),
                           name+'_knots':np.unique(z),name+'_counts':np.zeros((len(np.unique(z))+1,6),dtype='<i8')})
        np.savez_compressed(prod/'basis.npz',**arrays);basis=S.pin(prod/'basis.npz')
        python=S.pin(Path(sys.executable).resolve());header=S.pin((HERE/'depth_check.py').absolute())
        srcfile=r1/'fake-original-producer.py';srcfile.write_text('# Synthetic saved authority only, never executed.\n');oldsource=S.pin(srcfile)
        runtime=dict(executable=python,python_path=sys.executable,python_version=sys.version.split()[0],
            packages={k:importlib.metadata.version(k) for k in ('numpy','scipy','numba','llvmlite')},
            env=dict(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1',PYTHONOPTIMIZE='0'))
        plan=self.write(r1/'plan.json',dict(schema='q26-fh-date-support-plan-v1',parent_admitted=True,row_capacity=200000,
            runtime=runtime,pilot=dict(previous_cutoff=p,current_cutoff=q)))
        producer=self.write(r1/'request.json',dict(schema='q26-fh-depth-accounting-request-v1',pins=dict(plan=plan,source=oldsource),out=str(prod)))
        started=self.write(prod/'started.json',dict(synthetic=True))
        result=self.write(prod/'result.json',dict(schema='q26-fh-depth-accounting-result-v1',complete=True,reconstruction=True,
            historical_bridge_parity='UNAVAILABLE',cross_vintage_contrast='NOT_COMPUTED',accepted_witness_all_five_bit_identity=True,
            request_sha256=producer['sha256'],request_pins=dict(plan=plan,source=oldsource),source=oldsource,basis=basis,started=started,vintages=reports))
        summary=self.write(r1/'producer-summary.json',dict(synthetic=True))
        acceptance_path=r1/'checker-acceptance.json'
        checker=self.write(r1/'checker-request.json',dict(schema='q26-fh-depth-check-request-v1',pins=dict(plan=plan,
            producer_request=producer,result=result,basis=basis,producer_source=oldsource,checker_source=header,started=started,terminal=summary),out=str(acceptance_path)))
        acceptance=self.write(acceptance_path,dict(schema='q26-fh-depth-check-acceptance-v1',complete=True,reconstruction=True,
            historical_bridge_parity='UNAVAILABLE',result_sha256=result['sha256'],request_sha256=checker['sha256'],checker_source=header,producer_terminal=summary))
        outerpins={}
        for kind,inner,source,output in [('producer',producer,oldsource,str(prod)),('saved_check',checker,header,str(acceptance_path))]:
            argv=[sys.executable,'-B',source['path'],'--request',inner['path'],'--request-sha256',inner['sha256']]
            if kind=='producer':argv+=['--out',output]
            outerpins[kind]=self.write(r1/(kind+'-outer.json'),dict(schema='q26-fh-depth-observer-request-v1',kind=kind,
                fixture_only=False,inner_request=inner,runner=source,argv=argv,output=output,python_pin=python,invocation_python=sys.executable))
        terminals={}
        for kind,source in [('producer',oldsource),('saved_check',header)]:
            terminals[kind]=self.write(r1/(kind+'-terminal.json'),dict(schema='q26-weighted-causal-primary-pair-observer-terminal-v1',
                complete=True,tool_terminal_exit=0,fixture_only=False,process_terminal=True,observer_timeout=False,reason=None,errors=[],
                containment=dict(reaped=True,no_live_members_remaining=True,remaining_live_members=[]),runner=source,request=outerpins[kind]))
        phase=self.write(r1/'phase.json',dict(schema='q26-fh-depth-phase-v1',parent_admitted=True,inner_request=producer,producer_observer_request=outerpins['producer']))
        parent=self.write(r1/'parent.json',dict(schema='q26-depth-parent-acceptance-v1',complete=True,all_final_pins='PASS',result=result,basis=basis,
            independent_acceptance=acceptance,vintages_both_available=True,original_inventory_preserved=True,historical_bridge_parity='UNAVAILABLE',cross_vintage_contrast='NOT_COMPUTED'))
        closed=self.write(r1/'closed.json',dict(schema='q26-depth-phase-closed-v1',status='CLOSED_ACCEPTED',admission_authority=phase,
            parent_acceptance_path=parent['path'],no_running_jobs=True,unused_reused=False,initial_phase_file_is_immutable_admission=True))
        pins=dict(basis=basis,result=result,acceptance=acceptance,parent=parent,closed=closed,phase=phase,producer_request=producer,
            checker_request=checker,producer_terminal=terminals['producer'],checker_terminal=terminals['saved_check'],plan=plan,
            depth_checker_source=header,source=S.pin(Path(S.__file__).absolute()),python=python)
        out=self.root/'report.json';request=dict(schema='q26-fh-scale-shape-request-v1',pins=pins,out=str(out))
        rp=self.write(self.root/'request.json',request)
        return request,rp,out

    def test_positive_auth_reads_only_headers_then_run_decodes_four_arrays(self):
        request,rp,out=self.fixture()
        with mock.patch.object(S.np,'load') as load:S.authenticate(rp['path'],rp['sha256'],out)
        load.assert_not_called()
        original=np.load;seen=[]
        class Saved:
            def __init__(self,a):self.a=a
            def __enter__(self):return self
            def __exit__(self,*args):self.a.close()
            def __getitem__(self,k):
                seen.append(k)
                if k not in ('current_z','previous_z','main_state','main_label_end'):raise AssertionError(k)
                return self.a[k]
        with mock.patch.object(S.np,'load',side_effect=lambda *a,**k:Saved(original(*a,**k))):report=S.run(rp['path'],rp['sha256'],out)
        self.assertEqual(seen,['current_z','previous_z','main_state','main_label_end'])
        self.assertEqual(len(report['analysis']['pairs']),4)
        self.assertEqual(out.stat().st_mode&0o777,0o600)
        with self.assertRaises(ValueError):S.run(rp['path'],rp['sha256'],out)

    def test_bad_closed_authority_or_pin_refuses_before_decode(self):
        request,rp,out=self.fixture()
        body=S.read(request['pins']['closed']['path']);body['status']='ADMITTED_NOT_LAUNCHED'
        request['pins']['closed']=self.write(Path(request['pins']['closed']['path']),body)
        rp=self.write(Path(rp['path']),request)
        with mock.patch.object(S.np,'load') as load,self.assertRaises(ValueError):S.run(rp['path'],rp['sha256'],out)
        load.assert_not_called();self.assertFalse(out.exists())

    def test_traversal_and_old_root_output_refuse_before_decode(self):
        request,rp,out=self.fixture()
        for target in (self.root/'x'/'..'/'bad.json',Path(request['pins']['phase']['path']).parent/'new.json'):
            request['out']=str(target);rp=self.write(Path(rp['path']),request)
            with mock.patch.object(S.np,'load') as load,self.assertRaises(ValueError):S.run(rp['path'],rp['sha256'],target)
            load.assert_not_called()


if __name__=='__main__':unittest.main()
