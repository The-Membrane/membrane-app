"""Generated deterministic oracle tests; no empirical inputs or simulation power claims."""
import copy,importlib.util,math,unittest
from datetime import date,timedelta
from fractions import Fraction as F
from pathlib import Path
HERE=Path(__file__)
SOURCE=HERE.with_name('hac_inference.py')
if not SOURCE.exists():SOURCE=HERE.with_name('q26-U-hac-core.py')
SPEC=importlib.util.spec_from_file_location('hac_inference_under_test',SOURCE)
H=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(H)

def days(year):
    end=date(year+1,1,1);start=date(year,1,1)
    return [(start+timedelta(days=i)).isoformat() for i in range((end-start).days)]

def fixture(year,means=(-.08,-.12)):
    ds=days(year);counts=[float(1+i%5) if i%19 else 0.0 for i in range(len(ds))]
    sums=[]
    for i,n in enumerate(counts):
        a=.02*math.sin(2*math.pi*i/31)+.008*math.cos(2*math.pi*i/7)
        b=.03*math.sin(2*math.pi*i/17)+.009*math.cos(2*math.pi*i/11)
        sums.append([n*(means[0]+a),n*(means[1]+.3*a+b)])
    return ds,counts,sums

def year_result(year,means=(-.08,-.12)):
    d,n,s=fixture(year,means)
    return H.qualify_year(year,d,n,s,status=H.READY)

def kernel_oracle(psi,L):
    """Independent exact double-sum lag kernel, not production's lag loop."""
    T=len(psi);out=[[F(0) for _ in range(2)] for _ in range(2)]
    for i in range(T):
        for j in range(T):
            lag=abs(i-j)
            if lag<=L:
                w=F(L+1-lag,L+1)
                for a in range(2):
                    for b in range(2):out[a][b]+=F(psi[i][a])*F(psi[j][b])*w/T
    return out

def window_oracle(psi,L):
    """Independent PSD representation: padded moving-window outer products."""
    T=len(psi);out=[[0.0,0.0],[0.0,0.0]]
    for i in range(T+L):
        v=[math.fsum(psi[j][a] for j in range(max(0,i-L),min(T-1,i)+1)) for a in range(2)]
        for a in range(2):
            for b in range(2):out[a][b]+=v[a]*v[b]/(T*(L+1))
    return out

