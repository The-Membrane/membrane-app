#!/usr/bin/env python3
"""Independent read-only NumPy verifier. Never imports producer/model modules."""
import argparse,datetime,hashlib,io,json,zipfile
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parent
SOURCE=Path('/Users/EBmic/research-workspaces/history-forecasts-continuation')
SCOPE_SHA='17fc7a66b81c41838976a8541f53bc49f892e97f5631fc7323edb2ebd05f4055'
SUMMARY_SHA='bab3c5445894eeb2ec56307689452c101ef9831bdae95a1a486059b5a9a447bb'
EXPECTED={'1':1424924,'3':1424353,'12':1422858}
FIELDS=('sid','ts','y','fH','f','lsH','lsf','dm','wm','r24','r168','r720','dd720','rng24','lvol','btc_r24','btc_dm')
DTYPES={n:('int32' if n=='sid' else 'int64' if n=='ts' else 'int8' if n=='y' else 'float32') for n in FIELDS}
LEVELS={'1':3,'3':4,'12':5}
SENTINELS={0:'P1:KRAKEN-ETH',1:'dev:BTC',2:'dev:ETH',3:'A2:BNBUSDT',276:'blind8:ZROUSDT'}
def require(ok,message):
 if not ok:raise ValueError(message)
def sha(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def unique(pairs):
 d={}
 for k,v in pairs:
  require(k not in d,'duplicate JSON key');d[k]=v
 return d
def read(path):return json.loads(Path(path).read_text(),object_pairs_hook=unique)
def pin(entry):
 p=Path(entry['path']);require(p.is_file() and not p.is_symlink(),'pin is not regular file')
 require(p.stat().st_size==entry['size'] and sha(p)==entry['sha256'],'pin size/hash mismatch: '+str(p))
def descriptor(a):
 floating=np.issubdtype(a.dtype,np.floating);mask=np.isnan(a) if floating else np.zeros(a.shape,dtype=bool)
 return dict(shape=list(a.shape),dtype=a.dtype.str,nan_mask_sha256=hashlib.sha256(mask.tobytes(order='C')).hexdigest(),sha256=hashlib.sha256(a.tobytes(order='C')).hexdigest(),nbytes=a.nbytes,elements=a.size,finite=int(np.isfinite(a).sum()),nan=int(np.isnan(a).sum()) if floating else 0,positive_inf=int(np.isposinf(a).sum()) if floating else 0,negative_inf=int(np.isneginf(a).sum()) if floating else 0)
def arrays_check(values,horizon,sid,declared):
 require(set(values)==set(FIELDS),'wrong retained field set')
 n=declared;require(type(n) is int and n>=0,'invalid row count')
 for name,a in values.items():
  require(a.dtype==np.dtype(DTYPES[name]),'dtype mismatch: '+name)
  shape=(n,LEVELS[horizon]) if name in ('y','fH','f') else (n,)
  require(a.shape==shape,'shape mismatch: '+name)
 require(np.all(values['sid']==sid),'SID mismatch')
 ts=values['ts'];require(np.all(ts>0) and np.all(ts[1:]>ts[:-1]),'timestamps must be positive and strictly increasing')
 require(np.isin(values['y'],[0,1]).all(),'nonbinary labels')
 for name in ('fH','f'):
  a=values[name];require(np.isfinite(a).all() and np.all((a>=0)&(a<=1)),'probability bounds')
  require(np.all(a[:,1:]<=a[:,:-1]),'nonmonotone probabilities')
 return n
def order_check(outer,sid,key):require(outer.get('sid')==sid and outer.get('key')==key,'canonical shard order mismatch')
def payload_hash_check(actual,expected):require(actual==expected,'payload hash mismatch')
def selftest():
 def fixture():
  v={n:np.zeros((2,3) if n in ('y','fH','f') else (2,),dtype=DTYPES[n]) for n in FIELDS};v['ts'][:]=[100,200];return v
 arrays_check(fixture(),'1',0,2);failures=0
 for mutate in [lambda v:v.update(sid=v['sid'].astype('int64')),lambda v:v['sid'].__setitem__(0,1),lambda v:v['ts'].__setitem__(1,100),lambda v:v['f'].__setitem__((0,0),np.nan),lambda v:v.pop('rng24')]:
  v=fixture();mutate(v)
  try:arrays_check(v,'1',0,2)
  except ValueError:failures+=1
  else:raise AssertionError('negative array fixture accepted')
 for action in [lambda:order_check({'sid':1,'key':'a'},0,'a'),lambda:payload_hash_check('bad','expected')]:
  try:action()
  except ValueError:failures+=1
  else:raise AssertionError('negative metadata fixture accepted')
 return {'positive_fixture':1,'negative_fixtures_rejected':failures}
def verify():
 scope_path=ROOT/'generation-scope-v2.json';out=ROOT/'generation-run-v2';mp=out/'manifest.json'
 require(mp.is_file(),'no terminal generation manifest yet; do not infer completion')
 require(sha(scope_path)==SCOPE_SHA,'unaccepted frozen scope')
 scope=read(scope_path);base=scope['base_scope'];manifest=read(mp)
 require(scope['expected_rows']==EXPECTED and scope['series']==277,'scope target mismatch')
 require(manifest.get('complete') is True and manifest.get('status')=='complete' and manifest.get('scope_sha256')==SCOPE_SHA and manifest.get('series')==277,'not terminal accepted generation')
 require(manifest.get('merged') is False and manifest.get('neural_training') is False,'wrong output phase')
 require(manifest.get('audit_violations')=={'total':0,'attempts':[]},'audit denials')
 require(read(out/'run.json')==manifest,'terminal run/manifest disagreement')
 pin(scope['operational_recovery'])
 for k in ('request','summary','price_manifest','plan'):pin(base[k])
 require(base['summary']['sha256']==SUMMARY_SHA,'wrong summary identity')
 summary=read(base['summary']['path']);keys=summary['series'];require(summary.get('code')=='7bdaa124' and len(keys)==277 and len(set(keys))==277 and keys==base['canonical_keys'],'canonical summary mismatch')
 sourcepins=scope['source_sha256'];require(len(sourcepins)==23,'23 generation source pins required')
 for rel,digest in sourcepins.items():
  p=SOURCE/rel;require(p.resolve().is_relative_to(SOURCE) and sha(p)==digest,'source pin mismatch')
 proof=scope['proof']
 for k in ('scope','manifest','independent'):pin(proof[k])
 parity=read(proof['scope']['path']);old=parity['source_sha256'];require(len(old)==21 and all(sourcepins.get(k)==v for k,v in old.items()),'21 original source pins changed')
 for group in ('references','projections'):
  require(set(proof[group])==set(map(str,SENTINELS)),'sentinel reference closure mismatch')
  for p in proof[group].values():pin(p)
 raw=base['price_inputs']+base['auxiliary_inputs'];require(len(raw)==282 and len({p['path'] for p in raw})==282,'raw closure mismatch')
 require(sum(p['size'] for p in raw)==420675700,'raw byte total mismatch')
 for p in raw:pin(p)
 allowed={str(Path(p['path']).resolve()) for p in raw+[base['summary'],base['price_manifest']]}
 require(all(k in allowed and type(v) is int and v>0 for k,v in manifest['opened_inputs'].items()),'unlisted or invalid audited read')
 shards=out/'shards';require({p.name for p in shards.iterdir()}=={f'{i:03d}' for i in range(277)},'missing/extra shard directory')
 require(len(manifest['shards'])==277,'outer shard count mismatch')
 totals={h:0 for h in EXPECTED};comparisons=0;payloads=0;allbytes=0;uncompressed=0
 for sid,key in enumerate(keys):
  directory=shards/f'{sid:03d}';require(directory.is_dir() and not directory.is_symlink(),'nonregular shard directory')
  outer=manifest['shards'][sid];order_check(outer,sid,key);sm=directory/'manifest.json';record=read(sm)
  require(record.get('schema')=='r16-shallow-series-shard-v1' and record.get('canonical_sid')==sid and record.get('key')==key,'shard identity mismatch')
  require(record['fields']==list(FIELDS) and record['files']==outer['files'] and sha(sm)==outer['manifest_sha256'],'nested manifest mismatch')
  require(set(record['files'])<=set(EXPECTED),'unknown horizon')
  require({p.name for p in directory.iterdir()}=={'manifest.json'}|{f'rows-T{h}.npz' for h in record['files']},'unexpected shard content')
  actualbytes=sum(p.stat().st_size for p in directory.iterdir());require(actualbytes==outer['actual_file_bytes'] and actualbytes<=outer['write_bound_bytes'],'shard actual/bounded byte mismatch');allbytes+=actualbytes
  for horizon,entry in record['files'].items():
   require(entry['name']==f'rows-T{horizon}.npz' and entry['dtypes']==DTYPES,'payload name/dtype declaration mismatch')
   p=directory/entry['name'];require(p.is_file() and not p.is_symlink(),'nonregular payload');payload_hash_check(sha(p),entry['sha256'])
   if 'size' in entry:require(p.stat().st_size==entry['size'],'declared payload size mismatch')
   with zipfile.ZipFile(p) as z:
    infos=z.infolist();require(len(infos)==17 and {x.filename for x in infos}=={f'{n}.npy' for n in FIELDS},'NPZ membership mismatch')
    require(all(0<=x.file_size<=100000000 for x in infos),'unbounded NPZ member');uncompressed+=sum(x.file_size for x in infos)
   with np.load(p,allow_pickle=False) as z:
    require(len(z.files)==17 and set(z.files)==set(FIELDS),'duplicate/missing NPZ fields');values={n:z[n] for n in FIELDS}
   n=arrays_check(values,horizon,sid,entry['rows']);totals[horizon]+=n;payloads+=1
   if sid in SENTINELS:
    require(key==SENTINELS[sid],'fixed sentinel identity differs')
    reference=read(proof['references'][str(sid)]['path'])
    require(reference['sid']==sid and reference['key']==key and reference['arm']=='original' and reference['scope_sha256']==proof['scope']['sha256'],'sentinel reference provenance differs')
    expected=reference['descriptors'][horizon];require(expected['present'] is True and set(expected['fields'])==set(FIELDS),'sentinel reference fields mismatch')
    for name,a in values.items():require(descriptor(a)==expected['fields'][name],'sentinel raw descriptor mismatch');comparisons+=1
   del values
 require(totals==EXPECTED and manifest['row_totals']==EXPECTED,'row support mismatch')
 require(comparisons==255,'all five three-horizon sentinels required')
 require(manifest['sentinels']==[{'sid':sid,'key':key,'exact':True} for sid,key in SENTINELS.items()],'terminal sentinel ledger mismatch')
 require(allbytes==manifest['actual_file_bytes'] and sum(x['write_bound_bytes'] for x in manifest['shards'])==manifest['write_bound_bytes'],'aggregate shard bytes mismatch')
 require(sum(x['write_bound_bytes'] for x in manifest['shards'])<=base['disk_policy']['max_shards_bytes'],'frozen disk bound exceeded')
 return dict(complete=True,scope_sha256=SCOPE_SHA,canonical_series=277,row_totals=totals,source_pins=23,original_unchanged_source_pins=21,raw_input_pins=282,exact_sentinel_field_comparisons=comparisons,manifest_sha256=sha(mp),payload_files=payloads,actual_shard_bytes=allbytes,npz_uncompressed_bytes=uncompressed,verifier_sha256=sha(__file__),checked_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),qualification='Independent actual277-shard identity, arrays and five-original-sentinel verification. New reconstruction of seen development; not all historical arrays, neural performance or forward validity. Per-payload size is not declared in original nested format; actual aggregate shard sizes and frozen write bounds were verified.')
def main():
 p=argparse.ArgumentParser();p.add_argument('--self-test',action='store_true');p.add_argument('--out',type=Path,default=ROOT/'generation-independent-v2.json');a=p.parse_args()
 if a.self_test:print(json.dumps(selftest()));return
 require(not a.out.exists(),'verification output exists; choose a fresh output path')
 result=verify();a.out.write_text(json.dumps(result,indent=2,sort_keys=True)+'\n');print(json.dumps(result))
if __name__=='__main__':main()
