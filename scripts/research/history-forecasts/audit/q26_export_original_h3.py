"""Source-holder byte export only; no NumPy, numeric decoding or scoring.
Schema: exact r16_diag.py FIELDS159–160, writer193–216/228 (ec9a67ed…).
q2 remains bool from r134_library.py614–616; native writer is little-endian.
CLI authority is fixed. Fixture API is explicitly non-authoritative.
"""
import argparse,ast,hashlib,json,os,shutil,stat,struct,zipfile
from pathlib import Path
ROWS_SHA='4e05590f8366d72cd68241c3de8b7a2d74c396b001bd70d41d9cc68bcd6264c5'
META_SHA='05df637d654d227267a35b0187cb927d949fed5df820d085b8a76130fc4c58cc'
WRITER_SHA='ec9a67ed0d5d9e54733ef03f18275896cee2b62c08b13d8ddcec1c05b4136996'
FIELDS=('cls','sid','day','end','age','q2','depth','lns0','lnrv','lnD','lnW','lnM','lnLR','lnEW','lnRVcc','spike','vov','vr','lns1')
DTYPES={k:('|i1' if k=='cls' else '<i4' if k in ('sid','day','end','age') else '|b1' if k=='q2' else '<f8' if k in ('depth','lns0') else '<f4')for k in FIELDS}
ITEMSIZE={'|i1':1,'|b1':1,'<i4':4,'<f4':4,'<f8':8}
MEMBERS=tuple('h3_'+k+'.npy'for k in FIELDS)
SOURCE_CAP=1073741824;OUTPUT_CAP=268435456;MEMBER_CAP=67108864;HEADER_CAP=4096;META_CAP=1048576;MANIFEST_CAP=65536;RESERVE=536870912;CHUNK=1048576

def need(ok,message):
 if not ok:raise ValueError(message)
def digest(b):return hashlib.sha256(b).hexdigest()
def file_hash(f):
 f.seek(0);h=hashlib.sha256()
 while b:=f.read(CHUNK):h.update(b)
 return h.hexdigest()
def safe_file(path,cap):
 p=Path(path).absolute();need(p.resolve(strict=True)==p,'symlink input path');fd=os.open(p,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0));f=os.fdopen(fd,'rb')
 try:
  st=os.fstat(fd);need(stat.S_ISREG(st.st_mode) and st.st_size<=cap,'input regular file/cap');return p,f,st
 except BaseException:f.close();raise

def unchanged(path,f,original):
 now=os.fstat(f.fileno());leaf=path.lstat();need((now.st_dev,now.st_ino,now.st_size,now.st_mtime_ns)==(original.st_dev,original.st_ino,original.st_size,original.st_mtime_ns) and (leaf.st_dev,leaf.st_ino)==(now.st_dev,now.st_ino) and not stat.S_ISLNK(leaf.st_mode),'input changed')
def zip_directory(f,size):
 # Bound constructor metadata before ZipFile allocates the central directory.
 n=min(size,65557);f.seek(size-n);tail=f.read(n);at=tail.rfind(b'PK\x05\x06');need(at>=0 and at+22<=len(tail),'ZIP end record');sig,diskno,cd_disk,n_disk,n_total,cd_size,cd_offset,comment=struct.unpack('<4s4H2LH',tail[at:at+22]);need(at+22+comment==len(tail) and diskno==cd_disk==0 and n_disk==n_total and 0<n_total<=256 and cd_size<=65536 and cd_offset+cd_size==size-n+at,'bounded single-disk directory');f.seek(0);return n_total

def exact(f,n):
 b=f.read(n);need(len(b)==n,'truncated member');return b

