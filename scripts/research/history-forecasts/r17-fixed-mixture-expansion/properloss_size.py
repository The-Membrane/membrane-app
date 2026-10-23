"""Frozen generated-size comparison only. DRAFT refuses; no data/provider loader."""
import argparse,functools,gzip,hashlib,json,math,os,platform,random,sys,time,types
from pathlib import Path
HERE=Path(__file__).resolve().parent
GEN=(HERE/'properloss_generator.py')if (HERE/'properloss_generator.py').exists()else Path('/private/tmp/q26-o186-properloss-generator.py')
FIXED=(HERE/'fixedb_inference.py')if (HERE/'fixedb_inference.py').exists()else Path('/private/tmp/q26-o186-fixedb-core.py')
PROTOCOL=(HERE/'properloss_prospective.json')if (HERE/'properloss_prospective.json').exists()else Path('/private/tmp/q26-o186-properloss-prospective-v2.json');PROTOCOL_SHA='c9661fa427adb4915f5313e28b5de3e93081f0d19831df0b7d6ec165afb873b5'
ROOT=Path('/private/tmp/q26-o186-properloss-run-v1');READY='READY_PARENT_REVIEWED_O186_GENERATED_SIZE_STRESS'
FIXED_SHA='f5b706b15cb2cab4c9551602f2ab2020274052414ed3aa3687b3a25c7e15984c';LEGACY=(HERE/'hac_size.py')if (HERE/'hac_size.py').exists()else Path('/private/tmp/q26-hac-size-simulation.py');LEGACY_SHA='436ba09506f3ba97c1a6e911d5323f3ad9fe5c7de172294baca741aa37c40683'
FAMILY=72;MC_TAIL=.01/(2*FAMILY);LIMITS={'wall_seconds':180,'CPU_seconds':175,'OS_peak_RSS_bytes':268435456,'whole_output_bytes':2097152,'logical_archive_bytes':8388608,'reserve_bytes':536870912}
def need(x,m):
 if not x:raise ValueError(m)
def pin(p):
 p=Path(p);h=hashlib.sha256()
 with p.open('rb')as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return {'path':str(p),'size':p.stat().st_size,'sha256':h.hexdigest()}
def verify(p):need(pin(p['path'])==p,'immutable pin')
def load(p,name):
 verify(p);b=Path(p['path']).read_bytes();need(hashlib.sha256(b).hexdigest()==p['sha256'],'compile exact bytes');m=types.ModuleType(name);m.__file__=p['path'];exec(compile(b,p['path'],'exec'),m.__dict__);return m
def enc(v):return (json.dumps(v,separators=(',',':'),allow_nan=False)+'\n').encode()
def write(p,b):
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb')as f:f.write(b)
@functools.lru_cache(maxsize=512)
def binomial_interval(k,n,tail=MC_TAIL):
 """Same O185 inversion, explicit new72-family tail; old module never patched."""
 need(type(k)is int and type(n)is int and 0<=k<=n and n>0,'binomial domain');need(type(tail)is float and 0<tail<.5,'tail domain')
 lc=[math.lgamma(n+1)-math.lgamma(i+1)-math.lgamma(n-i+1)for i in range(n+1)]
 def cdf(j,p):
  if p==0:return 1.
  if p==1:return float(j>=n)
  lp=math.log(p);lq=math.log1p(-p);return math.fsum(math.exp(lc[i]+i*lp+(n-i)*lq)for i in range(j+1))
 def inverse(j,target):
  lo=0.;hi=1.
  for _ in range(52):
   mid=(lo+hi)/2
   if cdf(j,mid)>target:lo=mid
   else:hi=mid
  return (lo+hi)/2
 return [0. if k==0 else inverse(k-1,1-tail),1. if k==n else inverse(k,tail)]
def evaluate_pair(g,core,fixed,years):
 """One shared ratio/HAC computation per year, never fixed.evaluate()."""
 masks=[0,0];refusal=0;stats={};reasons={}
 for yi,year in enumerate((2024,2025)):
  x=years[year]
  try:r=core.ratio_hac(x['counts'],x['sums'],L=28)
  except ValueError as e:
   if str(e)not in ('zero support','numerically degenerate HAC score: NOT TESTABLE','zero/negative HAC variance: NOT TESTABLE'):raise
   refusal|=3<<(yi*2);reasons[str(year)]=str(e);continue
  critical=fixed.critical_value(r['T'])['critical_right_95'];need(r['bandwidth']==28,'unchanged lag')
  vs=[r['components'][loss]for loss in g.LOSSES];stats[str(year)]={'T':r['T'],'N':r['N'],'occupied_days':r['occupied_days'],'L':r['bandwidth'],'means':[v['mean_U']for v in vs],'se':[v['se']for v in vs],'z':[v['z']for v in vs]}
  for li,v in enumerate(vs):
   bit=1<<(2*yi+li)
   if v['reject']:masks[0]|=bit
   if fixed.compare(v['mean_U'],v['z'],critical):masks[1]|=bit
 if refusal:refusal|=16
 for mi in (0,1):
  if not refusal and masks[mi]&15==15:masks[mi]|=16
 return {'gaussian_mask':masks[0],'fixed_b_mask':masks[1],'refusal_mask':refusal,'shared_year_statistics':stats,'refusals':reasons}
