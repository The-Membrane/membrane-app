"""Admission-only shallow temporal support census. No outcomes, predictions, fits or RNG."""
from __future__ import annotations
import argparse,ast,hashlib,json,platform,resource,shutil,sys,time
from pathlib import Path
import numpy as np
E=Path(__file__).resolve().parent
SCHEMA='codex-r16-temporal-admission-v1'
HORIZONS=(1,3,12);STEP=3600;DAY=86400;TMAX=12;SALT='Q26-R16.2-dev:'
SOURCE_SHA={'nn_source':'637915e982b961029dcd5b3b69dc6903564f2482fbfd604d2330c88e1cf68f20','dev_source':'702cedb98c7cfcfe77985c5f75073ec2a6f09a9a3e9dd97747328e42018ae29f'}
POLICY=dict(rss_bytes=1000000000,disk_reserve_bytes=2000000000,wall_seconds=300,output_bytes=5000000)
LIMITS='Admission-only seen-development metadata census; no outcome columns decompressed or inspected, model fitting, predictions, bootstrap, candidate selection, causal effect, forward validation or promotion. Whole NPZ bytes are streamed solely for pinned integrity. Counts are pooled horizon-row exposures, not distinct episodes; horizons repeat underlying origins. Strict cutoff is each original test cell earliest daily origin; preserve original validation-group identity, never relax/replace/drop unsupported cells. Minimum strict eligible group is diagnostic only. Supports do not establish suitable sample sizes, old per-fit RNG pairing, outcome availability beyond fixed horizon arithmetic, feature causality or resolution of prior contamination/LP correction.'
class AdmissionFailure(ValueError):
 def __init__(self,code,message):super().__init__(message);self.code=code
def need(ok,code,message):
 if not ok:raise AdmissionFailure(code,message)
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def pin(p):
 p=Path(p).resolve();return dict(path=str(p),size=p.stat().st_size,sha256=sha(p))
def check_pin(v):
 need(isinstance(v,dict) and {'path','size','sha256'}<=set(v),'PIN_REQUIRED','complete actual artifact pin required');p=Path(v['path']);need(p.is_file() and not p.is_symlink() and p.stat().st_size==v['size'] and sha(p)==v['sha256'],'PIN_CHANGED','artifact identity changed: '+str(p))
def runtime():return dict(python=sys.version,executable=str(Path(sys.executable).resolve()),prefix=sys.prefix,platform=platform.platform(),numpy=np.__version__)
def source_contract(nn,dev):
 # Parse only constants/functions for an exact source-contract check, never import forecast modules.
 for key,path in [('nn_source',nn),('dev_source',dev)]:need(sha(path)==SOURCE_SHA[key],'SOURCE_CHANGED','frozen source changed')
 tree=ast.parse(Path(dev).read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='groups_of'];need(len(nodes)==1,'SOURCE_SYMBOL','original group function required');ns={'hashlib':hashlib,'np':np,'SALT':SALT};exec(compile(ast.Module(body=nodes,type_ignores=[]),str(dev),'exec'),ns);return ns['groups_of']
def groups_of(keys):return np.array([hashlib.sha256((SALT+k).encode()).digest()[0]%4 for k in keys],dtype=np.int64)
def authenticate(request,digest):
 need(sha(request)==digest,'REQUEST_CHANGED','request changed');r=json.loads(Path(request).read_text())
 need(r.get('admission_status')=='parent_accepted','DRAFT_NOT_ADMITTED','parent source/tests/refutation review required before metadata census')
 expected={'implementation','tests','nn_source','dev_source','runtime_proof','parent_merge_admission','rows_meta','rows_T1','rows_T3','rows_T12'}
 need(r.get('schema')==SCHEMA and r.get('horizons')==list(HORIZONS) and r.get('policy')==POLICY and r.get('allowed_npz_members')==['sid','ts'] and set(r['artifacts'])==expected,'PROTOCOL_CHANGED','fixed metadata-only admission protocol differs')
 for v in r['artifacts'].values():check_pin(v)
 need(Path(r['artifacts']['implementation']['path']).resolve()==Path(__file__).resolve(),'IMPLEMENTATION_PATH','executed helper must be pinned');need(r['runtime']==runtime() and 'torch' not in sys.modules,'RUNTIME_CHANGED','runtime differs or Torch imported')
 groupfn=source_contract(r['artifacts']['nn_source']['path'],r['artifacts']['dev_source']['path'])
 accepted=json.loads(Path(r['artifacts']['parent_merge_admission']['path']).read_text());need(accepted.get('complete') is True and accepted.get('all_51_concatenated_fields_verified') is True,'MERGE_NOT_ACCEPTED','complete original merge admission required')
 need(accepted['metadata_sha256']==r['artifacts']['rows_meta']['sha256'],'META_BINDING','accepted canonical series order differs')
 for T in HORIZONS:
  v=r['artifacts'][f'rows_T{T}'];o=accepted['outputs'][str(T)];need((v['size'],v['sha256'])==(o['file_bytes'],o['sha256']),'MERGE_BINDING','NPZ differs from parent accepted merged output')
 return r,accepted,groupfn

