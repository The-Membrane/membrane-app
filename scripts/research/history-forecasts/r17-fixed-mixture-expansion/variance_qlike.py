"""Positive-proxy normalized variance QLIKE; no loading, fitting or inference."""
import math,sys
from datetime import datetime,timezone
import numpy as np
READY='READY_SYNTHETIC_SOURCE_QUALIFICATION'
ADMITTED='READY_PARENT_REVIEWED_O188_PERSISTENCE_EXTENSION'
LOGMAX=math.log(sys.float_info.max)
LOGMIN=math.log(float.fromhex('0x0.0000000000001p-1022'))

def gate(status):
 if status not in (READY,ADMITTED):raise ValueError('DRAFT: no scoring admission')

def log_qlike_ratio(x):
 """log(exp(x)-x-1), with -inf representing exact zero loss internally."""
 x=float(x)
 if not math.isfinite(x):raise ValueError('nonfinite log variance ratio')
 if x==0:return -math.inf
 if abs(x)<=.5:
  # Factor out x². Degree26 remainder is below float64 rounding on this interval.
  factor=math.fsum(x**(k-2)/math.factorial(k) for k in range(2,27))
  return 2*math.log(abs(x))+math.log(factor)
 if x>50:return x+math.log1p(-(x+1)*math.exp(-x))
 return math.log(math.expm1(x)-x)

def log_qlike_sigma(target_sigma,forecast_sigma):
 """Variances are sigma², but never square the input or form an extreme ratio."""
 y=float(target_sigma);p=float(forecast_sigma)
 if not(math.isfinite(y) and math.isfinite(p) and y>0 and p>0):raise ValueError('finite positive sigma required')
 if abs(y-p)<=.5*max(y,p):x=2*math.log1p((y-p)/p)
 else:x=2*(math.log(y)-math.log(p))
 return log_qlike_ratio(x)

def represented(logvalue):
 if logvalue==-math.inf:return {'mean':0.0,'log_mean':None,'status':'EXACT_ZERO'}
 if not math.isfinite(logvalue):raise ArithmeticError('nonfinite log mean')
 if logvalue>LOGMAX:return {'mean':None,'log_mean':logvalue,'status':'ABOVE_FLOAT64_RANGE'}
 if logvalue<LOGMIN:return {'mean':None,'log_mean':logvalue,'status':'BELOW_POSITIVE_FLOAT64_RANGE'}
 try:value=math.exp(logvalue)
 except OverflowError:return {'mean':None,'log_mean':logvalue,'status':'ABOVE_FLOAT64_RANGE'}
 return {'mean':value,'log_mean':logvalue,'status':'FINITE'}

def summarize_logs(values):
 values=list(values);n=len(values)
 if not n:return {'n':0,'mean':None,'log_mean':None,'status':'EMPTY','perfect_zero_rows':0,'ordinary_row_overflow':0}
 if any(not(math.isfinite(v) or v==-math.inf) for v in values):raise ArithmeticError('invalid log loss')
 peak=max(values)
 logmean=-math.inf if peak==-math.inf else peak+math.log(math.fsum(math.exp(v-peak) for v in values)/n)
 return {'n':n,**represented(logmean),'perfect_zero_rows':sum(v==-math.inf for v in values),'ordinary_row_overflow':sum(v>LOGMAX for v in values)}

def comparison(left,right):
 if left['n']!=right['n']:raise ValueError('different paired support')
 if not left['n']:return {'mean_difference':None,'ordering':'EMPTY','status':'EMPTY'}
 l=-math.inf if left['status']=='EXACT_ZERO' else left['log_mean'];r=-math.inf if right['status']=='EXACT_ZERO' else right['log_mean']
 order='LEFT_LOWER' if l<r else 'RIGHT_LOWER' if l>r else 'TIE_AT_FLOAT_PRECISION'
 if left['mean'] is not None and right['mean'] is not None:
  return {'mean_difference':left['mean']-right['mean'],'ordering':order,'status':'ORDINARY_MEAN_DIFFERENCE'}
 return {'mean_difference':None,'ordering':order,'status':'LOG_ARITHMETIC_MEAN_ORDER_ONLY'}

def typed(a,dtype,name):
 a=np.asarray(a)
 if a.ndim!=1 or a.dtype!=np.dtype(dtype):raise ValueError('dtype/shape '+name)
 return a

