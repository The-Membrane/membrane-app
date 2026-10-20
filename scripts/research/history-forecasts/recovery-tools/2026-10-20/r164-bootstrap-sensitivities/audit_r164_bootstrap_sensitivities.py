"""Descriptive common-draw ratio bootstrap on accepted stored-input loss matrices only."""
from __future__ import annotations
import argparse,ast,hashlib,json,math,platform,resource,shutil,sys,time
from pathlib import Path
import numpy as np
E=Path(__file__).resolve().parent
ORIGINAL=Path('/Users/EBmic/research-workspaces/history-forecasts-continuation/scripts/research/history-forecasts/r164_score.py')
ORIGINAL_SHA='151b6eb0c3f8543fe6b4e11c560407eacac3ce4780ce7068f9609c5e86055142'
MODELS=('a','f','fH','rec12','fix12','recb12','recc12')
COMPS=(('rec12','fH'),('rec12','f'),('rec12','a'),('fix12','fH'),('rec12','fix12'),('recb12','fH'),('recc12','fH'),('recc12','rec12'),('recb12','rec12'),('fH','f'),('f','a'),('fH','a'))
GROUPS=tuple(f'T{T}_G{g}' for T in (24,72,168,720) for g in range(4))
MODES=('combined','cluster_only','calendar_only');FIELDS=('Md','MdLo','MdHi','Mn','SIDs','BIDs')
NREP=2000;SEED=20261641;SCHEMA='codex-r164-stored-bootstrap-sensitivities-v1'
POLICY=dict(rss_bytes=1000000000,disk_reserve_bytes=2000000000,wall_seconds=300,output_bytes=5000000)
LIMITS=('DESCRIPTIVE sensitivity of accepted stored float16-input matrices, not original unpersisted float32 bootstrap replay, new predictions, p-values, power, forecasting skill or changed gates. Fresh independent per-group SeedSequence([20261641,ordinal]) common-draw design is not original global RNG replay. CGM score-formula terms are not an identified additive variance decomposition. Differences between bootstrap variances do not identify components or a universal time-only ceiling. MdLo/MdHi give only conservative point-mean packing envelopes under nearest float16 packing, possibly jointly unattainable; not confidence intervals or SD bounds. Zero-denominator replicates are censored without redraw/fill; their SD is conditional on positive-denominator replicates. No LP correction, reserve use, tuning, ranking or promotion.')
class ReviewFailure(ValueError):
 def __init__(self,code,message):super().__init__(message);self.code=code
def need(ok,code,message):
 if not ok:raise ReviewFailure(code,message)
def sha(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def pin(p):
 p=Path(p).resolve();return dict(path=str(p),size=p.stat().st_size,sha256=sha(p))
def check_pin(p):
 need(isinstance(p,dict) and set(('path','size','sha256'))<=set(p),'MISSING_PIN','actual complete artifact pin required');f=Path(p['path']);need(f.is_file() and not f.is_symlink() and f.stat().st_size==p['size'] and sha(f)==p['sha256'],'PIN_CHANGED','source/input identity changed: '+str(f))
def runtime():return dict(python=sys.version,executable=str(Path(sys.executable).resolve()),prefix=sys.prefix,platform=platform.platform(),numpy=np.__version__)
def original_functions(path=ORIGINAL):
 need(sha(path)==ORIGINAL_SHA,'ORIGINAL_CHANGED','original scorer source differs');tree=ast.parse(Path(path).read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('cells','twoway_mean')];need({n.name for n in nodes}=={'cells','twoway_mean'},'ORIGINAL_SYMBOLS','exact original functions required');ns={'np':np,'math':math};exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),ns);return ns

