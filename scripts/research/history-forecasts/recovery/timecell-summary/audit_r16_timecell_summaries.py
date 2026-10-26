"""Fixed posthoc projection/aggregation of accepted JSON metrics only; no outcome arrays."""
from __future__ import annotations
import argparse,ast,hashlib,json,math,platform,resource,shutil,sys,time
from pathlib import Path
import numpy as np
E=Path(__file__).resolve().parent
SCHEMA='codex-r16-timecell-summary-v1';MODELS=('nmlp','ngru','ntcn','ntfm','nmlp0')
SOURCE={'nn_source':'637915e982b961029dcd5b3b69dc6903564f2482fbfd604d2330c88e1cf68f20','dev_source':'702cedb98c7cfcfe77985c5f75073ec2a6f09a9a3e9dd97747328e42018ae29f'}
DESC_SHA='4d97868a55511e536d98dabd1e6ab6370b363c0003341c39cd62a7fc3f4f7703'
IDENTITIES=dict(scope_sha256='807f6d2a283ac7af9f72a7b3ea2eb251a42414efce09fe16ebd957f56f60ef30',independent_fit_sha256='a677bb1a34d0280f5984a183e613512503579968f91d2d030051f4281d080052',score_output_sha256='f9d45e151d1ee6ce38949db32f6d651f390c19b8b2f210a5b33968c1a082c112')
POLICY=dict(rss_bytes=1000000000,disk_reserve_bytes=2000000000,wall_seconds=60,output_bytes=1000000)
CELL_FIELDS=('model','hash_half','time_half','horizon_hours','barrier','n','observed_count','observed_rate','predicted_mean','reference_predicted_mean','brier_model','brier_fH','brier_difference','model_calibration_ratio','fH_calibration_ratio','mean_abs_probability_deviation_fH','max_abs_probability_deviation_fH','fraction_exactly_identical_fH','fraction_within_1e_6_fH')
LIMITS='Fixed posthoc ALL240 existing accepted JSON records, no new NPZ/outcome/prediction access or model fit. All120 hash-merged model/time/labels retained. Mean12 label BSS differs from exposure-weighted pooled BSS; label exposure counts repeat origins across thresholds/horizons and are not independent episodes. R=sumPred/sumObserved, null when observed=0; BSS null for zero reference SSE. No new E2 gate, ranking, selection, tuning, promotion, p-values or causal timing interpretation. Original shared tier RNG and seen-data model/tuning selection remain. Late membership and validation timestamp arithmetic does not constitute strict-forward validation. Original scores remain retrospective; O14/LP/reserve holds unchanged. Private descriptor evidence_pins manifest is excluded, never copied into output.'
class SummaryFailure(ValueError):
 def __init__(self,code,message):super().__init__(message);self.code=code
def need(v,code,message):
 if not v:raise SummaryFailure(code,message)
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def pin(p):
 p=Path(p).resolve();return dict(path=str(p),size=p.stat().st_size,sha256=sha(p))
def check_pin(p):
 need(isinstance(p,dict) and {'path','size','sha256'}<=set(p),'MISSING_PIN','complete artifact pin required');f=Path(p['path']);need(f.is_file() and not f.is_symlink() and f.stat().st_size==p['size'] and sha(f)==p['sha256'],'PIN_CHANGED','artifact changed: '+str(f))
def runtime():return dict(python=sys.version,executable=str(Path(sys.executable).resolve()),prefix=sys.prefix,platform=platform.platform(),numpy=np.__version__)
def labels_from_source(path):
 need(sha(path)==SOURCE['dev_source'],'SOURCE_CHANGED','frozen dev source differs');tree=ast.parse(Path(path).read_text());node=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='LV' for t in n.targets));lv=ast.literal_eval(node.value);return tuple((T,float(k)) for T in (1,3,12) for k in lv[T])