def header(f,field,size):
 need(size<=MEMBER_CAP,'member cap');prefix=exact(f,8);need(prefix[:6]==b'\x93NUMPY' and prefix[6:8]in (b'\x01\x00',b'\x02\x00'),'NPY magic/version');width=2 if prefix[6]==1 else 4;length=struct.unpack('<H' if width==2 else '<I',exact(f,width))[0];need(0<length<=HEADER_CAP-8-width,'header cap');raw=exact(f,length);need(raw.endswith(b'\n'),'header newline')
 try:
  tree=ast.parse(raw.decode('ascii').strip(),mode='eval').body;need(type(tree)is ast.Dict and len(tree.keys)==3,'literal header fields');h=ast.literal_eval(tree)
 except (ValueError,SyntaxError,UnicodeError,RecursionError)as exc:raise ValueError('invalid literal header')from exc
 need(type(h)is dict and set(h)=={'descr','fortran_order','shape'},'header fields');need(type(h['descr'])is str and h['descr']==DTYPES[field],'numeric writer dtype');need(h['fortran_order']is False,'Fortran order');shape=h['shape'];need(type(shape)is tuple and len(shape)==1 and type(shape[0])is int and shape[0]>0,'one dimensional positive shape');n=shape[0];need(n<=MEMBER_CAP//ITEMSIZE[h['descr']] and 8+width+length+n*ITEMSIZE[h['descr']]==size,'payload geometry')
 return {'dtype':h['descr'],'shape':[n],'header_bytes':8+width+length}

def metadata(b,authoritative):
 def pairs(xs):
  out={}
  for k,v in xs:need(k not in out,'duplicate metadata key');out[k]=v
  return out
 def bad(_):raise ValueError('nonfinite metadata')
 def floating(x):
  import math
  v=float(x);need(math.isfinite(v),'nonfinite metadata');return v
 q=json.loads(b.decode('utf-8'),object_pairs_hook=pairs,parse_constant=bad,parse_float=floating);need(type(q)is dict and set(q)=={'beta','round_trip_max_rel','series'},'metadata schema');rows=q['series'];need(type(rows)is list and rows and (not authoritative or len(rows)==1955),'catalog count');seen=set();catalog=[]
 for r in rows:
  need(type(r)is dict and set(r)=={'key','cls','sub','asset'} and all(type(v)is str for v in r.values()),'catalog fields');key=(r['cls'],r['key']);need(key not in seen,'catalog duplicate');seen.add(key);catalog.append({k:r[k]for k in ('key','cls','sub','asset')})
 return {'ordered_catalog_SHA256':digest(json.dumps(catalog,sort_keys=True,separators=(',',':')).encode()),'series':len(rows),'classes':len({r['cls']for r in rows})}

def disk(parent,remaining=0):need(shutil.disk_usage(parent).free>=RESERVE+remaining,'disk reserve')
def zip_info(name):
 z=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0));z.compress_type=zipfile.ZIP_STORED;z.create_system=3;z.external_attr=(stat.S_IFREG|0o600)<<16;z.extra=b'';z.comment=b'';return z

