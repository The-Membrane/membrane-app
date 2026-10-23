# Q26 R16.2e power by resampling development rows into blind-shaped panels (D-R13.5c rule 1).
# Usage: python3 r162e_power.py WORK DEV_ROWS SxM,... T:j,... NREP TAG   (common calendar window for all S series)
"""resampled power for blind shapes (S series, M months each, contiguous), strict GRU vs fH, D-R13.5c rule 1."""
import sys, numpy as np, json, math
sys.path.insert(0,'/home/user/membrane-app/scripts/research/history-forecasts')
import r16_dev as D
from scipy.stats import norm
W, DEV = sys.argv[1], sys.argv[2]
shapes=[tuple(map(int,s.split('x'))) for s in sys.argv[3].split(',')]
cells=sys.argv[4].split(',')   # e.g. 3:0  (T:level index)
NREP=int(sys.argv[5]) if len(sys.argv)>5 else 200
alpha=0.05/len(cells)
data={}
for c in cells:
    T,j=map(int,c.split(':'))
    Z=np.load(f'{DEV}/rows-T{T}.npz'); S=np.load(f'{W}/strict/rows-strict-T{T}.npz')
    sid,ts,y,fH=Z['sid'],Z['ts'],Z['y'][:,j].astype(float),Z['fH'][:,j].astype(float)
    kr=(sid.astype(np.int64)<<32)|ts; kc=(S['sid'].astype(np.int64)<<32)|S['ts']; o=np.argsort(kc)
    pos=np.clip(np.searchsorted(kc[o],kr),0,len(kc)-1); hit=kc[o][pos]==kr
    p=np.full(len(ts),np.nan); p[hit]=S['ngru'][o][pos[hit]][:,j]
    m=np.isfinite(p)
    data[c]=dict(sid=sid[m],ts=ts[m],y=y[m],p=p[m],fH=fH[m])
rng=np.random.default_rng(7)
ref=data[cells[0]]
us=np.unique(ref['sid'])
span={s:(ref['ts'][ref['sid']==s].min(),ref['ts'][ref['sid']==s].max()) for s in us}
res={}
for (S_,M) in shapes:
    L=M*30*86400
    # COMMON calendar window for all S series (a real blind set shares its weeks); start uniform over feasible starts
    tmax=max(v[1] for v in span.values()); tmin=min(v[0] for v in span.values())
    starts=[t for t in np.arange(tmin, tmax-L, 30*86400) if sum(1 for s in us if span[s][0]<=t and span[s][1]>=t+L-86400*30)>=S_]
    elig=[len(starts)]
    out={c:[] for c in cells}
    for r in range(NREP):
        t0=rng.choice(starts)
        cand=[s for s in us if span[s][0]<=t0 and span[s][1]>=t0+L-86400*30]
        ch=rng.choice(cand,S_,replace=False)
        st={s:t0 for s in ch}
        for c in cells:
            d_=data[c]; idx=np.concatenate([np.where((d_['sid']==s)&(d_['ts']>=st[s])&(d_['ts']<st[s]+L))[0] for s in ch])
            y,p,f=d_['y'][idx],d_['p'][idx],d_['fH'][idx]
            d=(p-y)**2-(f-y)**2
            z=D.TwoWay(d_['sid'][idx],(d_['ts'][idx]//(28*86400)).astype(np.int64),B=1000,seed=r).z(d)
            cp=norm.cdf(z['z']) if z['z'] is not None else 1
            R=p.sum()/max(y.sum(),1)
            lk=D.leave_top_k(d_['sid'][idx],d)
            ok=(cp<alpha) and (z['pct_p']<alpha) and (0.8<=R<=1.25) and (lk['mean_after'] is not None and lk['mean_after']<0)
            out[c].append((z['z'],cp,z['pct_p'],R,ok,z['K']))
    summ={}
    for c in cells:
        a=np.array([x[:5] for x in out[c]],float)
        summ[c]={'power_test':float(np.mean((a[:,1]<alpha)&(a[:,2]<alpha))),'power_joint':float(a[:,4].mean()),
                 'z_med':float(np.median(a[:,0])),'z_q10':float(np.quantile(a[:,0],.1)),'z_q90':float(np.quantile(a[:,0],.9)),
                 'R_in_band':float(np.mean((a[:,3]>=.8)&(a[:,3]<=1.25))),'K_med':float(np.median([x[5] for x in out[c]]))}
    anyp=np.mean([any(out[c][r][4] for c in cells) for r in range(NREP)])
    res[f'{S_}x{M}']={'cells':summ,'any_cell_pass':float(anyp),'eligible_series':len(elig)}
    print(S_,M,len(elig),json.dumps({c:{k:round(v,3) for k,v in s.items()} for c,s in summ.items()}),'any',round(anyp,3),flush=True)
json.dump(res,open(f'{W}/strict/power-{sys.argv[6] if len(sys.argv)>6 else "x"}.json','w'),indent=1)