def read_metadata_npz(path):
 # Explicit allowlist is the only NPZ member load in this helper. np.load remains lazy.
 with np.load(path,allow_pickle=False) as z:
  need(len(z.files)==len(set(z.files)) and {'sid','ts'}<=set(z.files),'NPZ_MEMBERS','unique sid/ts members required')
  return {key:z[key] for key in ('sid','ts')}
def fieldsha(v):return hashlib.sha256(np.ascontiguousarray(v).tobytes()).hexdigest()
def load_pooled(r,accepted,keys):
 parts=[];loaded=[]
 for T in HORIZONS:
  d=read_metadata_npz(r['artifacts'][f'rows_T{T}']['path']);sid,ts=d['sid'],d['ts'];need(sid.ndim==ts.ndim==1 and sid.shape==ts.shape and sid.dtype.kind in 'iu' and ts.dtype.kind in 'iu' and len(ts)>0,'ARRAY_METADATA','nonempty aligned integer sid/ts vectors required');need(np.all(sid<len(keys)) and np.all(sid>=0) and np.all(ts>=0) and np.all(ts<=np.iinfo(np.int64).max-TMAX*STEP),'ARRAY_RANGE','sid/timestamp outside safe contract')
  o=accepted['outputs'][str(T)];need(len(ts)==o['rows'] and all(fieldsha(d[k])==o['canonical_field_sha256'][k] for k in ('sid','ts')),'FIELD_IDENTITY','sid/ts differs from canonical parent acceptance')
  parts.append(dict(sid=sid.astype(np.int64),ts=ts.astype(np.int64),T=np.full(len(ts),T,np.int16)));loaded.append(dict(horizon=T,rows=len(ts),members_loaded=['sid','ts']))
 return {key:np.concatenate([p[key] for p in parts]) for key in ('sid','ts','T')},loaded

def support(mask,R,grp,test_start=None,test_end=None):
 idx=np.flatnonzero(mask);n=len(idx);g=grp[idx];ending=R['ts'][idx]+R['T'][idx].astype(np.int64)*STEP;tmaxending=R['ts'][idx]+TMAX*STEP
 counts={str(T):int(np.sum(R['T'][idx]==T)) for T in HORIZONS}
 def span(v):return dict(min=int(v.min()),max=int(v.max())) if n else dict(min=None,max=None)
 return dict(horizon_row_exposures=n,by_horizon=counts,unique_series=int(len(np.unique(R['sid'][idx]))),unique_groups=int(len(np.unique(g))),group_exposures={str(i):int(np.sum(g==i)) for i in range(4)},origin_timestamps=span(R['ts'][idx]),own_horizon_label_available_timestamps=span(ending),Tmax_label_available_timestamps=span(tmaxending),own_label_after_test_start=dict(count=int(np.sum(ending>test_start)),fraction=float(np.mean(ending>test_start))) if n and test_start is not None else dict(count=0,fraction=None),own_label_after_test_end=dict(count=int(np.sum(ending>test_end)),fraction=float(np.mean(ending>test_end))) if n and test_end is not None else dict(count=0,fraction=None))