def _export(rows,meta,out,expected_rows,expected_meta,authoritative):
 rp,rf,rs=safe_file(rows,SOURCE_CAP);mf=None;made=False;dest=Path(out).absolute();owned_fd=None;owned_identity=None;created_files={};source_sha=digest(Path(__file__).read_bytes())
 def owned():
  need(owned_fd is not None,'output directory not bound');st=dest.lstat();need(not stat.S_ISLNK(st.st_mode) and (st.st_dev,st.st_ino)==owned_identity,'output directory replaced')
 def output_open(name,flags):
  owned();fd=os.open(name,flags|getattr(os,'O_NOFOLLOW',0),0o600,dir_fd=owned_fd)
  if flags&os.O_CREAT:
   st=os.fstat(fd);created_files[name]=(st.st_dev,st.st_ino)
  return fd
 def output_stat(name):return os.stat(name,dir_fd=owned_fd,follow_symlinks=False)
 try:
  mp,mf,ms=safe_file(meta,META_CAP);need(rp!=mp,'distinct inputs');need(file_hash(rf)==expected_rows,'rows SHA256');mb=mf.read(META_CAP+1);need(len(mb)==ms.st_size and digest(mb)==expected_meta,'metadata SHA256');lineage=metadata(mb,authoritative);unchanged(rp,rf,rs);unchanged(mp,mf,ms)
  need(dest.parent.resolve(strict=True)==dest.parent and not dest.exists() and not dest.is_symlink(),'fresh canonical output');records=[]
  entries=zip_directory(rf,rs.st_size)
  with zipfile.ZipFile(rf,'r')as source:
   infos=source.infolist();names=[i.filename for i in infos];need(len(infos)==entries and len(names)==len(set(names)),'duplicate ZIP names/directory count')
   for i in infos:
    mode=i.external_attr>>16;kind=stat.S_IFMT(mode);need(i.filename and '/'not in i.filename and '\\'not in i.filename and '\x00'not in i.filename and not i.is_dir() and kind in (0,stat.S_IFREG),'unsafe ZIP member type/name')
   h3=[i for i in infos if i.filename.startswith('h3_')];need(len(h3)==19 and {i.filename for i in h3}==set(MEMBERS),'exact nineteen h3 members');sizes={i.filename:i.file_size for i in h3};need(all(0<s<=MEMBER_CAP for s in sizes.values()),'member cap')
   # Exact STORED archive footprint: local header + name + bytes + central header.
   archive_bound=22+sum(sizes[n]+76+2*len(n.encode('ascii'))for n in MEMBERS);need(archive_bound+MANIFEST_CAP<=OUTPUT_CAP,'output cap');disk(dest.parent,archive_bound+MANIFEST_CAP)
   geometry=None
   for field,name in zip(FIELDS,MEMBERS):
    info=source.getinfo(name);need(not info.flag_bits&1 and info.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED),'ZIP encoding')
    with source.open(info)as f:h=header(f,field,info.file_size)
    if geometry is None:geometry=h['shape']
    need(h['shape']==geometry,'shared h3 shape');records.append({'name':name,'bytes':info.file_size,**h})
   dest.mkdir(mode=0o700);made=True;owned_fd=os.open(dest,os.O_RDONLY|getattr(os,'O_DIRECTORY',0)|getattr(os,'O_NOFOLLOW',0));st=os.fstat(owned_fd);owned_identity=(st.st_dev,st.st_ino);need(st.st_mode&0o777==0o700,'output directory mode');archive=dest/'rows-r16-h3.npz'
   fd=output_open(archive.name,os.O_RDWR|os.O_CREAT|os.O_EXCL)
   with os.fdopen(fd,'w+b')as output,zipfile.ZipFile(output,'w',compression=zipfile.ZIP_STORED,allowZip64=False)as target:
    for record in records:
     h=hashlib.sha256();count=0
     with source.open(record['name'])as reader,target.open(zip_info(record['name']),'w')as writer:
      while True:
       b=reader.read(min(CHUNK,record['bytes']-count+1))
       if not b:break
       count+=len(b);need(count<=record['bytes'],'member grew');disk(dest.parent,len(b));h.update(b);writer.write(b)
     need(count==record['bytes'],'truncated member');record['SHA256']=h.hexdigest()
   owned();need(output_stat(archive.name).st_size==archive_bound and output_stat(archive.name).st_mode&0o777==0o600,'deterministic ZIP geometry/mode')
  # Re-read every exported member, verifying identical original NPY bytes, not values.
  with os.fdopen(output_open(archive.name,os.O_RDONLY),'rb')as af,zipfile.ZipFile(af)as verify:
   need(verify.namelist()==list(MEMBERS),'output member order')
   for record in records:
    info=verify.getinfo(record['name']);need(info.compress_type==zipfile.ZIP_STORED and info.file_size==record['bytes'] and info.date_time==(1980,1,1,0,0,0) and info.external_attr>>16==stat.S_IFREG|0o600,'output ZIP metadata');h=hashlib.sha256();count=0
    with verify.open(info)as reader:
     while b:=reader.read(CHUNK):h.update(b);count+=len(b)
    need(count==record['bytes'] and h.hexdigest()==record['SHA256'],'output member hash')
  need(file_hash(rf)==expected_rows and file_hash(mf)==expected_meta,'final input hashes');unchanged(rp,rf,rs);unchanged(mp,mf,ms);disk(dest.parent)
  with os.fdopen(output_open(archive.name,os.O_RDONLY),'rb')as f:archive_sha=file_hash(f)
  need(digest(Path(__file__).read_bytes())==source_sha,'exporter source changed')
  manifest={'schema':'q26-o197-original-h3-member-export-v1','label':'CODEX CONTINUATION','complete':True,'authoritative_source_holder_export':authoritative,'fixture_only':not authoritative,'input':{'filename':rp.name,'bytes':rs.st_size,'SHA256':expected_rows},'metadata':{'filename':mp.name,'bytes':ms.st_size,'SHA256':expected_meta},'catalog_lineage':lineage,'original_writer':{'filename':'r16_diag.py','SHA256':WRITER_SHA,'FIELDS_lines':'159-160','dtype_and_member_writer_lines':'193-217,228'},'archive':{'filename':archive.name,'bytes':output_stat(archive.name).st_size,'SHA256':archive_sha},'exporter_source_SHA256':source_sha,'receipt_lineage_limit':'Source-holder execution receipt, not a standalone cryptographic membership proof. A recipient must verify trusted holder execution or access the authenticated full source archive; a self-reported source archive hash alone is not independent original-row identity.','members':records,'NPY_bytes_unchanged':True,'numeric_values_decoded':False,'filters_or_dtype_conversions':False,'models_fitted':0,'downstream_score_or_clean_encoder_established':False,'execution_authorizes_downstream_use':False}
  b=(json.dumps(manifest,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode();need(len(b)<=MANIFEST_CAP and output_stat(archive.name).st_size+len(b)<=OUTPUT_CAP,'manifest/output cap');disk(dest.parent,len(b));fd=output_open('manifest.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL)
  with os.fdopen(fd,'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
  owned();need(digest(Path(__file__).read_bytes())==source_sha,'exporter source changed');return manifest
 except BaseException:
  # Never recursively remove an unowned replacement directory. Bound file cleanup
  # uses the original directory descriptor even if its pathname was renamed.
  if made and owned_fd is not None:
   for name,identity in created_files.items():
    try:
     st=output_stat(name)
     if (st.st_dev,st.st_ino)==identity:os.unlink(name,dir_fd=owned_fd)
    except FileNotFoundError:pass
   try:
    owned();os.rmdir(dest)
   except (ValueError,OSError):pass
  raise
 finally:
  if owned_fd is not None:os.close(owned_fd)
  rf.close()
  if mf is not None:mf.close()

def export(rows,meta,out):return _export(rows,meta,out,ROWS_SHA,META_SHA,True)
def export_fixture(rows,meta,out,*,expected_rows_sha256,expected_meta_sha256):
 """Generated fixtures only: cannot produce authoritative export status."""
 return _export(rows,meta,out,expected_rows_sha256,expected_meta_sha256,False)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--rows',required=True);p.add_argument('--meta',required=True);p.add_argument('--out',required=True);a=p.parse_args();r=export(a.rows,a.meta,a.out);print(json.dumps({'complete':True,'members':len(r['members']),'archive_SHA256':r['archive']['SHA256'],'numeric_values_decoded':False,'downstream_authorized':False}))
