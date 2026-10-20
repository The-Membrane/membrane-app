# Temporary reviewed derivative: R masks logS index1; divisor14 and all other math unchanged.
"""Portable A-only derivative; pure functions, no I/O or execution entry point.

Derived from frozen kernel.py (9102 bytes), SHA256
485c0b2c9586262a0e0f8fadcb57fd32af038b31ccbb742a2b26b9b6e8ee63eb.
Retains the first 14 coordinates, population scaling, distance divisor 14,
integer weights, eight-cell rolling TRAIN selection and scenario semantics.
No official utilization input is read or imputed. C/S still reflects utilization.

This library does not admit blockchain evidence: callers must validate chain,
clock, block hash, state qualification, audited lags and cohort membership.
Structural checks below do not substitute for that admission. No historical
run or parity result establishes predictive skill or native holder exit ability.
"""
import math
from fractions import Fraction as F
RAY=10**27
DAY=86400
H=(900,3600,21600,86400)
Q=(10**12,10**13,25*10**12,10**14)
BANDWIDTHS=(0.5,1.0,2.0,'infinity')
def need(ok,code):
 if not ok:raise ValueError(code)
def number(x,signed=False):
 need(type(x)is str and len(x)<=100 and str(int(x))==x,'canonical_integer');v=int(x);need(signed or v>=0,'unsigned');return v

def coordinates(row):
 C=number(row['physicalCashRaw']);S=number(row['nominalClaimsRaw']);need(S>0,'feature_domain')
 x=[float(F(C,S)),math.log(S)];previous=[0]*5
 for w in (3600,21600,86400,604800):
  a=row['lags'][str(w)];current=[number(a[k]) for k in ('incomingRaw','outgoingRaw')]+[a[k] for k in ('incomingEventCount','outgoingEventCount','zeroNetEventCount')]
  need(all(type(v)is int and v>=0 for v in current) and type(a['totalEventCount'])is int and a['totalEventCount']==sum(current[2:]) and number(a['netRaw'],True)==current[0]-current[1],'audited_lag_identity')
  band=[a-b for a,b in zip(current,previous)];need(all(v>=0 for v in band),'disjoint_band_nonnegative');previous=current
  net=band[0]-band[1];gross=band[0]+band[1];x.extend([float(F(net,S)),float(F(gross,S)),math.log1p(sum(band[2:]))])
 need(len(x)==14 and all(math.isfinite(v) for v in x),'finite_coordinates');return x

def preprocessing(vectors):
 need(vectors and all(len(x)==14 and all(math.isfinite(v) for v in x) for x in vectors),'preprocessing_shape');n=len(vectors)
 means=[math.fsum(x[k] for x in vectors)/n for k in range(14)]
 sd=[math.sqrt(math.fsum((x[k]-means[k])**2 for x in vectors)/n) for k in range(14)]
 return {'means':means,'populationSD':sd,'zeroSDColumns':[k for k,v in enumerate(sd) if v==0],'donorCount':n}
def zscore(x,prep):
 return [(x[k]-prep['means'][k])/s if s else 0.0 for k,s in enumerate(prep['populationSD'])]
def weights(vectors,target,prep,bw,arm="A"):
 need(arm in ('R','A') and bw in BANDWIDTHS,'kernel_parameters')
 if bw=='infinity':return [1]*len(vectors)
 zt=zscore(target,prep);zs=[zscore(v,prep) for v in vectors];active=range(14) if arm=='A' else (0,*range(2,14));d=[math.fsum((v[k]-zt[k])**2 for k in active)/14 for v in zs]
 need(d and all(math.isfinite(v) and v>=0 for v in d),'distance_domain');low=min(d)
 return [max(1,math.floor(2**40*math.exp(-(v-low)/(2*bw*bw)))) for v in d]
def ess(ws):
 W=sum(ws);need(ws and all(type(w)is int and w>0 for w in ws),'integer_weights')
 return {'scenarioCount':len(ws),'KishScenarioESS':F(W*W,sum(w*w for w in ws)),'maxWeight':F(max(ws),W),'HHI':F(sum(w*w for w in ws),W*W)}
