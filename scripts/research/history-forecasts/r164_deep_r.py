"""Q26 R16.4 deep-tail calibration: R = sum p / sum y with a pigeonhole two-way (cluster x 182-day block) bootstrap of
ln R at 3 d and 7 d, levels -25/-30/-40%, for (fH), rec12 and (f). Run from this directory. Seen data only."""
import os, sys, numpy as np, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from r164_score import load_rows, cells
rows,names,cl=load_rows('/tmp/claude-0/r164/dev/rows')
rng=np.random.default_rng(5)
out={}
for T in (72,168):
  for k in (7,8,9):
    m=(rows['T_h']==T)&(rows['k_i']==k)&np.isfinite(rows['p_rec12'])&np.isfinite(rows['p_fH'])
    y=rows['y'][m].astype(float)
    res={}
    for mod in ('fH','rec12','f'):
        p=rows['p_'+mod][m].astype(float)
        (My,Mp),S,B=cells(rows['cluster'][m],rows['block182'][m],[y,p])
        ws=rng.multinomial(S,np.full(S,1/S),size=2000).astype(float); wb=rng.multinomial(B,np.full(B,1/B),size=2000).astype(float)
        ny=np.einsum('rs,sb,rb->r',ws,My,wb); npp=np.einsum('rs,sb,rb->r',ws,Mp,wb)
        lr=np.log(npp/ny)
        R=Mp.sum()/My.sum()
        res[mod]={'R':float(R),'sd_lnR':float(np.std(lr)),'ci90':[float(np.exp(np.quantile(lr,.05))),float(np.exp(np.quantile(lr,.95)))],
                  'p_in_band':float(np.mean(np.abs(lr)<np.log(1.25)))}
    res['events']=int(y.sum()); res['S']=S; res['B']=B
    out[f'{T}_{k}']=res
    print(T,k,res)
json.dump(out,open('/tmp/claude-0/r164/out/deep-R.json','w'),indent=1)
