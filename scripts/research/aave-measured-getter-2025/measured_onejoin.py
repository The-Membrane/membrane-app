"""INERT one pure stock/lag join. No cache/history/network/model access."""
import argparse,hashlib,json,types,resource,time,signal,sys
FIXED={'join': (8362, '0534e5118af878ad1b9888bb85f1d2231456461b0f8a76dd5832523930dc593c'), 'admission': (13722, '42263013ffa14b967c33a4c9e9c2ea7fac6ec6248af7c90acc711fccf266d8b6'), 'kernel': (9698, '232c1e53907fe21056d74a1f5dc944d528a9166b0bc6899d57922eb730f39555')}
from pathlib import Path
def need(v,c):
 if not v:raise ValueError(c)
def read(d):
 need(type(d)is dict and set(d)=={'path','bytes','sha256'} and type(d['bytes'])is int,'descriptor')
 p=Path(d['path']);need(p.is_absolute() and not any(x.is_symlink() for x in (p,*p.parents)),'absolute_regular_input')
 b=p.read_bytes();need(len(b)==d['bytes'] and hashlib.sha256(b).hexdigest()==d['sha256'],'input_pin');return b
if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--config',type=Path,required=True);ap.add_argument('--config-sha256',required=True);a=ap.parse_args();need(a.config.is_absolute(),'absolute_config')
 cb=a.config.read_bytes();need(hashlib.sha256(cb).hexdigest()==a.config_sha256,'config_pin');c=json.loads(cb)
 # Null/authorization guard precedes every data read and output creation.
 need(c['executionAuthorized']is True and all(c['inputs'].get(k)is not None for k in ('raw','calendar','features','proof','witness','authority','cache')) and c['output']is not None,'inert_missing_admission')
 start=time.monotonic();cpu=time.process_time()
 resource.setrlimit(resource.RLIMIT_CPU,(10,12));resource.setrlimit(resource.RLIMIT_AS,(256*2**20,256*2**20));resource.setrlimit(resource.RLIMIT_FSIZE,(2*2**20,2*2**20))
 signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(ValueError('internal_wall')));signal.alarm(25)
 need(set(c['dependencies'])==set(FIXED),'dependency_membership')
 for name,d in c['dependencies'].items():need((d['bytes'],d['sha256'])==FIXED[name],'fixed_source_pin')
 need(c['launcher']['path']==str(Path(__file__).resolve()),'own_path');own=read(c['launcher'])
 paths=[a.config,Path(__file__)]+[Path(d['path']) for d in c['dependencies'].values()]+[Path(d['path']) for k,d in c['inputs'].items() if k!='cache']
 def state(p):
  q=p.stat();return (q.st_dev,q.st_ino,q.st_size,q.st_mtime_ns,q.st_ctime_ns)
 before={str(p):state(p) for p in paths};modules={}
 for name,d in c['dependencies'].items():
  b=read(d);m=types.ModuleType(name);exec(compile(b,d['path'],'exec'),m.__dict__);modules[name]=m
 J,A,K=modules['join'],modules['admission'],modules['kernel']
 J.checked_source_bytes({k:read(c['dependencies'][k]) for k in ('admission','kernel')})
 bodies={k:read(d) for k,d in c['inputs'].items() if k!='cache'}
 out=Path(c['output']);need(out.is_absolute() and not out.exists() and out.parent.is_dir() and not any(x.is_symlink() for x in (out.parent,*out.parents)),'fresh_output')
 result=J.join_admitted(*(bodies[k] for k in ('raw','calendar','features','proof','witness','authority')),c['inputs'],A,K)
 need(len(result)<=2*2**20,'output_cap')
 need(all(state(p)==before[str(p)] for p in paths),'prewrite_bookends')
 with out.open('xb') as f:f.write(result);f.flush();__import__('os').fsync(f.fileno())
 need(out.read_bytes()==result,'output_pin')
 for k,d in c['inputs'].items():
  if k!='cache':need(read(d)==bodies[k],'final_input_bytes')
 for d in c['dependencies'].values():read(d)
 need(read(c['launcher'])==own and a.config.read_bytes()==cb and all(state(p)==before[str(p)] for p in paths),'final_bookends')
 measured={'CPUSeconds':time.process_time()-cpu,'wallSeconds':time.monotonic()-start,'RSSKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'outputBytes':out.stat().st_size}
 need(measured['CPUSeconds']<=10 and measured['wallSeconds']<25 and measured['RSSKiB']<=128*1024 and measured['outputBytes']<=2*2**20,'final_resources');signal.alarm(0)
 print(json.dumps({'resources':measured,'inputSourceConfigStatBookends':True,'inputSourceConfigBytePins':True,'status':'JOIN_COMPLETED_REQUIRES_EXTERNAL_EXIT0','output':{'path':str(out),'bytes':len(result),'sha256':hashlib.sha256(result).hexdigest()},'measurementProfile':A.PROFILE,'profileLimits':A.LIMITS,'cachePasses':0,'RPC':0,'fit':False},sort_keys=True))