def crps(values,ws,y):
 need(values and len(values)==len(ws) and all(type(w)is int and w>0 for w in ws),'crps_domain');W=sum(ws);pair=F(0);beforeW=0;beforeX=F(0)
 for x,w in sorted(zip(values,ws)):
  x=F(x);pair+=w*(x*beforeW-beforeX);beforeW+=w;beforeX+=w*x
 return sum((w*abs(F(x)-y) for x,w in zip(values,ws)),F(0))/W-pair/(W*W)
def quantile(values,ws,q):
 total=sum(ws);c=0
 for x,w in sorted(zip(values,ws)):
  c+=w
  if c>=q*total:return x
 raise ValueError('quantile_domain')
def cdf_less(values,ws,q):return F(sum(w for v,w in zip(values,ws) if v<q),sum(ws))
def distribution_scores(values,ws,y,scale):
 a,b,c=[quantile(values,ws,q) for q in (F(1,10),F(1,2),F(9,10))];score=crps(values,ws,y);out={'CRPSRaw':score,'CRPSOverClaims':score/scale,'MAERaw':abs(b-y),'coverage80':F(a<=y<=c),'width80Raw':c-a}
 for name,q,x in [('pinball10',F(1,10),a),('pinball50',F(1,2),b),('pinball90',F(9,10),c)]:out[name+'Raw']=max(q*(y-x),(q-1)*(y-x))
 return out

def scenario_values(ix,donor,target,kind):
 if kind.startswith('claims'):
  need(donor['S']>0 and target['S']>0,'positive_claims');scale=F(target['S'],donor['S']);terminal=target['C']+scale*(ix.terminal-ix.base);minimum=target['C']+scale*(ix.minimum-ix.base)
 elif kind.startswith('raw') or kind=='empirical90_change_bounded':terminal=F(target['C']+ix.terminal-ix.base);minimum=F(target['C']+ix.minimum-ix.base)
 elif kind in ('native_same_slot','empirical90_level'):terminal=F(ix.terminal);minimum=F(ix.minimum)
 elif kind=='persistence':terminal=minimum=F(target['C'])
 else:raise ValueError('scenario_kind')
 negative=(minimum<0,terminal<0)
 if kind in ('claims_bounded','raw_bounded','empirical90_change_bounded'):terminal=max(F(0),terminal);minimum=max(F(0),minimum)
 return terminal,minimum,negative

def scenario_label(P,K,ix,donor,target,q,kind):
 # max(0,x)<q iff x<q for q>0: flooring changes no event/run/gap label.
 need(type(q)is int and q>0,'positive_query')
 if kind.startswith('claims'):return K.index_label(P,ix,q,target['C'],target['S'],donor['S'],'claims')[0]
 if kind.startswith('raw') or kind=='empirical90_change_bounded':return ix.query(q,target['C'])
 if kind in ('native_same_slot','empirical90_level'):return ix.query(q,ix.base)
 if kind=='persistence':return P.label([(0,target['C'])],q,ix.h)
 raise ValueError('scenario_kind')

def choose_bandwidth(scores):
 need(set(scores)==set(BANDWIDTHS),'all_bandwidths');best=min(scores.values());eligible=[b for b in BANDWIDTHS if scores[b]<=best+F(1,10**12)];return eligible[-1]
def cv_select(train,index,arm="A"):
 need(len(train)==59 and all(r['split']=='TRAIN' for r in train) and all(train[i]['T']<train[i+1]['T'] for i in range(58)),'fixed_TRAIN')
 totals={bw:F(0) for bw in BANDWIDTHS};audit=[]
 for target in train:
  donors=[r for r in train if r['T']+DAY<target['T']]
  if len(donors)<28:continue
  vectors=[r['x'] for r in donors];prep=preprocessing(vectors);audit.append({'issueAt':target['T'],'donors':len(donors),'lastDonorEndpoint':max(r['T']+DAY for r in donors),'zeroSD':prep['zeroSDColumns']})
  for bw in BANDWIDTHS:
   ws=weights(vectors,target['x'],prep,bw,arm);loss=F(0)
   for h in H:
    targetix=index(target['T'],h);values=[scenario_values(index(r['T'],h),r,target,'claims_bounded') for r in donors]
    loss+=crps([v[0] for v in values],ws,targetix.terminal)/target['S'];loss+=crps([v[1] for v in values],ws,targetix.minimum)/target['S']
   totals[bw]+=loss/8
 need(audit,'CV_support_empty');scores={b:v/len(audit) for b,v in totals.items()}
 return {'selected':choose_bandwidth(scores),'scoresExact':scores,'rollingSupport':audit,'CVOriginCount':len(audit),'endpointMinimumCellsPerOrigin':8,'tieTolerance':F(1,10**12),'noQSpecificOptimization':True}