def close(a,b):return math.isclose(a,b,rel_tol=1e-11,abs_tol=1e-13)
def authenticate(request,digest):
 need(sha(request)==digest,'REQUEST_CHANGED','request identity changed');r=json.loads(Path(request).read_text());need(r.get('admission_status')=='parent_accepted','DRAFT_NOT_ADMITTED','parent source/tests/refutation review required before aggregation')
 expected={'implementation','tests','nn_source','dev_source','runtime_proof','accepted_descriptive','temporal_result','temporal_parent_acceptance'}
 need(r.get('schema')==SCHEMA and r.get('policy')==POLICY and set(r['artifacts'])==expected,'PROTOCOL_CHANGED','fixed all-cell protocol differs')
 for p in r['artifacts'].values():check_pin(p)
 need(Path(r['artifacts']['implementation']['path']).resolve()==Path(__file__).resolve(),'IMPLEMENTATION_PATH','executed source must be pinned');need(r['runtime']==runtime() and 'torch' not in sys.modules,'RUNTIME_CHANGED','runtime differs or Torch imported')
 for k,s in SOURCE.items():need(r['artifacts'][k]['sha256']==s,'SOURCE_CHANGED','frozen original source differs')
 need(r['artifacts']['accepted_descriptive']['sha256']==DESC_SHA,'DESCRIPTIVE_IDENTITY','only accepted original descriptor admitted')
 d=json.loads(Path(r['artifacts']['accepted_descriptive']['path']).read_text());t=json.loads(Path(r['artifacts']['temporal_result']['path']).read_text());a=json.loads(Path(r['artifacts']['temporal_parent_acceptance']['path']).read_text())
 need(d.get('complete') is True and t.get('complete') is True and a.get('complete') is True and a['result']==r['artifacts']['temporal_result'] and a['cells']==4 and a['support_blocks_verified']==36,'CENSUS_NOT_ACCEPTED','complete bound O66 census required')
 need(all(d.get(k)==v for k,v in IDENTITIES.items()),'ORIGINAL_IDENTITIES','original scope/fit/score identities differ')
 for k in SOURCE:need(d['source_sha256'].get(r['artifacts'][k]['path'])==SOURCE[k],'DESCRIPTOR_SOURCE','descriptor original source pin mismatch')
 labels=labels_from_source(r['artifacts']['dev_source']['path']);need(r['labels']==[list(x) for x in labels] and len(labels)==12,'LABEL_PROTOCOL','exact source-derived12 labels required');return r,d,t,labels

def validate(d,t,labels):
 cells=d['cells'];need(len(cells)==240,'CELL_CLOSURE','exact240 cells required');expected={(m,h,q,T,k) for m in MODELS for h in (0,1) for q in (0,1) for T,k in labels};seen={};reference={};geometry={tuple(c['cell']):c for c in t['cells']};need(set(geometry)=={(h,q) for h in (0,1) for q in (0,1)},'CENSUS_GEOMETRY','four unique temporal cells required');need(d['tsplit_float']==t['pooled_median_origin'],'CENSUS_SPLIT','original pooled median differs')
 for c in cells:
  need(set(c)==set(CELL_FIELDS),'CELL_SCHEMA','exact projected cell schema required');key=tuple(c[k] for k in ('model','hash_half','time_half','horizon_hours','barrier'));need(key in expected and key not in seen,'CELL_CLOSURE','unexpected/duplicate cell');seen[key]=c;n=c['n'];y=c['observed_count'];need(type(n) is int and n>0 and type(y) is int and 0<=y<=n,'COUNTS','positive integer support and bounded positives required')
  for k in ('observed_rate','predicted_mean','reference_predicted_mean','brier_model','brier_fH','mean_abs_probability_deviation_fH','max_abs_probability_deviation_fH','fraction_exactly_identical_fH','fraction_within_1e_6_fH'):need(isinstance(c[k],(float,int)) and math.isfinite(c[k]) and 0<=c[k]<=1,'METRIC_RANGE','finite unit interval metric required')
  need(close(c['observed_rate'],y/n) and close(c['brier_difference'],c['brier_model']-c['brier_fH']),'METRIC_ARITHMETIC','Brier/rate arithmetic inconsistent')
  for ratio,pred in [('model_calibration_ratio','predicted_mean'),('fH_calibration_ratio','reference_predicted_mean')]:
   need(c[ratio] is None if y==0 else isinstance(c[ratio],(int,float)) and math.isfinite(c[ratio]) and close(c[ratio],c[pred]/(y/n)),'RATIO_ARITHMETIC','R must be predicted/observed rate or null')
  h,q,T,k=key[1:];need(n==geometry[h,q]['test']['by_horizon'][str(T)] and n==d['daily_cell_counts'][str(T)][f'{h},{q}'],'CENSUS_COUNTS','descriptor support differs from O66 horizon geometry')
  ref=(n,y,c['observed_rate'],c['reference_predicted_mean'],c['brier_fH']);rk=(h,q,T,k)
  if rk in reference:need(ref[:2]==reference[rk][:2] and all(close(a,b) for a,b in zip(ref[2:],reference[rk][2:])),'REFERENCE_CONSISTENCY','shared reference/count differs across models')
  else:reference[rk]=ref
 need(set(seen)==expected,'CELL_CLOSURE','missing original cell');return seen

