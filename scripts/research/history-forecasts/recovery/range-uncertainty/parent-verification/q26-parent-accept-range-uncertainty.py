import pathlib,json,hashlib,math,time,itertools
from fractions import Fraction
E=pathlib.Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence')
def load(p):return json.loads(pathlib.Path(p).read_text())
def pin(p):
 p=pathlib.Path(p);b=p.read_bytes();return dict(path=str(p),size=len(b),sha256=hashlib.sha256(b).hexdigest())
def check(v):assert pin(v['path'])=={k:v[k] for k in ('path','size','sha256')}
def close(a,b):assert math.isclose(a,b,rel_tol=128*2.220446049250313e-16,abs_tol=128*2.220446049250313e-16),(a,b)
def q(v):
 f=Fraction(v['numerator'],v['denominator']);close(v['value'],float(f));return f
start=time.monotonic();request=E/'r164-range-uncertainty-request-v1.json';assert pin(request)['sha256']=='f4faf08aaf9da70f59ba7c1cd00fbae3a0681497d14dc9d262439376f6d8616f'
r=load(request);folder=pathlib.Path(r['output']);resultpath=folder/'result.json';v=load(resultpath);monitorpath=E/'r164-range-uncertainty-parent-monitor-v1.json';monitor=load(monitorpath)
assert monitor['complete'] is True and monitor['exit_code']==0 and monitor['request']==pin(request) and monitor['output']==pin(resultpath) and monitor['final_admission_pins_unchanged'] is True
assert v['complete'] is True and v['request']==r and len(v['worlds'])==337
for p in r['source_pins']+[r['helper_pin'],r['test_pin'],r['runtime_proof_pin'],r['preserved_draft_pin']]:check(p)
assert (folder/'failure.json').exists() is False and (folder/'fixture').exists() is False
C=('PU','DIS','CAL','CALr','CALb','H_CD','H_CP');records=v['worlds'];worldpins=[];checked_plugins=0;baseline_CGM=0
for ordinal,rec in enumerate(records):
 law='independent' if ordinal<256 else 'shared';index=ordinal if ordinal<256 else ordinal-256;assert (rec['law'],rec['index'])==(law,index)
 if law=='independent':
  bits=[(index>>(7-i))&1 for i in range(8)];y=[bits[2*b:2*b+2] for b in range(4)];w=Fraction(math.prod(((1 if a else 3) if j%2==0 else (3 if a else 1)) for j,a in enumerate(bits)),4**8)
 else:
  digits=[(index//3**j)%3 for j in (3,2,1,0)];y=[[(0,0),(0,1),(1,1)][j] for j in digits];w=Fraction(math.prod(2 if a==1 else 1 for a in digits),4**4)
 assert Fraction(*rec['weight'])==w
 check(rec['output_pin']);worldpins.append(rec['output_pin']);actual=load(rec['output_pin']['path']);assert actual==dict(nominal=.9,target='realized_group_frequency',T2_target='pooled_calibration_frequency',cells=[rec['cell']])
 cell=rec['cell'];assert (cell['T'],cell['tier'],cell['level'],cell['n_rows'],cell['n_groups'],cell['n_blocks'])==('1d','alts',0,640,40,4) and set(cell['constructions'])==set(C)
 close(cell['base_rate'],sum(sum(a) for a in y)/8)
 for left,right in [('PU','DIS'),('CAL','CALr'),('H_CD','H_CP')]:
  aa={k:x for k,x in cell['constructions'][left].items() if k!='coverage_ci90'};bb={k:x for k,x in cell['constructions'][right].items() if k!='coverage_ci90'};assert aa==bb
 assert [p['construction'] for p in rec['part_b']]==list(C)
 for c,p in zip(C,rec['part_b']):
  a=cell['constructions'][c];count=rec['covered_counts'][c];assert isinstance(count,int) and 0<=count<=40 and a['n_groups']==40 and a['rows_with_range']==640
  close(a['coverage_groups'],count/40);close(a['coverage_rows'],count/40);ci=a['coverage_ci90'];assert len(ci)==2 and 0<=ci[0]<=ci[1]<=1
  exact=Fraction(*rec['exact_CGM'][c]['net']);assert rec['exact_CGM'][c]['sign']==((exact>0)-(exact<0));se=a['coverage_se_cgm']
  if se is None:assert exact<=0
  else:assert math.isfinite(se) and se>0 and exact>=0;close(se*se,float(exact))
  assert rec['exact_CGM'][c]['source_positive_on_exact_zero']==(exact==0 and se is not None)
  scale=(ci[1]-ci[0])/3.29;pw=(1. if abs(a['coverage_groups']-.9)<.05 else 0.) if scale<=0 else max(0.,(1+math.erf(((.05-(a['coverage_groups']-.9))/scale-1.6449)/math.sqrt(2)))/2+(1+math.erf(((.05+(a['coverage_groups']-.9))/scale-1.6449)/math.sqrt(2)))/2-1)
  width=float(a['width_median_pts']<=10);assert (p['T'],p['tier'],p['level'])==('1d','alts',0)
  for key,expected in [('coverage_dev',a['coverage_groups']),('se_proj',scale),('tost_power',pw),('width_median_pts',a['width_median_pts']),('width_leg',width),('joint',pw*width)]:close(p[key],expected)
  checked_plugins+=1
  if c in ('PU','DIS'):
   cov=[[(1-y[b][0]),y[b][1]] for b in range(4)];ncover=5*sum(sum(z) for z in cov);assert count==ncover
   assert a['width_median_pts']==a['width_p90_pts']==50. and a['share_width_lt10pts']==0.;close(a['interval_score_pts'],50+1000*(1-count/40))
   # Integer score formula from this law's known baseline coverage grid.
   sg=[0]*5;bl=[0]*4;inter=[[0]*4 for _ in range(5)]
   for g in range(5):
    for b in range(4):
     for k in range(2):
      u=40*cov[b][k]-ncover;sg[g]+=u;bl[b]+=u;inter[g][b]+=u
   want=Fraction(sum(z*z for z in sg)+sum(z*z for z in bl)-sum(z*z for a0 in inter for z in a0),40**4);assert exact==want;baseline_CGM+=1
assert {p.name for p in (folder/'worlds').iterdir()}=={pathlib.Path(p['path']).name for p in worldpins}
for law in ('independent','shared'):
 rr=[x for x in records if x['law']==law];weights=[Fraction(*a['weight']) for a in rr];assert sum(weights)==1
 for c in C:
  summary=v['summary'][law][c];data=[Fraction(a['covered_counts'][c],40) for a in rr];theta=sum(w*x for w,x in zip(weights,data));var=sum(w*(x-theta)**2 for w,x in zip(weights,data));assert q(summary['theta'])==theta and q(summary['variance'])==var
  close(summary['SD'],math.sqrt(float(var)))
  contains=sum(w for w,a in zip(weights,rr) if Fraction.from_float(a['cell']['constructions'][c]['coverage_ci90'][0])<=theta<=Fraction.from_float(a['cell']['constructions'][c]['coverage_ci90'][1]));assert q(summary['CI_inclusion_mass'])==contains
  null=sum(w for w,a in zip(weights,rr) if a['cell']['constructions'][c]['coverage_se_cgm'] is None);assert q(summary['CGM_null_mass'])==null
  exmean=sum(w*Fraction(*a['exact_CGM'][c]['net']) for w,a in zip(weights,rr));assert q(summary['exact_CGM_net_weighted_mean'])==exmean
  if var:close(summary['exact_mean_CGM_net_over_world_variance'],float(exmean/var))
  else:assert summary['exact_mean_CGM_net_over_world_variance'] is None
  for sign in (-1,0,1):assert q(summary['exact_CGM_sign_mass'][str(sign)])==sum(w for w,a in zip(weights,rr) if a['exact_CGM'][c]['sign']==sign)
  assert q(summary['source_positive_SE_on_exact_zero_mass'])==sum(w for w,a in zip(weights,rr) if a['exact_CGM'][c]['source_positive_on_exact_zero'])
  msse=math.fsum(float(w)*a['cell']['constructions'][c]['coverage_se_cgm']**2 for w,a in zip(weights,rr) if a['cell']['constructions'][c]['coverage_se_cgm'] is not None);close(summary['CGM_positive_SE_square_weighted_sum'],msse)
  if null==1:assert summary['CGM_positive_only_mean_square_SE'] is None
  else:close(summary['CGM_positive_only_mean_square_SE'],msse/float(1-null))
  assert summary['positive_only_is_unconditional_variance_calibration'] is False
  for field in ('coverage_dev','se_proj','tost_power','width_median_pts','width_leg','joint'):
   masses={}
   for w,a in zip(weights,rr):
    value=next(x[field] for x in a['part_b'] if x['construction']==c);masses[value]=masses.get(value,Fraction(0))+w
   got=summary['original_part_b_descriptor'][field];assert {x['value']:Fraction(*x['weight']) for x in got['distribution']}==masses;close(got['weighted_mean'],math.fsum(float(w)*value for value,w in masses.items()))
  if c in ('PU','DIS'):assert theta==Fraction(3,4) and var==(Fraction(3,128) if law=='independent' else Fraction(1,64))
for p in r['source_pins']+[r['helper_pin'],r['test_pin'],r['runtime_proof_pin']]:check(p)
value=dict(schema='codex-parent-r164-range-uncertainty-admission-v1',complete=True,request=pin(request),result=pin(resultpath),monitor=pin(monitorpath),world_outputs=337,construction_worlds=2359,law_construction_aggregates=14,PartB_descriptors_checked=checked_plugins,analytical_baseline_CGM_worlds=baseline_CGM,source_patch_sha256='bb413ddd72ac938b52210c1fff52b5373aff9ac9074dd33b6f55edfd922657c5',elapsed_seconds=time.monotonic()-start,verification='All337 original-output pins/records, exact world weights and law moments/CI inclusion/null/sign masses; all2359 PartB descriptors; all674 analytic PU/DIS coverage/score/CGM grids; endpoint-identical point metrics. Full all-world CAL/CALb metric reconciliation is performed by separately reviewed frozen helper/reference, not independently reimplemented here.',limitations='Four-block finite synthetic fixed-seed downstream stress; no upstream HAR-refit, market power/calibration, latent individual interval, strict-forward forecast, original LP correction, reserve, model/promotion or NOT RUN change.')
with (E/'parent-r164-range-uncertainty-admission-v1.json').open('x') as f:json.dump(value,f,indent=2,allow_nan=False)
print(json.dumps(value))
