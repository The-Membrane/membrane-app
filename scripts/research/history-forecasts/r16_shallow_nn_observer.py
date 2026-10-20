"""Read-only frame observation of unchanged original neural orchestration."""
from __future__ import annotations
import ast
import hashlib
import inspect
import json
from pathlib import Path
import sys
import numpy as np

MODELS=('nmlp','ngru','ntcn','ntfm','nmlp0')
ORDER=[(sh,tt,m) for sh in (0,1) for tt in (0,1) for m in MODELS]


class AllocationComplete(BaseException):
    """Intentional BEFORE-make_model stop; not a completed training run."""


def anchors(function):
    """Resolve semantic statements; require the exact original statement contracts."""
    source=Path(inspect.getsourcefile(function));tree=ast.parse(source.read_text())
    target=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='run_tier')
    start=[];finish=[]
    for n in ast.walk(target):
        if isinstance(n,ast.Assign) and ast.unparse(n)=='net = make_model(m, len(STATIC) + 2 + nT, L)':start.append(n.lineno)
        if isinstance(n,ast.Expr) and isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Name) and n.value.func.id=='log':finish.append(n.lineno)
    if len(start)!=1 or len(finish)!=1 or start[0]>=finish[0]:raise ValueError('original observation anchors changed')
    return str(source.resolve()),start[0],finish[0]


def array_hash(value,dtype=None):
    a=np.ascontiguousarray(value,dtype=dtype)
    return dict(shape=list(a.shape),dtype=a.dtype.str,nbytes=a.nbytes,sha256=hashlib.sha256(a.tobytes()).hexdigest())


def membership(indices,R,groups):
    """Hash actual ordered indices and unambiguous composite row identities."""
    ix=np.asarray(indices,dtype='<i8');h=hashlib.sha256()
    dtype=np.dtype([('core_index','<i8'),('sid','<i4'),('ts','<i8'),('T','<i4'),('Tidx','<i4')])
    for begin in range(0,len(ix),8192):
        part=ix[begin:begin+8192];rows=np.empty(len(part),dtype=dtype);rows['core_index']=part
        for k in ('sid','ts','T','Tidx'):rows[k]=R[k][part]
        h.update(rows.tobytes())
    g,c=np.unique(groups[ix],return_counts=True)
    return dict(count=len(ix),ordered_indices=array_hash(ix),sorted_indices=array_hash(np.sort(ix)),
        row_identity_sha256=h.hexdigest(),row_identity_dtype=dtype.descr,
        groups={str(int(k)):int(v) for k,v in zip(g,c)})


class Observer:
    def __init__(self,function,persist,allocation=False,observe_resources=lambda:{}):
        self.filename,self.before,self.after=anchors(function);self.code=function.__code__
        self.persist=persist;self.allocation=allocation;self.resources=observe_resources
        self.pending=None;self.completed=[];self.starts=0;self.allocation_receipt=None
    def __call__(self,frame,event,arg):
        if frame.f_code is not self.code:return None
        if event=='line':
            loc=frame.f_locals
            if frame.f_lineno==self.before:
                ordinal=len(self.completed);identity=(loc['sh'],loc['tt'],loc['m'])
                if ordinal>=20 or identity!=ORDER[ordinal] or self.pending is not None:raise ValueError('fit order differs')
                R,grp=loc['R'],loc['grp'];self.starts+=1
                self.pending=dict(ordinal=ordinal,cell=list(identity[:2]),model=identity[2],tsplit_float=float(loc['tsplit']),
                    membership={k:membership(loc[k],R,grp) for k in ('tr_all','tr_full','tr','va','te')})
                if self.allocation:
                    self.allocation_receipt=dict(status='allocation-only-before-first-make_model',neural_fits=0,
                        completed=False,first_membership=self.pending,resources=self.resources(),
                        allocated_prediction_matrices={m:dict(shape=list(a.shape),dtype=a.dtype.str,nbytes=a.nbytes) for m,a in loc['preds'].items()},
                        pooled_fields={k:dict(shape=list(a.shape),dtype=a.dtype.str,nbytes=a.nbytes) for k,a in R.items()},
                        historical_feature_bytes=sum(a.nbytes for v in loc['SA'].values() for a in v.values() if isinstance(a,np.ndarray)))
                    self.persist('allocation.json',self.allocation_receipt);raise AllocationComplete()
            elif frame.f_lineno==self.after:
                if self.pending is None:raise ValueError('fit completion without start')
                actual=dict(loc['info']['fits'][-1])
                if (actual['cell'],actual['model'])!=(self.pending['cell'],self.pending['model']):raise ValueError('fit metadata differs')
                for old,new in (('train','tr'),('val','va'),('test','te')):
                    if actual[old]!=self.pending['membership'][new]['count']:raise ValueError('membership count differs')
                receipt=dict(self.pending,original_fit=actual,resources=self.resources())
                self.persist(f'fit-{len(self.completed):02d}.json',receipt)
                self.completed.append(receipt);self.pending=None
        return self
    def install(self):
        if sys.gettrace() is not None:raise RuntimeError('existing trace prohibited')
        sys.settrace(self)
    def uninstall(self):sys.settrace(None)
    def require_complete(self):
        if len(self.completed)!=20 or self.starts!=20 or self.pending is not None:raise ValueError('all20 fits required')
        return [r['original_fit'] for r in self.completed]


def coverage(out,models=MODELS):
    """All models/all levels must share the complete original daily support."""
    out=Path(out);records={}
    for T,width in ((1,3),(3,4),(12,5)):
        with np.load(out/f'rows-T{T}.npz',allow_pickle=False) as z:
            sid=z['sid'];ts=z['ts'];daily=ts%86400==0
        with np.load(out/f'rows-nn-T{T}.npz',allow_pickle=False) as z:
            if set(z.files)!={'sid','ts',*models}:raise ValueError('NN output schema differs')
            for k,v in (('sid',sid),('ts',ts)):
                if array_hash(z[k])!=array_hash(v):raise ValueError('NN row order differs')
            if not daily.any():raise ValueError('empty daily support')
            hashes={}
            for m in models:
                p=z[m]
                if p.dtype!=np.dtype('float32') or p.shape!=(len(ts),width):raise ValueError('NN dtype/shape differs')
                if not np.isfinite(p[daily]).all() or not np.isnan(p[~daily]).all():raise ValueError('daily coverage differs')
                if np.any(p[daily]<0) or np.any(p[daily]>1) or np.any(np.diff(p[daily],axis=1)>0):raise ValueError('invalid touch probabilities')
                hashes[m]=array_hash(p)
        records[str(T)]=dict(rows=len(ts),daily_rows=int(daily.sum()),models=hashes)
    return records
