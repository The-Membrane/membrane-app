"""O186 generated binary proper-loss nulls. No forecast, data loader or test runner."""
import calendar,hashlib,json,math,numbers,random,types
from datetime import date,timedelta
from fractions import Fraction as Q
from pathlib import Path
READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
HERE=Path(__file__).resolve().parent
CORE=(HERE/'hac_inference.py')if (HERE/'hac_inference.py').exists()else Path('/private/tmp/q26-U-hac-core.py')
CORE_SHA='15dd196cff71cf3c47104f73bf3e53e61e458c6843ea8b8b298db4ff6dfc9906'
A=.4;C=.6;EPS=1e-6;LOSSES=('brier','bounded_logloss');COUNT_VALUES=(0,1,3,7);BASE_SEED=20261023;REPS=1000;HAC_L=28
METHODS=('gaussian_hac','fixed_b_hac')
CONFIGS=(
 {'id':'complete_boundary_rho0','rho':'0','missing':'complete','roles':{2024:'boundary',2025:'boundary'}},
 {'id':'complete_boundary_rho05','rho':'1/2','missing':'complete','roles':{2024:'boundary',2025:'boundary'}},
 {'id':'complete_boundary_rho09','rho':'9/10','missing':'complete','roles':{2024:'boundary',2025:'boundary'}},
 {'id':'independent_missing_upper_boundary_rho0','rho':'0','missing':'independent','roles':{2024:'boundary',2025:'boundary'}},
 {'id':'independent_missing_upper_boundary_rho05','rho':'1/2','missing':'independent','roles':{2024:'boundary',2025:'boundary'}},
 {'id':'independent_missing_upper_boundary_rho09','rho':'9/10','missing':'independent','roles':{2024:'boundary',2025:'boundary'}},
 {'id':'complete_boundary2024_alternative2025_rho09','rho':'9/10','missing':'complete','roles':{2024:'boundary',2025:'alternative'}},
 {'id':'complete_alternative2024_boundary2025_rho09','rho':'9/10','missing':'complete','roles':{2024:'alternative',2025:'boundary'}},
)
def need(x,msg):
 if not x:raise ValueError(msg)
def frozen_core():
 b=CORE.read_bytes();need(hashlib.sha256(b).hexdigest()==CORE_SHA,'frozen core source');m=types.ModuleType('q26_o186_frozen_hac');m.__file__=str(CORE);exec(compile(b,str(CORE),'exec'),m.__dict__);need(m.EPS==EPS and m.BOUNDS==(1.,-math.log(EPS)),'unchanged score bounds');return m
def proper_losses(p,y):
 need(isinstance(y,numbers.Real)and not isinstance(y,bool),'numeric binary outcome');yf=float(y);need(yf in (0.,1.),'binary outcome');pf=float(p);need(math.isfinite(pf)and 0<=pf<=1,'probability');pc=min(1-EPS,max(EPS,pf))
 return ((pf-yf)**2,-(yf*math.log(pc)+(1.-yf)*math.log1p(-pc)))
def paired(y):
 ca=proper_losses(C,y);aa=proper_losses(A,y);return tuple(c-a for c,a in zip(ca,aa))
D0=paired(0);D1=paired(1)
need(D1==tuple(-x for x in D0),'exact sourcefloat symmetric endpoints')
def upper(y,unknown):
 need(type(unknown)is bool,'unknown flag');return tuple(max(a,b)for a,b in zip(D0,D1))if unknown else paired(y)
def parameters(missing,role):
 need(role in ('boundary','alternative'),'declared role');need(missing in ('complete','independent','mnar_tight'),'declared missingness')
 need(role=='boundary'or missing=='complete','only frozen complete alternatives')
 q=Q(9,10)if role=='alternative'else(Q(5,8)if missing=='independent'else Q(1,2))
 m=Q(0)if missing=='complete'else Q(1,5)
 actual=1-2*q
 u=(1-2*q*(1-m))if missing=='independent'else actual
 return {'q':q,'marginal_unknown':m,'actual_normalized_mean':actual,'upper_normalized_mean':u,'count_mean':Q(11,4),'unknown_given_y0':Q(2,5)if missing=='mnar_tight'else m,'unknown_given_y1':Q(0)if missing=='mnar_tight'else m}