def coherence(probabilities):
 counts={'QMonotonic':0,'minimumHorizonMonotonic':0,'minimumBelowEndpoint':0};worst={k:F(0) for k in counts}
 def record(k,gap):
  if gap>0:counts[k]+=1;worst[k]=max(worst[k],gap)
 for h in H:
  for a,b in zip(Q,Q[1:]):
   for kind in ('endpoint','minimum'):record('QMonotonic',probabilities[kind,h,a]-probabilities[kind,h,b])
  for q in Q:record('minimumBelowEndpoint',probabilities['endpoint',h,q]-probabilities['minimum',h,q])
 for a,b in zip(H,H[1:]):
  for q in Q:record('minimumHorizonMonotonic',probabilities['minimum',a,q]-probabilities['minimum',b,q])
 return {'counts':counts,'maxViolation':worst,'endpointHorizonMonotonicityRequired':False}

def forecast_issue(P,K,target,donors,index,ws,kind):
 need(donors and len(donors)==len(ws),'donor_weights');preds={};probs={};ctx=K.weight_context([F(w) for w in ws])
 for h in H:
  vals=[scenario_values(index(d['T'],h),d,target,kind) for d in donors];endpoints=[v[0] for v in vals];minima=[v[1] for v in vals]
  for q in Q:
   labs=[scenario_label(P,K,index(d['T'],h),d,target,q,kind) for d in donors];summary=K.summary(labs,[F(w) for w in ws],sum(v[2][0] for v in vals),ctx)
   probs['endpoint',h,q]=cdf_less(endpoints,ws,q);probs['minimum',h,q]=cdf_less(minima,ws,q);need(probs['minimum',h,q]==summary['probability'],'path_interval_CDF_identity')
   preds[q,h]={'summary':summary,'endpoint':endpoints,'minimum':minima,'labels':labs,'weights':ws,'endpointRisk':probs['endpoint',h,q],'intervalRisk':probs['minimum',h,q],'rawNegativePathCount':sum(v[2][0] for v in vals),'rawNegativePathMass':F(sum(w for w,v in zip(ws,vals) if v[2][0]),sum(ws)),'rawNegativeTerminalMass':F(sum(w for w,v in zip(ws,vals) if v[2][1]),sum(ws))}
 return preds,coherence(probs)

def cell_scores(K,truth,pred,scale):
 out=K.loss(truth,pred['summary']);end=int(truth['terminalCashRaw']);mini=int(truth['minimumCashRaw']);ws=pred['weights']
 for kind,y in [('endpoint',end),('minimum',mini)]:out.update({kind+'.'+k:v for k,v in distribution_scores(pred[kind],ws,y,scale).items()});p=pred['endpointRisk'] if kind=='endpoint' else pred['intervalRisk'];out[kind+'.BrierStrictShortage']=(p-int(y< pred['Q']))**2
 for field in ('totalTimeBelowQSeconds','longestUninterruptedShortfallSeconds'):out[field+'.CRPSSeconds']=crps([l[field] for l in pred['labels']],ws,truth[field])
 for kind,field in [('firstShortage','firstShortageDelaySeconds'),('firstRecovery','firstRecoveryDelaySeconds')]:
  cdf=pred['summary'][kind]['unconditionalCDF'];out[kind+'.unconditionalGridBrier']=sum(((p-int(truth[field] is not None and truth[field]<=t))**2 for t,p in cdf.items()),F(0))/len(cdf)
 return out
