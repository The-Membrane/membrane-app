import itertools
import json
from fractions import Fraction as F
from pathlib import Path
import tempfile
import unittest
import numpy as np
from interval_arithmetic import Interval as I
from precision_certificate import (replicate_boxes, certified_sd, cgm_certificate, bootstrap_certificate,
                                   z_domain,widen,authenticate,pin,check_pin,exact_counts,TARGETS,DOMAINS,run,
                                   validate_draw_identity,validate_half_geometry,validate_disjoint_bands,validate_reconstruction_layout,EXPECTED_DRAWS)


def q(x):return F(*float(x).as_integer_ratio())

def contains(t,box,value):
    t.assertLessEqual(q(box['lo']),value);t.assertGreaterEqual(q(box['hi']),value)


def exact_cgm(values,mn):
    N=sum(int(x) for x in mn.flat);mu=sum(values,F(0))/N
    a=np.array([(v-mu*int(n))/N for v,n in zip(values,mn.flat)],dtype=object).reshape(mn.shape)
    return sum((sum(row,F(0))**2 for row in a),F(0))+sum((sum(col,F(0))**2 for col in a.T),F(0))-sum((v*v for v in a.flat),F(0))


class CertificateTests(unittest.TestCase):
    def test_absolute_symlink_pin_preserves_lexical_identity(self):
        with tempfile.TemporaryDirectory() as t:
            target=Path(t)/'binary';target.write_bytes(b'qualified binary')
            link=Path(t)/'venv-python';link.symlink_to(target)
            expected=pin(target);expected['path']=str(link)
            self.assertEqual(pin(link),expected)
            observed=check_pin(expected)
            self.assertEqual(observed,{'recorded_path':str(link),'resolved_target':str(target.resolve())})
            self.assertNotEqual(observed['recorded_path'],observed['resolved_target'])
            target.write_bytes(b'changed binary')
            with self.assertRaisesRegex(ValueError,'changed artifact'):check_pin(expected)
            with self.assertRaisesRegex(ValueError,'absolute recorded'):check_pin(dict(expected,path='relative'))

    def test_fixed_target_mapping(self):
        self.assertEqual(TARGETS,[('T24_G0',0,0),('T720_G0',12,0),('T720_G0',12,5),('T168_G3',11,0)])
        self.assertEqual(len(DOMAINS),2)

    def test_unequal_denominators_no_zero_fill(self):
        mn=np.array([[1,3]],dtype=np.int64);box=I([[-1.,3.]])
        ws=np.ones((4,1));wb=np.array([[1,0],[0,1],[1,1],[0,0.]])
        means,den,known=replicate_boxes(box,mn,ws,wb)
        np.testing.assert_array_equal(den,[1,3,4,0]);self.assertFalse(known)
        for i,x in enumerate([F(-1),F(1),F(1,2)]):contains(self,{'lo':means.lo[i],'hi':means.hi[i]},x)
        sd=certified_sd(means)
        self.assertLessEqual(q(sd['intersection'].lo)**2,F(13,12));self.assertGreaterEqual(q(sd['intersection'].hi)**2,F(13,12))
        r=bootstrap_certificate(box,mn,ws,wb)
        self.assertEqual((r['valid'],r['censored_zero_denominator'],r['redrawn']),(3,1,0))

    def test_fraction_corner_means_sd_and_cgm(self):
        mn=np.ones((2,2),dtype=np.int64);lo=np.array([[0.,-1.],[-1.,0.]]);hi=lo+1
        ws=np.array([[2.,0.],[0.,2.],[1.,1.]])
        wb=np.array([[1.,1.],[2.,0.],[0.,2.]])
        r=bootstrap_certificate(I(lo,hi),mn,ws,wb);cgm=cgm_certificate(I(lo,hi),mn)
        for corner in itertools.product(*[(q(a),q(b)) for a,b in zip(lo.flat,hi.flat)]):
            mu=sum(corner,F(0))/4;contains(self,r['mean'],mu)
            a=np.array(corner,dtype=object).reshape(2,2);means=[]
            for u,v in zip(ws,wb):
                den=sum(int(u[s])*int(v[b])*int(mn[s,b]) for s,b in np.ndindex(mn.shape))
                means.append(sum((int(u[s])*int(v[b])*a[s,b] for s,b in np.ndindex(mn.shape)),F(0))/den)
            var=(sum((x*x for x in means),F(0))-sum(means,F(0))**2/3)/2
            sd=r['sample_SD']['intersection'];self.assertLessEqual(q(sd['lo'])**2,var);self.assertGreaterEqual(q(sd['hi'])**2,var)
            contains(self,cgm['signed_net'],exact_cgm(corner,mn))

    def test_proportional_points_prove_zero_sd(self):
        mn=np.array([[1,3]],dtype=np.int64);ws=np.ones((3,1));wb=np.array([[1.,0.],[0.,1.],[1.,1.]])
        r=bootstrap_certificate(I([[.25,.75]]),mn,ws,wb)
        self.assertEqual(r['sample_SD']['intersection'],{'lo':0.,'hi':0.})
        self.assertEqual(r['z']['status'],'zero_SD_undefined_all')
        r=bootstrap_certificate(I([[0.,0.]]),mn,ws,wb);self.assertEqual(r['mean'],{'lo':0.,'hi':0.})

    def test_near_constant_variance_not_lost(self):
        d=2.**-40;s=certified_sd(I([1.,1.+d,1.-d]))
        for k in ['centered','norm_perturbation','intersection']:
            self.assertLessEqual(q(s[k].lo),q(d));self.assertGreaterEqual(q(s[k].hi),q(d))

    def test_cgm_negative_positive_exact_zero_and_crossing(self):
        mn=np.ones((2,2),dtype=np.int64)
        for a,value in [(np.array([[1.,-1.],[-1.,1.]]),F(-1,4)),(np.array([[1.,1.],[-1.,-1.]]),F(1,4)),(np.array([[1.,0.],[-1.,0.]]),F(0))]:
            r=cgm_certificate(I(a),mn);contains(self,r['signed_net'],value)
            if value<=0:self.assertEqual(r['z']['status'],'nonpositive_net_no_positive_CGM_SD')
            if value==0:self.assertEqual(r['signed_net'],{'lo':0.,'hi':0.})
        r=cgm_certificate(I([[-1.,-1.],[-1.,-1.]],[[1.,1.],[1.,1.]]),mn)
        self.assertLess(r['signed_net']['lo'],0);self.assertGreater(r['signed_net']['hi'],0)
        for t in [F(1,2)-F(1,2**30),F(1,2)+F(1,2**30)]:
            a=np.array([[float(F(1,2)+t),float(F(1,2)-t)],[float(-F(1,2)-t),float(-F(1,2)+t)]])
            contains(self,cgm_certificate(I(a),mn)['signed_net'],(F(1,4)-t*t)/4)

    def test_ratio_status_signed_favorable(self):
        r=z_domain(I(1.,2.),I(2.,4.));contains(self,r['signed'],F(1,4));contains(self,r['signed'],F(1))
        self.assertEqual(r['favorable'],{'lo':-r['signed']['hi'],'hi':-r['signed']['lo']})
        self.assertEqual(z_domain(I(0.),I(0.,1.))['signed'],{'lo':0.,'hi':0.})
        self.assertEqual(z_domain(I(1.),I(0.,1.))['signed']['hi'],'+infinity')
        self.assertEqual(z_domain(I(-1.),I(0.,1.))['signed']['lo'],'-infinity')
        self.assertEqual(z_domain(I(-1.,1.),I(0.,1.))['signed'],{'lo':'-infinity','hi':'+infinity'})
        self.assertEqual(z_domain(I(1.),None)['status'],'insufficient_valid_replicates')

    def test_zero_and_one_valid_replicate(self):
        mn=np.array([[1]],dtype=np.int64)
        for w in [np.zeros((2,1)),np.array([[0.],[1.]])]:
            r=bootstrap_certificate(I([[1.]]),mn,w,np.ones((2,1)))
            self.assertIsNone(r['sample_SD']);self.assertEqual(r['z']['status'],'insufficient_valid_replicates')
        with self.assertRaises(ValueError):exact_counts(np.zeros((1,1),dtype=np.int64))

    def test_gamma_widening_zero_counts_and_exact_fraction(self):
        mn=np.array([[0,3]],dtype=np.int64);z=widen(I([[0.,.25]],[[0.,.5]]),mn)
        self.assertEqual((z.lo[0,0],z.hi[0,0]),(0.,0.))
        e=F(6,2**53-2);self.assertLessEqual(q(z.lo[0,1]),F(1,4)-e);self.assertGreaterEqual(q(z.hi[0,1]),F(1,2)+e)

    def test_draw_seed_ordinal_hash_mismatch_refuses(self):
        ws=np.zeros((2000,127));wb=np.zeros((2000,29));record={'common_draw_seed':[20261641,0],
            'ws_sha256':EXPECTED_DRAWS['T24_G0'][1],'wb_sha256':EXPECTED_DRAWS['T24_G0'][2]}
        for ordinal in [1,-1]:
            with self.assertRaisesRegex(ValueError,'ordinal'):validate_draw_identity('T24_G0',ordinal,record,ws,wb)
        wrong=dict(record,common_draw_seed=[20261640,0])
        with self.assertRaisesRegex(ValueError,'seed'):validate_draw_identity('T24_G0',0,wrong,ws,wb)
        wrong=dict(record,ws_sha256='0'*64)
        with self.assertRaisesRegex(ValueError,'hash manifest'):validate_draw_identity('T24_G0',0,wrong,ws,wb)
        with self.assertRaisesRegex(ValueError,'bytes mismatch'):validate_draw_identity('T24_G0',0,record,ws,wb)

    def test_upstream_half_and_disjoint_partition_premises(self):
        rec={'series':[{'fields':{'p_a':{'dtype':'<f2'}}} for _ in range(130)]}
        validate_half_geometry(rec,['a']);rec['series'][0]['fields']['p_a']['dtype']='<f4'
        with self.assertRaisesRegex(ValueError,'half'):validate_half_geometry(rec,['a'])
        validate_disjoint_bands([[0,1,2],[3,4,5,6],[7,8,9]])
        with self.assertRaises(ValueError):validate_disjoint_bands([[0,1,2],[2,3,4,5,6],[7,8,9]])

    def test_actual_pinned_band_request_and_deep_mapping(self):
        bands={'shallow -2..-7%':[0,1,2,3],'mid -10..-20%':[4,5,6],'deep -25..-40%':[7,8,9]}
        request={'bands':bands,'comparisons':[['x','y']],'models':['x','y'],'expected_main_dtype':'<f2'}
        rec={'comparison_order':[['x','y']],'model_order':['x','y'],'groups':[{'key':f'T{h}_G{g}','horizon_hours':h,'band':label}
            for h in [24,72,168,720] for g,label in enumerate(['all']+list(bands))]}
        validate_reconstruction_layout(request,rec)
        wrong=dict(request,bands={'shallow -2..-7%':[0,1,2],'mid -10..-20%':[3,4,5,6],'deep -25..-40%':[7,8,9]})
        with self.assertRaisesRegex(ValueError,'bands mismatch'):validate_reconstruction_layout(wrong,rec)
        rec['groups'][11]['band']='mid -10..-20%'
        with self.assertRaisesRegex(ValueError,'mapping mismatch'):validate_reconstruction_layout(request,rec)

    def test_draft_run_preserves_failure_stage(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'draft.json';p.write_text(json.dumps({'admission_status':'DRAFT'}));out=Path(t)/'failed'
            with self.assertRaisesRegex(ValueError,'DRAFT refuses'):run(p,pin(p)['sha256'],out)
            failure=json.loads((out/'failure.json').read_text());self.assertEqual(failure['stage'],'admission')
            self.assertFalse(failure['complete']);self.assertTrue((out/'resource-receipt.json').exists())

    def test_invalid_weights_and_draft_refuses_before_payload(self):
        mn=np.ones((1,1),dtype=np.int64)
        for w in [np.array([[.5]]),np.array([[np.nan]]),np.array([[2.]])]:
            with self.assertRaises(ValueError):replicate_boxes(I([[1.]]),mn,w,np.ones((1,1)))
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'draft.json';p.write_text(json.dumps({'admission_status':'DRAFT','source_pins':{'forbidden_payload':'/does/not/exist'}}))
            with self.assertRaisesRegex(ValueError,'DRAFT refuses'):authenticate(p,pin(p)['sha256'])


if __name__=='__main__':unittest.main()