def authenticate(path,digest):
 need(sha(path)==digest,'REQUEST_CHANGED','request identity changed');r=json.loads(Path(path).read_text())
 # Refuse drafts BEFORE touching matrix metadata, matrix bytes, or random draws.
 need(r.get('admission_status')=='parent_accepted','DRAFT_NOT_ADMITTED','matrix reconstruction and actual parent acceptance must precede execution')
 need(r.get('schema')==SCHEMA and r['groups']==list(GROUPS) and r['comparison_order']==[list(c) for c in COMPS] and r['models']==list(MODELS) and r['modes']==list(MODES) and r['Nrep']==NREP and r['seed']==SEED and r['policy']==POLICY,'PROTOCOL_CHANGED','fixed descriptive protocol differs')
 need(set(r['artifacts'])=={'implementation','tests','original_score_source','runtime_proof','matrices','reconstruction','parent_acceptance','reconstruction_request','reconstruction_monitor'},'ARTIFACT_SET','exact source/runtime/input admission pins required')
 for p in r['artifacts'].values():check_pin(p)
 need(Path(r['artifacts']['implementation']['path']).resolve()==Path(__file__).resolve(),'IMPLEMENTATION_PATH','executed helper must be the pinned implementation')
 need(r['artifacts']['original_score_source']['sha256']==ORIGINAL_SHA,'ORIGINAL_CHANGED','original source identity differs');need(r['runtime']==runtime() and 'torch' not in sys.modules,'RUNTIME_CHANGED','runtime differs or Torch imported')
 rec=json.loads(Path(r['artifacts']['reconstruction']['path']).read_text());accepted=json.loads(Path(r['artifacts']['parent_acceptance']['path']).read_text())
 need(rec.get('complete') is True and accepted.get('complete') is True,'MATRIX_NOT_ACCEPTED','terminal reconstruction and parent acceptance required')
 need(rec['matrix']['sha256']==r['artifacts']['matrices']['sha256'] and accepted['matrix']['sha256']==r['artifacts']['matrices']['sha256'] and accepted['reconstruction']['sha256']==r['artifacts']['reconstruction']['sha256'],'ACCEPTANCE_BINDING','acceptance must bind actual matrix and reconstruction identities')
 need(accepted.get('schema')=='codex-parent-r164-original-matrix-admission-v1','ACCEPTANCE_SCHEMA','parent matrix admission schema differs')
 need(accepted['request']==r['artifacts']['reconstruction_request'] and rec['request']==r['artifacts']['reconstruction_request'] and accepted['monitor']==r['artifacts']['reconstruction_monitor'] and accepted['source']==r['artifacts']['original_score_source'],'PROVENANCE_BINDING','parent/reconstruction/source/monitor identity mismatch')
 monitor=json.loads(Path(r['artifacts']['reconstruction_monitor']['path']).read_text())
 need(monitor.get('complete') is True and monitor.get('exit_code')==0 and monitor.get('request_sha256')==r['artifacts']['reconstruction_request']['sha256'],'RECONSTRUCTION_MONITOR','successful request-bound reconstruction monitor required')
 need(rec['comparison_order']==[list(c) for c in COMPS] and rec['model_order']==list(MODELS) and [g['key'] for g in rec['groups']]==list(GROUPS),'MATRIX_PROTOCOL','accepted model/comparison/group order differs')
 return r,rec

def validate_arrays(arrays):
 need(set(arrays)=={g+'_'+f for g in GROUPS for f in FIELDS},'MATRIX_KEYS','exact96matrix keys required')
 groups={}
 for group in GROUPS:
  d={f:arrays[group+'_'+f] for f in FIELDS};mn=d['Mn'];need(mn.dtype==np.dtype('int64') and mn.ndim==2 and all(n>0 for n in mn.shape) and np.all(mn>=0) and mn.sum()>0,'MATRIX_COUNTS','nonnegative int64 cell counts with positive group total required');S,B=mn.shape
  for field,size in [('SIDs',S),('BIDs',B)]:
   v=d[field];need(v.dtype==np.dtype('int64') and v.shape==(size,) and np.all(v[1:]>v[:-1]),'MATRIX_IDS','sorted unique int64 IDs required')
  for field in ('Md','MdLo','MdHi'):
   v=d[field];need(v.dtype==np.dtype('float64') and v.shape==(12,S,B) and np.isfinite(v).all(),'MATRIX_VALUES','finite float64 comparison sums required');need(np.all(v[:,mn==0]==0),'EMPTY_CELL_SUM','zero-count cells must have zero sums')
  tol=64*np.finfo(float).eps*np.maximum(1,np.abs(d['Md']))
  need(np.all(d['MdLo']<=d['Md']+tol) and np.all(d['Md']<=d['MdHi']+tol),'MEAN_ENVELOPE','stored point outside conservative quantization envelope');groups[group]=d
 return groups

