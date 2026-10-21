import importlib.util,hashlib,json
from pathlib import Path
from fractions import Fraction as F
from itertools import product
import numpy as np
P=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-horizon-coherence-v1/horizon_coherence.py')
def load(p,n):
 s=importlib.util.spec_from_file_location(n,p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=load(P,'subject');oracle=load('/private/tmp/q26-pav-theorem-check.py','oracle');source=hashlib.sha256(P.read_bytes()).hexdigest()
fixtures=[np.array(x,float) for x in product([0,.25,.5,.75,1],repeat=5)]
special=[0.,np.nextafter(0.,1.),np.nextafter(np.finfo(float).tiny,0.),np.finfo(float).tiny,np.nextafter(.5,0.),.5,np.nextafter(.5,1.),np.nextafter(1.,0.),1.]
fixtures += [np.array([b,a,c,b,a]) for a,b,c in product(special[::2],repeat=3)]
rng=np.random.default_rng(123);fixtures+=list(rng.random((100,5)))
worst=F(0);tests=0
for p in fixtures:
 exact=oracle.pav(tuple(F.from_float(float(x)) for x in p));q=m.pav_vector(p)
 assert np.array_equal(q,np.array(list(map(float,exact))))
 for k in range(6):
  y=np.array([0.]*k+[1.]*(5-k));fr=lambda a:tuple(F.from_float(float(x)) for x in a)
  gap=oracle.loss(fr(q),fr(y))-oracle.loss(fr(p),fr(y))+oracle.loss(fr(p),fr(q));worst=max(worst,gap)
  assert gap<=m.LOSS_BUDGET_EXACT
  computed=((q-y)**2).sum()-((p-y)**2).sum()+((p-q)**2).sum()
  assert computed<=m.LOSS_BUDGET
  tests+=1
# Exact joins are independent of labels and robust to H-specific row permutations.
data={};pred={};ids=np.array([4,2,9,1],np.int32)
for i,h in enumerate(m.HORIZONS):
 order=np.roll(np.arange(4),i);data[h]={'sid':ids[order],'ts':np.full(4,m.EVAL,np.int64),'issue_eligible':np.ones(4,bool),'p_fH_valid':np.ones(4,bool)};pred[h]=np.full((6,4,5),.5)
pred[12][:,np.flatnonzero(data[12]['sid']==9),:]=np.nan
key,ix,support=m.join_five(data,pred);assert key['sid'].tolist()==[1,2,4]
for h in m.HORIZONS:assert data[h]['sid'][ix[h]].tolist()==[1,2,4]
# complete masks prefix, one all-complete nested vector, others incomplete only late.
for i,h in enumerate(m.HORIZONS):
 data[h]['label_valid']=np.array([int(s)!=2 or i<2 for s in data[h]['sid']],bool);data[h]['y']=np.full((4,5),int(i>=2),np.uint8)
L,y,masks=m.label_support(data,ix);assert L.tolist()==[True,False,True]
# A longer complete label with missing shorter must refuse.
data[6]['label_valid'][np.flatnonzero(data[6]['sid']==1)]=False
try:m.label_support(data,ix)
except ValueError:pass
else:raise AssertionError('prefix violation accepted')
# Every boundary is left inclusive; nextafter to each side checks adjacent bins.
ps=np.r_[m.EDGES,np.nextafter(m.EDGES[1:-1],0),np.nextafter(m.EDGES[1:-1],1)]
cal=m.calibration(np.zeros(len(ps)),ps);assert sum(x['n'] for x in cal)==len(ps)
for p in ps:
 bins=m.calibration(np.array([1]),np.array([p]));wanted=next(i for i in range(9) if m.EDGES[i]<=p and (p<m.EDGES[i+1] or (i==8 and p<=1)))
 assert bins[wanted]['n']==1 and sum(x['n'] for x in bins)==1
print(json.dumps({'source_snapshot_sha256':source,'pav_vectors':len(fixtures),'nested_loss_checks':tests,'loss_budget':m.LOSS_BUDGET,'worst_positive_exact_rounded_gap':str(worst),'joins_and_prefix_and_calibration':'PASS','scope':'kernel only; source unstable; no payload'},indent=2))