def census(R,keys):
 need(set(R)=={'sid','ts','T'} and len(R['sid'])==len(R['ts'])==len(R['T']) and len(R['ts'])>0,'POOLED_SCHEMA','nonempty aligned metadata required');need(np.isin(R['T'],HORIZONS).all(),'HORIZONS','fixed shallow horizons required');grp=groups_of(keys)[R['sid']];half=grp%2;tsplit=float(np.median(R['ts']));th=(R['ts']>=tsplit).astype(int);cells=[]
 for sh in (0,1):
  peer=half!=sh
  for tt in (0,1):
   te=(half==sh)&(th==tt)&(R['ts']%DAY==0);n=int(te.sum());start=int(R['ts'][te].min()) if n else None;end=int(R['ts'][te].max()) if n else None
   original=peer & ((R['ts']>=tsplit+TMAX*STEP) if tt==0 else (R['ts']+TMAX*STEP<=tsplit));g0=int(grp[original].min()) if original.any() else None
   va=original&(grp==g0) if g0 is not None else np.zeros(len(te),bool);tr=original&~va
   strict=peer&(R['ts']+TMAX*STEP<=start) if n else np.zeros(len(te),bool);sva=strict&(grp==g0) if g0 is not None else np.zeros(len(te),bool);str_=strict&~sva;alt=int(grp[strict].min()) if strict.any() else None
   reasons=[]
   if not n:reasons.append('no_original_daily_test_rows')
   if g0 is None:reasons.append('original_eligible_population_empty'+('_original_min_would_fail' if n else '_testcell_skipped'))
   if n and not tr.any():reasons.append('original_training_population_empty')
   if not strict.any():reasons.append('strict_eligible_population_empty')
   if not sva.any():reasons.append('preserved_original_validation_group_empty')
   if not str_.any():reasons.append('strict_training_population_empty')
   summarize=lambda mask:support(mask,R,grp,start,end)
   cells.append(dict(cell=[sh,tt],test=summarize(te),strict_cutoff_timestamp=start,original_validation_group=g0,original_execution_status='would_process' if n and g0 is not None else 'would_fail_empty_original_eligibility' if n else 'skipped_no_daily_test_rows',original=dict(eligible=summarize(original),train_before_caps=summarize(tr),validation_before_cap=summarize(va)),strict_preserving_validation_group=dict(eligible=summarize(strict),train_before_caps=summarize(str_),validation_before_cap=summarize(sva)),peer_universe=summarize(peer),diagnostic_only_minimum_strict_group=dict(group=alt,validation=summarize(strict&(grp==alt)) if alt is not None else summarize(np.zeros(len(te),bool)),applied=False),support_status='unsupported' if reasons else 'nonempty_support_only',unsupported_reasons=reasons))
 return dict(pooled_horizon_rows=len(R['ts']),pooled_median_origin=tsplit,cutoff_rule='each original daily testcell earliest origin; peer ts+12h<=C; validation identity fixed from original eligibility',label_availability_definition='ts+own horizon for observed proportions; ts+12h separately reported for conservative eligibility; both are arithmetic availability proxies',count_semantics='Duplicate origins across horizons retained exactly as original tier_rows; counts are horizon-row exposures, not distinct episodes. All original train/validation counts precede caps/sampling.',groups_by_series_count={str(g):int(np.sum(groups_of(keys)==g)) for g in range(4)},cells=cells)
def resources(t,out):
 rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss;need(rss<=POLICY['rss_bytes'] and time.monotonic()-t<=POLICY['wall_seconds'] and shutil.disk_usage(out).free>=POLICY['disk_reserve_bytes'],'RESOURCE_LIMIT','RSS/wall/free reserve failed');return rss
def atomic(p,v):
 raw=(json.dumps(v,indent=2,sort_keys=True,allow_nan=False)+'\n').encode();need(len(raw)<=POLICY['output_bytes'],'OUTPUT_LIMIT','aggregate output cap exceeded');temp=p.with_suffix('.part');temp.write_bytes(raw);temp.replace(p)
def run(request,digest,out):
 out=Path(out).resolve();need(not out.exists(),'OUTPUT_EXISTS','fresh output directory required');out.mkdir(parents=True);t=time.monotonic();stage='authenticate'
 try:
  r,a,originalgroups=authenticate(request,digest);peak=resources(t,out);stage='series_metadata';meta=json.loads(Path(r['artifacts']['rows_meta']['path']).read_text());keys=meta['series'];need(isinstance(keys,list) and len(set(keys))==len(keys) and all(isinstance(k,str) for k in keys),'SERIES_METADATA','unique canonical key list required');need(np.array_equal(groups_of(keys),originalgroups(keys)),'GROUP_MAPPING','original source hash groups differ');stage='sid_ts_only_load';R,loaded=load_pooled(r,a,keys);peak=max(peak,resources(t,out));stage='census';result=census(R,keys);peak=max(peak,resources(t,out));stage='final_pin_checks'
  for v in r['artifacts'].values():check_pin(v)
  need(sha(request)==digest and 'torch' not in sys.modules,'FINAL_IDENTITY','request/runtime changed');peak=max(peak,resources(t,out));result.update(schema=SCHEMA,complete=True,status='complete',request=pin(request),artifacts=r['artifacts'],runtime=runtime(),NPZ_members_loaded=loaded,telemetry=dict(elapsed_seconds=time.monotonic()-t,peak_process_RSS_bytes=peak),limitations=LIMITS);atomic(out/'result.json',result);return result
 except Exception as e:
  atomic(out/'failure.json',dict(schema=SCHEMA,complete=False,status='failed-admission',stage=stage,error_type=type(e).__name__,error_code=getattr(e,'code','UNEXPECTED_EXCEPTION'),error=str(e)[:300],request_sha256=digest));raise
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--out',required=True);a=p.parse_args();v=run(a.request,a.request_sha256,a.out);print(json.dumps(dict(complete=v['complete'],cells=len(v['cells']))))