def draw_weights(S,B,ordinal,nrep=NREP):
 rng=np.random.default_rng(np.random.SeedSequence([SEED,ordinal]));ws=rng.multinomial(S,np.full(S,1./S),size=nrep).astype(float);wb=rng.multinomial(B,np.full(B,1./B),size=nrep).astype(float);return ws,wb

def ratio_replicates(md,mn,ws,wb):
 den=np.einsum('rs,sb,rb->r',ws,mn,wb,optimize=True);num=np.einsum('rs,sb,rb->r',ws,md,wb,optimize=True);valid=den>0
 need(np.isfinite(num).all() and np.isfinite(den).all(),'NONFINITE_BOOTSTRAP','bootstrap arithmetic nonfinite');return num[valid]/den[valid],int((~valid).sum())
def bootstrap_summary(values,censored,mean,total):
 n=len(values);sd=float(np.std(values,ddof=1)) if n>=2 else None;defined=sd is not None and sd>0
 return dict(replicates_requested=total,valid_replicates=n,censored_zero_denominator_replicates=censored,redrawn_replicates=0,positive_denominator_conditioning=censored>0,bootstrap_mean=float(np.mean(values)) if n else None,bootstrap_mean_minus_point=float(np.mean(values)-mean) if n else None,sample_SD_ddof1=sd,signed_z=mean/sd if defined else None,favorable_z=-mean/sd if defined else None,z_status='defined' if defined else 'insufficient_valid_replicates' if n<2 else 'zero_SD',bootstrap_mean_bias_is_forecast_bias=False)
def cgm_terms(md,mn,mean):
 u=(md-mean*mn)/mn.sum();row=float(np.sum(np.sum(u,axis=1)**2));col=float(np.sum(np.sum(u,axis=0)**2));inter=float(np.sum(u*u));net=row+col-inter
 return dict(row_score_variance_term=row,calendar_score_variance_term=col,intersection_subtraction_term=inter,net_score_variance=net,SD=math.sqrt(net) if net>0 else None,signed_z=mean/math.sqrt(net) if net>0 else None,favorable_z=-mean/math.sqrt(net) if net>0 else None,status='positive_net' if net>0 else 'nonpositive_net_undefined',identified_additive_variance_decomposition=False)
def analyze_group(group,d,ordinal,nrep=NREP):
 mn=d['Mn'];S,B=mn.shape;ws,wb=draw_weights(S,B,ordinal,nrep);means=d['Md'].sum(axis=(1,2))/mn.sum();mode_weights={'combined':(ws,wb),'cluster_only':(ws,np.ones_like(wb)),'calendar_only':(np.ones_like(ws),wb)};records=[]
 for j,comp in enumerate(COMPS):
  point=float(means[j]);envelope=[float(d['MdLo'][j].sum()/mn.sum()),float(d['MdHi'][j].sum()/mn.sum())];cgm=cgm_terms(d['Md'][j],mn,point)
  for mode in MODES:
   weights=mode_weights[mode];values,censored=ratio_replicates(d['Md'][j],mn,*weights)
   records.append(dict(group=group,comparison_index=j,comparison=list(comp),mode=mode,point_mean=point,point_mean_quantization_envelope=envelope,quantization_envelope_is_SD_bound=False,bootstrap=bootstrap_summary(values,censored,point,nrep),CGM=cgm))
 return dict(group=group,S=S,B=B,total_observation_count=int(mn.sum()),common_draw_seed=[SEED,ordinal],ws_sha256=hashlib.sha256(ws.tobytes()).hexdigest(),wb_sha256=hashlib.sha256(wb.tobytes()).hexdigest(),records=records)