def BSS(sse,reference):return 1-sse/reference if reference>0 else None
def aggregate(d,t,labels):
 seen=validate(d,t,labels);projected=[];merged=[];summaries=[]
 for c in d['cells']:
  p={k:c[k] for k in CELL_FIELDS};p['derived_BSS']=BSS(c['brier_model'],c['brier_fH']);p['BSS_status']='defined' if c['brier_fH']>0 else 'zero_reference_Brier';projected.append(p)
 for m in MODELS:
  for q in (0,1):
   rows=[]
   for T,k in labels:
    pair=[seen[m,h,q,T,k] for h in (0,1)];n=sum(c['n'] for c in pair);y=sum(c['observed_count'] for c in pair);sm=math.fsum(c['n']*c['brier_model'] for c in pair);sf=math.fsum(c['n']*c['brier_fH'] for c in pair);pm=math.fsum(c['n']*c['predicted_mean'] for c in pair);pf=math.fsum(c['n']*c['reference_predicted_mean'] for c in pair)
    row=dict(model=m,time_half=q,horizon_hours=T,barrier=k,n=n,observed_count=y,model_SSE=sm,fH_SSE=sf,model_prediction_sum=pm,fH_prediction_sum=pf,brier_model=sm/n,brier_fH=sf/n,brier_difference=(sm-sf)/n,BSS=BSS(sm,sf),BSS_status='defined' if sf>0 else 'zero_reference_SSE',observed_rate=y/n,predicted_mean=pm/n,reference_predicted_mean=pf/n,model_calibration_ratio=pm/y if y else None,fH_calibration_ratio=pf/y if y else None);rows.append(row);merged.append(row)
   valid=[r for r in rows if r['BSS'] is not None];minimum=min((r['BSS'] for r in valid),default=None)
   summaries.append(dict(model=m,time_half=q,labels_retained=12,defined_BSS_labels=len(valid),mean12_label_BSS=math.fsum(r['BSS'] for r in valid)/12 if len(valid)==12 else None,mean12_status='defined' if len(valid)==12 else 'undefined_label_present',exposure_pooled_BSS=BSS(math.fsum(r['model_SSE'] for r in rows),math.fsum(r['fH_SSE'] for r in rows)),label_exposures=sum(r['n'] for r in rows),positive_BSS_labels=sum(r['BSS']>0 for r in valid),negative_BSS_labels=sum(r['BSS']<0 for r in valid),zero_BSS_labels=sum(r['BSS']==0 for r in valid),weakest_defined_labels=[dict(horizon_hours=r['horizon_hours'],barrier=r['barrier'],BSS=r['BSS']) for r in valid if r['BSS']==minimum],weakest_status='defined_over_valid_labels' if valid else 'all_undefined'))
 need(len(projected)==240 and len(merged)==120 and len(summaries)==10,'OUTPUT_CLOSURE','all fixed outputs retained')
 return dict(raw_cell_projection=projected,hash_merged_labels=merged,model_time_summaries=summaries,all_12h_minus10pct_original_cells=[p for p in projected if p['horizon_hours']==12 and p['barrier']==-.1],temporal_membership_context=dict(pooled_median_origin=t['pooled_median_origin'],cells=[dict(cell=c['cell'],support_status=c['support_status'],unsupported_reasons=c['unsupported_reasons']) for c in t['cells']]),projection_policy='Only named cell fields +derived BSS retained. Original evidence_pins/private fullmanifest, source dictionaries and unknown descriptor fields excluded. All240 cells remain.')
def resources(t,out):
 rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss;need(rss<=POLICY['rss_bytes'] and time.monotonic()-t<=POLICY['wall_seconds'] and shutil.disk_usage(out).free>=POLICY['disk_reserve_bytes'],'RESOURCE_LIMIT','resource policy exceeded');return rss
def atomic(path,value):
 raw=(json.dumps(value,indent=2,sort_keys=True,allow_nan=False)+'\n').encode();need(len(raw)<=POLICY['output_bytes'],'OUTPUT_LIMIT','aggregate output exceeds1MB');part=path.with_suffix('.part');part.write_bytes(raw);part.replace(path)
def run(request,digest,out):
 out=Path(out).resolve();need(not out.exists(),'OUTPUT_EXISTS','fresh output directory required');out.mkdir(parents=True);t=time.monotonic();stage='authenticate'
 try:
  r,d,c,labels=authenticate(request,digest);peak=resources(t,out);stage='validate_and_aggregate';v=aggregate(d,c,labels);peak=max(peak,resources(t,out));stage='final_identity'
  for p in r['artifacts'].values():check_pin(p)
  need(sha(request)==digest and 'torch' not in sys.modules,'FINAL_IDENTITY','request/runtime changed');v.update(schema=SCHEMA,complete=True,request=pin(request),artifacts=r['artifacts'],runtime=runtime(),original_identities=IDENTITIES,labels=[list(x) for x in labels],telemetry=dict(elapsed_seconds=time.monotonic()-t,peak_process_RSS_bytes=peak),limitations=LIMITS);atomic(out/'result.json',v);return v
 except Exception as e:
  atomic(out/'failure.json',dict(schema=SCHEMA,complete=False,stage=stage,error_type=type(e).__name__,error_code=getattr(e,'code','UNEXPECTED_EXCEPTION'),error=str(e)[:250],request_sha256=digest));raise
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--out',required=True);a=p.parse_args();v=run(a.request,a.request_sha256,a.out);print(json.dumps(dict(complete=v['complete'],raw_cells=len(v['raw_cell_projection']),merged_labels=len(v['hash_merged_labels']))))
