"""Q26 R16.2e: per-cell strict GRU two-way z on development (seen). Usage: python3 r162e_cellz.py WORK DEV_ROWS"""
import sys, numpy as np, json
sys.path.insert(0,'/home/user/membrane-app/scripts/research/history-forecasts')
import r16_dev as D
W=sys.argv[1]; DEV=sys.argv[2]
out={}
for T in (1,3,12):
    Z=np.load(f'{DEV}/rows-T{T}.npz'); S=np.load(f'{W}/strict/rows-strict-T{T}.npz')
    sid,ts,y,fH=Z['sid'],Z['ts'],Z['y'].astype(float),Z['fH'].astype(float)
    kr=(sid.astype(np.int64)<<32)|ts; kc=(S['sid'].astype(np.int64)<<32)|S['ts']; o=np.argsort(kc)
    pos=np.clip(np.searchsorted(kc[o],kr),0,len(kc)-1); hit=kc[o][pos]==kr
    p=np.full(fH.shape,np.nan); p[hit]=S['ngru'][o][pos[hit]]
    m=np.isfinite(p).all(1)
    for j,k in enumerate(D.LV[T]):
        d=(p[m,j]-y[m,j])**2-(fH[m,j]-y[m,j])**2
        blk=(ts[m]//(28*86400)).astype(np.int64)
        z=D.TwoWay(sid[m],blk,B=2000).z(d)
        c=f'{D.TL[T]} {k}'
        out[c]={'mean':z['mean'],'sd':z['sd2'],'sd_s':z['sd_series'],'sd_b':z['sd_block'],'z':z['z'],'S':z['S'],'K':z['K'],
                'pct_p':z['pct_p'],'R':float(p[m,j].sum()/y[m,j].sum()),'RfH':float(fH[m,j].sum()/y[m,j].sum()),'rows':int(m.sum())}
        print(c, {k_:round(v,5) if isinstance(v,float) else v for k_,v in out[c].items()})
json.dump(out,open(f'{W}/strict/cellz.json','w'),indent=1)