def draw(rng,p):
 need(isinstance(p,Q)and 0<=p<=1,'exact Bernoulli probability');return int(rng.randrange(p.denominator)<p.numerator)
def stream(seed,year,name):
 need(type(seed)is int and seed>=0,'seed');digest=hashlib.sha256(f'q26-o186:{seed}:{year}:{name}'.encode()).digest();return random.Random(int.from_bytes(digest,'big'))
def seed_for(config_id,replicate):
 need(config_id in {x['id']for x in CONFIGS}and type(replicate)is int and 0<=replicate<REPS,'frozen replicate address');return int.from_bytes(hashlib.sha256(f'q26-o186:{BASE_SEED}:{config_id}:{replicate}'.encode()).digest(),'big')
def generate_year(year,rho,missing,role,seed,*,status='DRAFT'):
 need(status==READY,'source qualification status required');need(year in (2024,2025),'fixture calendar');r=Q(rho);need(r in (Q(0),Q(1,2),Q(9,10)),'frozen persistence');p=parameters(missing,role);q=p['q'];ry=stream(seed,year,'Y');rn=stream(seed,year,'N');rm=stream(seed,year,'M')
 p01=(1-r)*q;p10=(1-r)*(1-q);T=366 if calendar.isleap(year)else 365;y=draw(ry,q);days=[];counts=[];sums=[];actuals=[];ys=[];unknowns=[];start=date(year,1,1)
 for t in range(T):
  if t:y=0 if y and draw(ry,p10)else(1 if not y and draw(ry,p01)else y)
  unknown=bool(draw(rm,p['unknown_given_y1']if y else p['unknown_given_y0']))if missing!='complete'else False
  n=COUNT_VALUES[rn.randrange(4)];u=upper(y,unknown);d=paired(y)
  days.append((start+timedelta(days=t)).isoformat());counts.append(n);sums.append([n*x for x in u]);actuals.append([n*x for x in d]);ys.append(y);unknowns.append(unknown)
 return {'schema':'q26-o186-generated-properloss-year-v1','scope':'SYNTHETIC_BINARY_UPPER_LOSS_ONLY','year':year,'days':days,'counts':counts,'sums':sums,'actual_difference_sums':actuals,'latent_y':ys,'unknown':unknowns,'predictions':{'A':A,'C':C,'clock':'constant and predictable, independent of future outcomes'},'design':{'rho':str(r),'q':str(q),'missing_mode':missing,'role':role,'stationary_start':True,'burn_in':0,'count_values':list(COUNT_VALUES),'N_independent_of_Y_M':True,'common_day_shock_replicated_across_N_rows':True,'realized_centering':False,'separate_Y_N_M_streams':True},'analytic':{k:str(v)for k,v in p.items()}}
def generate_replicate(config_id,replicate,*,status='DRAFT'):
 need(status==READY,'source qualification status required');cfg=next((x for x in CONFIGS if x['id']==config_id),None);need(cfg is not None,'frozen config');seed=seed_for(config_id,replicate);return {year:generate_year(year,cfg['rho'],cfg['missing'],cfg['roles'][year],seed,status=status)for year in (2024,2025)}
def null_diagnostic_cells():
 cells=[]
 for method in METHODS:
  for cfg in CONFIGS:
   interpretation='UPPER_NULL_REJECTION_NOT_FALSE_ACTUAL_IMPROVEMENT'if cfg['missing']=='independent'else'FALSE_REJECTION_OF_TRUE_UPPER_AND_ACTUAL_NULL'
   for year in (2024,2025):
    if cfg['roles'][year]=='boundary':
     for loss in LOSSES:cells.append({'method':method,'configuration':cfg['id'],'cell':f'{year}:{loss}','null_type':interpretation})
   cells.append({'method':method,'configuration':cfg['id'],'cell':'IUT4','null_type':interpretation})
 need(len(cells)==72,'exact true-null diagnostic family');return cells