class HACTest(unittest.TestCase):
    def close_matrix(self,a,b):
        for i in range(2):
            for j in range(2):self.assertAlmostEqual(a[i][j],float(b[i][j]),places=12)
    def test_ratio_is_direct_row_weighted_not_equal_day_mean(self):
        n=[1,3,2,4,1,5,2]
        rows=[[(.02*(i-j),.03*(i+2*j)) for j in range(c)] for i,c in enumerate(n)]
        s=[[math.fsum(v[a] for v in row) for a in range(2)] for row in rows]
        r=H.ratio_hac(n,s,L=2)
        for a,k in enumerate(H.LOSSES):
            direct=math.fsum(v[a] for row in rows for v in row)/sum(n)
            daymean=math.fsum(s[i][a]/n[i] for i in range(len(n)))/len(n)
            self.assertAlmostEqual(r['components'][k]['mean_U'],direct,places=15)
            self.assertNotAlmostEqual(direct,daymean,places=6)
    def test_positive_weight_scaling_and_panel_duplication(self):
        _,n,s=fixture(2024);r=H.ratio_hac(n,s)
        for scale in [.25,2,10]:
            rr=H.ratio_hac([scale*v for v in n],[[scale*v for v in row] for row in s])
            for k in H.LOSSES:
                for f in ['mean_U','se','z','p']:self.assertAlmostEqual(r['components'][k][f],rr['components'][k][f],places=12)
            self.assertEqual(rr['T'],r['T'])
    def test_exact_independent_kernel_and_psd_oracles(self):
        psi=[(2,-1),(-1,2),(0,-2),(1,3),(-2,-2),(0,0)]
        for L in range(len(psi)):
            actual=H.bartlett(psi,L);self.close_matrix(actual,kernel_oracle(psi,L));self.close_matrix(actual,window_oracle(psi,L))
            self.assertEqual(actual[0][1],actual[1][0])
            for v in [(1,0),(0,1),(1,1),(2,-3)]:
                quadratic=sum(v[a]*actual[a][b]*v[b] for a in range(2) for b in range(2))
                self.assertGreaterEqual(quadratic,-1e-12)
    def test_lag0_variance_and_ratio_se(self):
        n=[1,2,4,1,3];s=[[-.1,.2],[.2,-.1],[-.2,.1],[.3,.4],[-.1,-.2]]
        r=H.ratio_hac(n,s,L=0);T=len(n)
        for a,k in enumerate(H.LOSSES):
            mean=math.fsum(row[a] for row in s)/sum(n)
            psi=[row[a]-mean*c for row,c in zip(s,n)]
            expected=math.sqrt(math.fsum(v*v for v in psi))/sum(n)
            self.assertAlmostEqual(r['components'][k]['se'],expected,places=15)
    def test_persistent_common_shock_does_not_get_iid_precision(self):
        n=[1.0]*365;s=[]
        for t in range(365):
            shock=.1*math.sin(2*math.pi*t/96)
            s.append([shock,2*shock+.01*math.cos(2*math.pi*t/11)])
        iid=H.ratio_hac(n,s,L=0);hac=H.ratio_hac(n,s,L=28)
        for k in H.LOSSES:self.assertGreater(hac['components'][k]['se'],2*iid['components'][k]['se'])
        self.assertNotEqual(hac['omega'][0][1],0)
    def test_heteroskedastic_counts_and_zero_days_retained(self):
        d,n,s=fixture(2025);r=H.qualify_year(2025,d,n,s,status=H.READY)
        self.assertEqual(r['T'],365);self.assertEqual(r['occupied_days'],sum(c>0 for c in n));self.assertLess(r['occupied_days'],r['T'])
        for score in r['score_sums']:self.assertAlmostEqual(score,0,places=12)
    def test_calendar_missing_duplicate_reordered_and_wrong_year(self):
        d,n,s=fixture(2024)
        variants=[d[:-1],d[:10]+[d[9]]+d[11:],list(reversed(d)),days(2025)]
        for dd in variants:
            with self.assertRaisesRegex(ValueError,'calendar'):H.qualify_year(2024,dd,n,s,status=H.READY)
        with self.assertRaises(ValueError):H.qualify_year(2026,d,n,s,status=H.READY)
    def test_draft_refuses_before_input_access(self):
        class Forbidden:
            def __len__(self):raise AssertionError('DRAFT touched inputs')
        with self.assertRaisesRegex(ValueError,'DRAFT'):H.qualify_year(2024,Forbidden(),Forbidden(),Forbidden())
    def test_nonfinite_negative_weights_and_bad_shapes_refuse(self):
        for bad in [math.nan,math.inf,-math.inf,True]:
            with self.assertRaises(ValueError):H.ratio_hac([1,bad],[[.1,.1],[.1,.1]])
        with self.assertRaises(ValueError):H.ratio_hac([1,-1],[[.1,.1],[.1,.1]])
        with self.assertRaises(ValueError):H.ratio_hac([1,1],[[.1],[.1]])
        with self.assertRaises(ValueError):H.ratio_hac([1,1],[[math.nan,.1],[.1,.1]])
        with self.assertRaises(ValueError):H.ratio_hac([1,0],[[.1,.1],[.1,.1]])
        with self.assertRaises(ValueError):H.ratio_hac([1,1],[[2,.1],[.1,.1]])
    def test_zero_support_and_degenerate_variance_fail_closed(self):
        with self.assertRaisesRegex(ValueError,'zero support'):H.ratio_hac([0,0],[[0,0],[0,0]])
        with self.assertRaisesRegex(ValueError,'NOT TESTABLE'):H.ratio_hac([1,1,1],[[-.1,-.2]]*3,L=0)
        with self.assertRaisesRegex(ValueError,'NOT TESTABLE'):H.ratio_hac([1,1,1],[[0,.1],[0,-.1],[0,0]],L=0)
    def test_bandwidth_and_covariance_boundary(self):
        self.assertEqual(H.bandwidth(365),28);self.assertEqual(H.bandwidth(366),28);self.assertEqual(H.bandwidth(2),1)
        for L in [-1,2,True]:
            with self.assertRaises(ValueError):H.bartlett([(1,2),(2,1)],L)
        with self.assertRaises(ValueError):H.bandwidth(1)
    def test_normal_tail_direction_ties_and_label(self):
        self.assertEqual(H.normal_cdf(0),.5);self.assertAlmostEqual(H.normal_cdf(-1),.15865525393145707,places=15)
        self.assertAlmostEqual(H.normal_cdf(1),1-H.normal_cdf(-1),places=15)
        self.assertTrue(H.rejection(-1,.05));self.assertFalse(H.rejection(-1,math.nextafter(.05,1)));self.assertFalse(H.rejection(0,0))
        r=year_result(2024);self.assertEqual(r['tail_type'],'ASYMPTOTIC_GAUSSIAN_HAC_PVALUE');self.assertEqual(r['resampling_draws'],0)
    def test_four_component_iut_and_no_selectable_year_loss(self):
        r={'2024':year_result(2024),'2025':year_result(2025)};joint=H.iut4(r);self.assertTrue(joint['joint_reject']);self.assertEqual(len(joint['components']),4)
        for year in ['2024','2025']:
            for a in range(2):
                means=[-.08,-.12];means[a]=.08
                bad=dict(r);bad[year]=year_result(int(year),means)
                j=H.iut4(bad);self.assertFalse(j['joint_reject']);self.assertFalse(j['components'][year+':'+H.LOSSES[a]]['reject'])
        self.assertFalse(joint['power_established']);self.assertFalse(joint['finite_sample_validity_established']);self.assertEqual(joint['empirical_admission_status'],'NOT_ADMITTED')
    def test_iut_rejects_tampered_arithmetic_or_scope(self):
        r={'2024':year_result(2024),'2025':year_result(2025)}
        for field,value in [('p',.123),('z',999),('reject',False)]:
            bad=copy.deepcopy(r);bad['2024']['components']['brier'][field]=value
            with self.assertRaises(ValueError):H.iut4(bad)
        bad=copy.deepcopy(r);bad['2025']['tail_type']='EMPIRICAL_BOOTSTRAP'
        with self.assertRaises(ValueError):H.iut4(bad)
        with self.assertRaises(ValueError):H.iut4({'2024':r['2024']})
    def test_iut_allows_crossloss_correlation_without_independence(self):
        psi=[(1,2),(-1,-2),(2,4),(-2,-4)]
        out=H.bartlett(psi,2)
        self.assertAlmostEqual(out[0][1]**2,out[0][0]*out[1][1],places=12)
        # PSD singularity is allowed when no inverse is needed; each component SE must be positive.
        r=H.ratio_hac([1]*4,[[.1,.2],[-.1,-.2],[.2,.4],[-.2,-.4]],L=2)
        self.assertEqual(r['components']['brier']['p'],.5)

if __name__=='__main__':unittest.main()
