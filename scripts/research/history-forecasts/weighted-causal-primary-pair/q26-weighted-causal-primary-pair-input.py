"""SOURCE ONLY: explicit original primary T24/k5 or T72/k7 altcoin input seam.
No I/O at import, launch, discovery, CAL fit, score or authority to read inputs.
Caller authenticates source/runtime/input bytes and exact sorted membership.
NumPy and an archive loader are injected. Original joint-mask rules are retained.
"""
import ast
from dataclasses import dataclass
import hashlib
from pathlib import Path

RANGES_SHA='64743b5a6c99b4a8387f573dede3e8ad03c16bc3262d176d9c4b92e24a0ce7d4'
SCORE_SHA='151b6eb0c3f8543fe6b4e11c560407eacac3ce4780ce7068f9609c5e86055142'
CONTROLS=('p_fH','p_rec12','p_a','p_f','p_fbL')
BASE=('y','day','T_h','k_i','t0_i')

def need(ok,msg):
    if not ok: raise ValueError(msg)

@dataclass(frozen=True)
class PrimaryCell:
    horizon_hours:int=24
    level_index:int=5
    tier:str='alts'
    def __post_init__(self):
        need(type(self.horizon_hours) is int and type(self.level_index) is int and
             (self.horizon_hours,self.level_index,self.tier) in ((24,5,'alts'),(72,7,'alts')),'only original primary T24/k5 or T72/k7 alts')

def contracts(np,ranges_raw,score_raw):
    """Authenticate original sg function, MAJOR and block origin; no CAL compiled."""
    need(type(ranges_raw) is bytes and hashlib.sha256(ranges_raw).hexdigest()==RANGES_SHA,'original ranges source')
    need(type(score_raw) is bytes and hashlib.sha256(score_raw).hexdigest()==SCORE_SHA,'original score source')
    rt=ast.parse(ranges_raw); st=ast.parse(score_raw)
    def literal(name):
        for node in st.body:
            if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in node.targets):return ast.literal_eval(node.value)
        raise ValueError('original literal '+name)
    f=next(n for n in rt.body if isinstance(n,ast.FunctionDef) and n.name=='sg_of')
    env=dict(hashlib=hashlib,N_SG=5)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[f],type_ignores=[])),'<original sg_of>','exec'),env)
    need(literal('BLOCK_ORIGIN_DAY')==17532,'block origin')
    return dict(major=literal('MAJOR'),sg_of=env['sg_of'],block_origin=17532)

def _integer(np,a,name,n=None):
    need(a.ndim==1 and a.dtype.kind in 'iu' and (n is None or len(a)==n),name+' integer vector')
    return a

def stream_primary(np,files,original,*,cell=PrimaryCell(),np_load=None,checkpoint=lambda:None):
    """Retain sorted global catalogue IDs and exact original stored joint mask.
    Only one full shard alive; selected copies survive. Partial controls cast to
    float32 before masking exactly as load_rows. Partial 2D boot_q is refused,
    because original padding is 1D and cannot concatenate; no invented repair.
    """
    need(type(cell) is PrimaryCell,'explicit original primary cell')
    files=tuple(str(Path(f)) for f in files)
    need(bool(files) and len(files)<=130 and files==tuple(sorted(set(files))),'sorted unique file inventory up to130 shards')
    load=np.load if np_load is None else np_load
    catalogue=[];clusters={};names=[]
    for si,path in enumerate(files):
        checkpoint()
        with load(path,allow_pickle=False) as z:
            name=str(z['name']);members=frozenset(z.files)
        need(all(k in members for k in BASE+('name','levels','base_ts')),'required shard geometry')
        need(name not in names,'duplicate series name')
        names.append(name);cl=original['major'].get(name,name);cid=clusters.setdefault(cl,len(clusters))
        catalogue.append((si,path,name,cid,members))
    present={k:sum(k in c[4] for c in catalogue) for k in CONTROLS+('boot_q',)}
    need(all(present[k] for k in CONTROLS),'globally absent control')
    has_boot=bool(present['boot_q'])
    need(not has_boot or present['boot_q']==len(files),'original partial 2D boot_q concatenation unsupported')
    parts={k:[] for k in ('p','y','day','series','cluster','row_index')}
    for si,path,name,cid,members in catalogue:
        checkpoint()
        with load(path,allow_pickle=False) as z:
            need(frozenset(z.files)==members and str(z['name'])==name,'catalogue metadata drift')
            a={k:z[k] for k in BASE};n=len(a['y'])
            need(n<=20_000_000,'reviewed shard row bound')
            need(a['y'].ndim==1,'one dimensional outcome')
            for k in BASE[1:]: _integer(np,a[k],k,n)
            levels=z['levels'];base=z['base_ts']
            need(levels.ndim==1 and len(levels)==10 and levels.dtype.kind=='f' and np.isfinite(levels).all(),'ten finite level values')
            expected_level={24:-0.15,72:-0.25}[cell.horizon_hours]
            need(float(levels[cell.level_index])==expected_level,'original primary level geometry')
            need(base.shape==() and base.dtype.kind in 'iu','integer base timestamp')
            base=int(base);t=a['t0_i']
            need(0<=base<=2**63-1,'nonnegative signed base timestamp')
            # Guard arithmetic before int64 conversion; no timestamp wraparound.
            need(n==0 or (int(t.min())>=0 and int(t.max())<=(2**63-1-base)//3600),'timestamp overflow or negative origin')
            need(-(2**63)<=base<=2**63-1,'base timestamp range')
            ts=base+3600*t.astype(np.int64)
            need(np.all(ts%86400==0) and np.array_equal(a['day'],ts//86400),'midnight origin/day drift')
            need(np.all(np.isin(a['T_h'],(24,72,168,720))) and np.all((a['k_i']>=0)&(a['k_i']<10)),'cell geometry drift')
            m=(a['T_h']==cell.horizon_hours)&(a['k_i']==cell.level_index)&(name not in original['major'])
            predictions={}
            for k in CONTROLS:
                if k in members:
                    v=z[k];need(v.shape==(n,) and v.dtype==np.dtype('float16'),'stored float16 control geometry')
                    if present[k]!=len(files):v=v.astype(np.float32)
                else:v=np.full(n,np.nan,np.float32)
                predictions[k]=v;m &= np.isfinite(v)
            if has_boot:
                b=z['boot_q'];need(b.shape==(n,5) and b.dtype==np.dtype('float16'),'stored float16 boot geometry')
                m &= np.all(np.isfinite(b),axis=1)
            # Selection is on stored/padded arrays; promote selected p and y only.
            take=int(m.sum())
            for k,v in dict(p=predictions['p_fH'][m].astype(np.float64),y=a['y'][m].astype(np.float64),day=a['day'][m].astype(np.int64),
                            series=np.full(take,si,np.int16),cluster=np.full(take,cid,np.int16),row_index=np.flatnonzero(m)).items():parts[k].append(v)
        if has_boot:del b
        del a,predictions,m,levels,t,ts,v
    rows={k:np.concatenate(v) for k,v in parts.items()}
    sgmap=original['sg_of'](clusters,None);rows['sg']=np.array([sgmap[int(c)] for c in rows['cluster']],np.int16)
    return dict(rows=rows,names=tuple(names),clusters=clusters,file_order=files,has_boot=has_boot,
                cell=(cell.horizon_hours,cell.level_index,cell.tier),original_joint_mask=True,scope='original-primary descriptive input only; historical float32 identity unestablished')