def reduce_masks(g,records,expected_reps=1000):
 need(type(expected_reps)is int and 0<expected_reps<=1000,'reps');index={};nulls={(x['method'],x['configuration'],x['cell'])for x in g.null_diagnostic_cells()};need(len(nulls)==72,'exact family')
 for r in records:
  key=(r['configuration'],r['replicate']);need(key not in index,'duplicate replicate');need(type(r['replicate'])is int and 0<=r['replicate']<expected_reps,'replicate range')
  for k in ('gaussian_mask','fixed_b_mask','refusal_mask'):need(type(r[k])is int and 0<=r[k]<32,'fivebit mask')
  for k in ('gaussian_mask','fixed_b_mask'):
   need(not(r[k]&r['refusal_mask']),'refused cells cannot reject');need(bool(r[k]&16)==(not r['refusal_mask']and r[k]&15==15),'IUT exact fourcomponent conjunction')
  need(not(r['fixed_b_mask']&~r['gaussian_mask']),'fixed-b rejection must be subset Gaussian');index[key]=r
 need(set(index)=={(x['id'],i)for x in g.CONFIGS for i in range(expected_reps)},'allfixedreplicates noomit/noextra')
 anyrefusal=any(r['refusal_mask']for r in records);cells=[];labels=('2024:brier','2024:bounded_logloss','2025:brier','2025:bounded_logloss','IUT4')
 for cfg in g.CONFIGS:
  rr=[index[(cfg['id'],i)]for i in range(expected_reps)]
  for method,maskkey in zip(g.METHODS,('gaussian_mask','fixed_b_mask')):
   for bit,label in enumerate(labels):
    k=sum(bool(r[maskkey]&(1<<bit))for r in rr);refused=sum(bool(r['refusal_mask']&(1<<bit))for r in rr);isnull=(method,cfg['id'],label)in nulls
    ci=binomial_interval(k,expected_reps,MC_TAIL if isnull else .025);worst=binomial_interval(k+refused,expected_reps,MC_TAIL if isnull else .025)
    cells.append({'method':method,'configuration':cfg['id'],'cell':label,'rejections':k,'fixed_denominator':expected_reps,'refusals':refused,'true_upper_null_diagnostic':isnull,'interpretation':'UPPER_NULL_REJECTION_NOT_FALSE_ACTUAL_IMPROVEMENT'if cfg['missing']=='independent'else('TRUE_NULL_REJECTION'if isnull else'ALTERNATIVE_REJECTION_RATE_DESCRIPTIVE_NOT_QUALIFIED_POWER'),'interval':ci,'worst_case_reject_plus_refusal':k+refused,'worst_case_interval':worst,'refusal_envelope_interval':[ci[0],worst[1]],'interval_scope':'PRIMARY_LOWER_REJECTION_UPPER_REJECTION_PLUS_REFUSAL_ENVELOPE_SIMULTANEOUS99_PERCENT_FAMILY72'if isnull else'DESCRIPTIVE_UNADJUSTED95_PERCENT_NOT_SIZE','supplementary_CP_intervals_not_joint99percent_for_two_families':True,'oversize_flag':(ci[0]>.05)if ci is not None and isnull else None})
 need(sum(x['true_upper_null_diagnostic']for x in cells)==72,'only72null diagnostics');return {'execution_complete':True,'complete_without_refusals':not anyrefusal,'refusal_replicates':sum(bool(r['refusal_mask'])for r in records),'refusal_policy':'NONREJECTION_NO_OMISSION_NO_REDRAW_WITH_WORST_CASE_SENSITIVITY','all_fixed_replicates_retained':True,'replicate_records':len(records),'true_null_family_size':72,'total_reported_cells':80,'cells':cells,'empirical_admission':False,'finite_size_validity_established':False,'forecast_improvement_claim':False}
def runtime_snapshot():
 paths={str(Path(sys.executable).resolve()),str(Path(random.__file__).resolve())}
 for m in tuple(sys.modules.values()):
  p=getattr(m,'__file__',None)
  if p and Path(p).is_file()and (p.endswith(('.so','.dylib'))):paths.add(str(Path(p).resolve()))
 return {'version':sys.version,'platform':platform.platform(),'invocation_path':sys.executable,'used_file_pins':[pin(p)for p in sorted(paths)]}