def resources(start,path):
 rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss;need(rss<=POLICY['rss_bytes'],'RSS_LIMIT','RSS policy exceeded');need(time.monotonic()-start<=POLICY['wall_seconds'],'WALL_LIMIT','wall policy exceeded');need(shutil.disk_usage(path).free>=POLICY['disk_reserve_bytes'],'DISK_RESERVE','free reserve breached');return rss
def atomic(path,value):
 raw=(json.dumps(value,sort_keys=True,indent=2,allow_nan=False)+'\n').encode();need(len(raw)<=POLICY['output_bytes'],'OUTPUT_LIMIT','aggregate output cap exceeded');part=path.with_suffix('.part');part.write_bytes(raw);part.replace(path)
def run(request,digest,out):
 out=Path(out).resolve();need(not out.exists(),'OUTPUT_EXISTS','fresh output directory required');out.mkdir(parents=True);start=time.monotonic();stage='authenticate';status=dict(schema=SCHEMA,complete=False,status='started',request_path=str(request),request_sha256=digest)
 try:
  r,rec=authenticate(request,digest);stage='matrix_validation';peak=resources(start,out)
  with np.load(r['artifacts']['matrices']['path'],allow_pickle=False) as z:
   need(len(z.files)==96 and len(set(z.files))==96,'MATRIX_KEYS','exact96uniqueNPZkeys required');arrays={k:z[k] for k in z.files}
  groups=validate_arrays(arrays)
  for g in rec['groups']:
   d=groups[g['key']];need((g['S'],g['B'],g['rows'])==(d['Mn'].shape[0],d['Mn'].shape[1],int(d['Mn'].sum())),'GROUP_METADATA','reconstruction dimensions/count disagree with actual arrays')
  results=[]
  for ordinal,key in enumerate(GROUPS):
   stage='bootstrap_'+key;peak=max(peak,resources(start,out));results.append(analyze_group(key,groups[key],ordinal));peak=max(peak,resources(start,out))
  need(len(results)==16 and sum(len(x['records']) for x in results)==576,'CLOSURE','all576statistics includingundefined must be retained')
  stage='final_identity_checks'
  for p in r['artifacts'].values():check_pin(p)
  need(sha(request)==digest and 'torch' not in sys.modules,'FINAL_IDENTITY','request/runtime changed');stage='serialize';peak=max(peak,resources(start,out))
  status.update(complete=True,status='complete',request=pin(request),artifacts=r['artifacts'],runtime=runtime(),groups=results,statistics=576,Nrep=NREP,seed=SEED,reconstruction_provenance=dict(groups=rec['groups'],comparison_order=rec['comparison_order'],model_order=rec['model_order'],input_pins=rec.get('input_pins'),source_pins=rec.get('source_pins'),limitations=rec.get('limitations')),telemetry=dict(elapsed_seconds=time.monotonic()-start,peak_process_RSS_bytes=peak),limitations=LIMITS)
  atomic(out/'result.json',status);return status
 except Exception as error:
  failure=dict(schema=SCHEMA,complete=False,status='failed-review-hold',stage=stage,error_type=type(error).__name__,error_code=getattr(error,'code','UNEXPECTED_EXCEPTION'),error=str(error)[:300],request_sha256=digest,elapsed_seconds=time.monotonic()-start)
  atomic(out/'failure.json',failure);raise
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--out',required=True);a=p.parse_args();v=run(a.request,a.request_sha256,a.out);print(json.dumps({'complete':v['complete'],'statistics':v['statistics'],'output':str(Path(a.out)/'result.json')}))