def score_scales(ts,har,ewma,persistence,target,strict_future,operational_fallback,*,status='DRAFT'):
 """Per-SID fixed-J inputs. Caller authenticates global SID/key membership.

 All predeclared pair and three-way masks are reported, never selected by loss.
 QLIKE moments use all eligible rows even when ordinary row losses overflow.
 """
 gate(status)
 t=typed(ts,'int64','ts');scales={k:typed(v,'float64',k) for k,v in [('HAR',har),('EWMA',ewma),('PERSISTENCE',persistence)]}
 y=typed(target,'float64','target');st=typed(strict_future,'bool','strict_future');fb=typed(operational_fallback,'bool','operational_fallback')
 if any(len(a)!=len(t) for a in [*scales.values(),y,st,fb]) or np.any(np.diff(t)<=0):raise ValueError('row inventory/order')
 valid={k:np.isfinite(v)&(v>0) for k,v in scales.items()};yv=np.isfinite(y)&(y>0)
 years=np.array([datetime.fromtimestamp(int(x),timezone.utc).year for x in t])
 views={}
 for name,period in [('pooled_2024_2025',np.isin(years,[2024,2025])),('2024',years==2024),('2025',years==2025)]:
  v={'J':int(period.sum()),'target_unavailable':int((period&~yv).sum()),'operational_fallback':int((period&fb).sum()),'forecast_unavailable':{k:int((period&~ok).sum()) for k,ok in valid.items()},'supports':{}}
  for label,arms in [('HAR_EWMA',('HAR','EWMA')),('HAR_PERSISTENCE',('HAR','PERSISTENCE')),('EWMA_PERSISTENCE',('EWMA','PERSISTENCE')),('COMMON_THREE',('HAR','EWMA','PERSISTENCE'))]:
   pm=period.copy()
   for k in arms:pm&=valid[k]
   mask=pm&yv
   support={'paired_positive_forecasts':int(pm.sum()),'target_excluded':int((pm&~yv).sum()),'n':int(mask.sum()),'incomplete_future':int((mask&~st).sum()),'QLIKE':{},'squared_log_sigma':{},'QLIKE_comparisons':{}}
   def metrics(selected):
    result={'n':int(selected.sum()),'QLIKE':{},'squared_log_sigma':{},'QLIKE_comparisons':{},'squared_log_comparisons':{}}
    for k in arms:
     logs=[log_qlike_sigma(yy,pp) for yy,pp in zip(y[selected],scales[k][selected])]
     result['QLIKE'][k]=summarize_logs(logs)
     errors=[(math.log(float(pp))-math.log(float(yy)))**2 for pp,yy in zip(scales[k][selected],y[selected])]
     result['squared_log_sigma'][k]=math.fsum(z/len(errors) for z in errors) if errors else None
    for i,k in enumerate(arms):
     for other in arms[i+1:]:
      name=k+'_minus_'+other
      result['QLIKE_comparisons'][name]=comparison(result['QLIKE'][k],result['QLIKE'][other])
      result['squared_log_comparisons'][name]=result['squared_log_sigma'][k]-result['squared_log_sigma'][other] if result['n'] else None
    return result
   support.pop('QLIKE');support.pop('squared_log_sigma');support.pop('QLIKE_comparisons')
   support['original_target_paired']=metrics(mask)
   support['complete_future_paired']=metrics(mask&st)
   v['supports'][label]=support
  views[name]=v
 return {'schema':'q26-o188-qlike-scale-report-v1','H':24,'all_J':len(t),'out_of_period_J':int((~np.isin(years,[2024,2025])).sum()),'views':views,'loss':'normalized_variance_QLIKE','log_mean_is_log_arithmetic_mean_not_mean_log_loss':True,'unavailable_counts_overlap':True,'target_selection_outcome_dependent':True,'latent_proxy_unbiasedness_established':False,'descriptive_only':True,'unseen_validation':False,'promotion':'NOT_ADMITTED'}