def prepare(path):
 need(pin(PROTOCOL)['sha256']==PROTOCOL_SHA,'frozen protocol');protocol=json.loads(PROTOCOL.read_bytes());gp=pin(GEN);need(gp['sha256']==protocol['source_authorities']['generator']['sha256'],'generator hash');g=load(gp,'properloss_generator');corep=pin(g.CORE);need(corep['sha256']==g.CORE_SHA,'HAC core');need(pin(FIXED)['sha256']==FIXED_SHA and pin(LEGACY)['sha256']==LEGACY_SHA,'references')
 fixed=load(pin(FIXED),'fixed_b');core=load(corep,'core');del fixed,core
 q={'schema':'q26-o186-generated-size-request-v1','status':'DRAFT_NOT_ADMITTED','source':pin(__file__),'pins':{'generator':gp,'core':corep,'fixed_b':pin(FIXED),'legacy_CP':pin(LEGACY),'protocol':pin(PROTOCOL)},'replicates':1000,'configuration_ids':[x['id']for x in g.CONFIGS],'null_family_size':72,'out':str(ROOT),'limits':LIMITS,'runtime_pins':runtime_snapshot()};q['files']=[q['source']]+list(q['pins'].values());write(path,enc(q));return pin(path)
def authenticate(path,sha,selfsha,admitted):
 need(admitted,'DRAFT: no main simulation');cp=pin(path);need(cp['sha256']==sha,'external request hash');need(pin(__file__)['sha256']==selfsha,'external driver hash');q=json.loads(Path(path).read_bytes());need(q['schema']=='q26-o186-generated-size-request-v1'and q['status']==READY,'READY required');need(q['source']==pin(__file__)and q['out']==str(ROOT)and q['limits']==LIMITS,'fixed source/root/limits');need(q['replicates']==1000 and q['null_family_size']==72,'fixed reps/family')
 for p in q['files']+q['runtime_pins']['used_file_pins']:verify(p)
 need(q['files']==[q['source']]+list(q['pins'].values()),'exact source closure');need(q['runtime_pins']['version']==sys.version and q['runtime_pins']['platform']==platform.platform(),'runtime metadata')
 need(q['pins']['protocol']['sha256']==PROTOCOL_SHA and q['pins']['fixed_b']['sha256']==FIXED_SHA and q['pins']['legacy_CP']['sha256']==LEGACY_SHA,'fixed protocol/helper authorities');protocol=json.loads(Path(q['pins']['protocol']['path']).read_bytes());need(q['pins']['generator']['sha256']==protocol['source_authorities']['generator']['sha256']and q['pins']['core']['sha256']==protocol['source_authorities']['core']['sha256'],'scientific source authorities');return q,cp
def run(path,sha,selfsha,admitted):
 q,cp=authenticate(path,sha,selfsha,admitted);need(not ROOT.exists(),'fresh outputroot');need(__import__('shutil').disk_usage(ROOT.parent).free>=LIMITS['reserve_bytes']+LIMITS['whole_output_bytes'],'reserve');g=load(q['pins']['generator'],'properloss_generator');core=load(q['pins']['core'],'core');fixed=load(q['pins']['fixed_b'],'fixed_b');need(q['configuration_ids']==[x['id']for x in g.CONFIGS],'exact configs');ROOT.mkdir(mode=0o700);started=time.monotonic();records=[]
 for cfg in g.CONFIGS:
  for rep in range(1000):
   years=g.generate_replicate(cfg['id'],rep,status=g.READY);v=evaluate_pair(g,core,fixed,years);records.append({'configuration':cfg['id'],'replicate':rep,**v})
  print(json.dumps({'configuration_completed':cfg['id'],'replicates':1000}),file=sys.stderr,flush=True)
 report=reduce_masks(g,records);report.update(schema='q26-o186-generated-size-report-v1',scope='GENERATED_PROPERLOSS_UPPER_NULL_ONLY',request_sha256=sha,source_synthetic_component=True,elapsed_seconds=time.monotonic()-started,limits='No market, fH forecast, real missingness, application-law, power or admission qualification.')
 archive={'schema':'q26-o186-generated-size-masks-v1','request_sha256':sha,'methods':g.METHODS,'bit_order':['2024:brier','2024:bounded_logloss','2025:brier','2025:bounded_logloss','IUT4'],'configuration_order':q['configuration_ids'],'records':records};logical=enc(archive);need(len(logical)<=LIMITS['logical_archive_bytes'],'logical archive cap');compressed=gzip.compress(logical,mtime=0);rb=enc(report);need(len(compressed)+len(rb)<=LIMITS['whole_output_bytes'],'prewrite physical cap');write(ROOT/'decisions.json.gz',compressed);write(ROOT/'report.json',rb)
 for p in q['files']+q['runtime_pins']['used_file_pins']+[cp]:verify(p)
 need(__import__('shutil').disk_usage(ROOT).free>=LIMITS['reserve_bytes'],'final reserve');print(json.dumps({'schema':'q26-o186-generated-size-produced-v1','complete':report['execution_complete'],'request_sha256':sha,'archivepin':pin(ROOT/'decisions.json.gz'),'reportpin':pin(ROOT/'report.json'),'main_replicates':len(records),'no_empirical_admission':True}))
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--prepare');a.add_argument('--request');a.add_argument('--request-sha256');a.add_argument('--script-sha256');a.add_argument('--admitted',action='store_true');x=a.parse_args()
 if x.prepare:print(json.dumps({'request':prepare(x.prepare),'status':'DRAFT_NOT_ADMITTED'}))
 else:run(x.request,x.request_sha256,x.script_sha256,x.admitted)