def merge_qlike(parts):
 """Row-weighted arithmetic QLIKE mean from per-series log means, not SID means."""
 parts=list(parts)
 for p in parts:
  if type(p['n'])is not int or p['n']<0:raise ValueError('summary row count')
  if p['n']==0:
   if p['status']!='EMPTY' or p['mean'] is not None or p['log_mean'] is not None:raise ValueError('empty summary')
  elif p['status']=='EXACT_ZERO':
   if p['mean']!=0 or p['log_mean'] is not None or p['perfect_zero_rows']!=p['n']:raise ValueError('zero summary')
  elif p['status'] not in ('FINITE','ABOVE_FLOAT64_RANGE','BELOW_POSITIVE_FLOAT64_RANGE') or not isinstance(p['log_mean'],(int,float)) or not math.isfinite(p['log_mean']):raise ValueError('log mean summary')
  for k in ('perfect_zero_rows','ordinary_row_overflow'):
   if type(p[k])is not int or not 0<=p[k]<=p['n']:raise ValueError('summary count')
 n=sum(p['n'] for p in parts)
 if not n:return summarize_logs([])
 nonzero=[p for p in parts if p['n'] and p['status']!='EXACT_ZERO']
 if nonzero:
  peak=max(p['log_mean'] for p in nonzero)
  logmean=peak+math.log(math.fsum(math.exp(p['log_mean']-peak)*(p['n']/n) for p in nonzero))
 else:logmean=-math.inf
 return {'n':n,**represented(logmean),'perfect_zero_rows':sum(p['perfect_zero_rows'] for p in parts),'ordinary_row_overflow':sum(p['ordinary_row_overflow'] for p in parts)}

def merge_reports(reports):
 """Caller supplies every authenticated SID exactly once, including zero-support SIDs."""
 reports=list(reports)
 if not reports:raise ValueError('empty report inventory')
 first=reports[0]
 expected_views={'pooled_2024_2025','2024','2025'}
 expected_supports={'HAR_EWMA':('HAR','EWMA'),'HAR_PERSISTENCE':('HAR','PERSISTENCE'),'EWMA_PERSISTENCE':('EWMA','PERSISTENCE'),'COMMON_THREE':('HAR','EWMA','PERSISTENCE')}
 if any(r['schema']!='q26-o188-qlike-scale-report-v1' or r['H']!=24 or set(r['views'])!=expected_views for r in reports):raise ValueError('report schema/calendar inventory')
 result={k:v for k,v in first.items() if k not in ('views','all_J','out_of_period_J')}
 result.update(series=len(reports),all_J=sum(r['all_J'] for r in reports),out_of_period_J=sum(r['out_of_period_J'] for r in reports),views={})
 for view in first['views']:
  parts=[r['views'][view] for r in reports]
  if any(set(p['supports'])!=set(expected_supports) for p in parts):raise ValueError('support inventory')
  v={k:sum(p[k] for p in parts) for k in ('J','target_unavailable','operational_fallback')}
  v['forecast_unavailable']={k:sum(p['forecast_unavailable'][k] for p in parts) for k in ('HAR','EWMA','PERSISTENCE')};v['supports']={}
  for name in first['views'][view]['supports']:
   source=[p['supports'][name] for p in parts];support={k:sum(p[k] for p in source) for k in ('paired_positive_forecasts','target_excluded','n','incomplete_future')}
   for block in ('original_target_paired','complete_future_paired'):
    cells=[p[block] for p in source];n=sum(p['n'] for p in cells);arms=expected_supports[name]
    if any(set(p['QLIKE'])!=set(arms) or set(p['squared_log_sigma'])!=set(arms) for p in cells):raise ValueError('arm inventory')
    c={'n':n,'QLIKE':{},'squared_log_sigma':{},'QLIKE_comparisons':{},'squared_log_comparisons':{}}
    for k in arms:
     if any(p['QLIKE'][k]['n']!=p['n'] for p in cells):raise ValueError('metric denominator')
     if any(p['n'] and (p['squared_log_sigma'][k] is None or not math.isfinite(p['squared_log_sigma'][k]) or p['squared_log_sigma'][k]<0) for p in cells):raise ValueError('squared-log mean')
     c['QLIKE'][k]=merge_qlike(p['QLIKE'][k] for p in cells)
     c['squared_log_sigma'][k]=math.fsum(p['squared_log_sigma'][k]*(p['n']/n) for p in cells if p['n']) if n else None
    for i,k in enumerate(arms):
     for other in arms[i+1:]:
      key=k+'_minus_'+other;c['QLIKE_comparisons'][key]=comparison(c['QLIKE'][k],c['QLIKE'][other]);c['squared_log_comparisons'][key]=c['squared_log_sigma'][k]-c['squared_log_sigma'][other] if n else None
    support[block]=c
   v['supports'][name]=support
  result['views'][view]=v
 return result
