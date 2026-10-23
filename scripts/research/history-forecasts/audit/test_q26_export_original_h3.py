"""Generated source-holder exporter tests, standard library only."""
import hashlib,importlib.util,json,os,stat,struct,tempfile,unittest,warnings,zipfile
from pathlib import Path
from unittest.mock import patch
P=Path(__file__).with_name('q26_export_original_h3.py')
if not P.exists():P=Path(__file__).with_name('q26-o197-export-h3.py')
s=importlib.util.spec_from_file_location('exporter',P);E=importlib.util.module_from_spec(s);s.loader.exec_module(E)
def npy(field,n=3,descr=None,shape=None,fortran=False,version=1,body=None):
 descr=descr or E.DTYPES[field];shape=(n,)if shape is None else shape;h=repr({'descr':descr,'fortran_order':fortran,'shape':shape}).encode();prefix=10 if version==1 else 12;h+=b' '*((-prefix-len(h)-1)%64)+b'\n';payload=bytes(n*E.ITEMSIZE.get(descr,8))if body is None else body
 return b'\x93NUMPY'+bytes([version,0])+struct.pack('<H'if version==1 else '<I',len(h))+h+payload
def members():return {name:npy(field)for field,name in zip(E.FIELDS,E.MEMBERS)}
class Tests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory(dir='/private/tmp');self.root=Path(self.t.name);self.rows=self.root/'rows.npz';self.meta=self.root/'meta.json';self.meta.write_text(json.dumps({'beta':{},'round_trip_max_rel':{},'series':[{'key':'synthetic','cls':'crypto','sub':'fixture','asset':'synthetic'}]}));self.out=self.root/'export';self.disk=patch.object(E,'disk',lambda *a:None);self.disk.start()
 def tearDown(self):self.disk.stop();self.t.cleanup()
 def write(self,data=None,extra=None,compression=zipfile.ZIP_STORED):
  data=members()if data is None else data
  with warnings.catch_warnings():
   warnings.simplefilter('ignore')
   with zipfile.ZipFile(self.rows,'w',compression=compression)as z:
    for name,b in data.items():z.writestr(name,b)
    for name,b in extra or []:z.writestr(name,b)
 def export(self):return E.export_fixture(self.rows,self.meta,self.out,expected_rows_sha256=E.digest(self.rows.read_bytes()),expected_meta_sha256=E.digest(self.meta.read_bytes()))
 def refuse(self,data=None,extra=None):
  self.write(data,extra)
  with self.assertRaises((ValueError,zipfile.BadZipFile)):self.export()
  self.assertFalse(self.out.exists())
 def test_original_member_bytes_deterministic_stored_and_lineage(self):
  data=members();data['h1_ignored.npy']=npy('cls');self.write(data,compression=zipfile.ZIP_DEFLATED);r=self.export();self.assertTrue(r['fixture_only']);self.assertFalse(r['authoritative_source_holder_export']);self.assertEqual(r['catalog_lineage']['series'],1)
  with zipfile.ZipFile(self.out/'rows-r16-h3.npz')as z:
   self.assertEqual(z.namelist(),list(E.MEMBERS))
   for name in E.MEMBERS:
    self.assertEqual(z.read(name),data[name]);i=z.getinfo(name);self.assertEqual(i.compress_type,zipfile.ZIP_STORED);self.assertEqual(i.date_time,(1980,1,1,0,0,0));self.assertEqual(i.external_attr>>16,stat.S_IFREG|0o600)
  second=self.root/'second';r2=E.export_fixture(self.rows,self.meta,second,expected_rows_sha256=E.digest(self.rows.read_bytes()),expected_meta_sha256=E.digest(self.meta.read_bytes()));self.assertEqual(r['archive'],r2['archive']);self.assertEqual((self.out/'manifest.json').read_bytes(),(second/'manifest.json').read_bytes())
 def test_cli_authority_no_override_and_bad_hash_no_output(self):
  self.write()
  with self.assertRaisesRegex(ValueError,'rows SHA256'):E.export(self.rows,self.meta,self.out)
  self.assertFalse(self.out.exists())
  with self.assertRaisesRegex(ValueError,'metadata SHA256'):E.export_fixture(self.rows,self.meta,self.out,expected_rows_sha256=E.digest(self.rows.read_bytes()),expected_meta_sha256='0'*64)
  self.assertFalse(self.out.exists())
 def test_duplicate_missing_extra_names(self):
  self.refuse(extra=[(E.MEMBERS[0],npy('cls'))]);d=members();d.pop(E.MEMBERS[-1]);self.refuse(d);self.refuse(extra=[('h3_unexpected.npy',npy('cls'))])
 def test_name_traversal_and_symlink_member(self):
  self.refuse(extra=[('../outside.npy',npy('cls'))]);self.write()
  with zipfile.ZipFile(self.rows,'a')as z:
   info=zipfile.ZipInfo('evil.npy');info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(info,b'outside')
  with self.assertRaisesRegex(ValueError,'unsafe ZIP'):self.export()
  self.assertFalse(self.out.exists())
 def test_dtype_shape_version_fortran_and_truncated(self):
  for bad in [npy('cls',descr='|O'),npy('cls',descr='<f8'),npy('cls',shape=(3,1)),npy('cls',shape=(-1,)),npy('cls',fortran=True),npy('cls',version=3),npy('cls')[:-1]]:
   d=members();d[E.MEMBERS[0]]=bad;self.refuse(d)
  d=members();d[E.MEMBERS[-1]]=npy('lns1',n=4);self.refuse(d)
 def test_v2_header_preserved(self):
  d={name:npy(f,version=2)for f,name in zip(E.FIELDS,E.MEMBERS)};self.write(d);self.export()
  with zipfile.ZipFile(self.out/'rows-r16-h3.npz')as z:self.assertEqual(z.read(E.MEMBERS[0]),d[E.MEMBERS[0]])
 def test_header_cap_and_literal_not_executed(self):
  d=members();d[E.MEMBERS[0]]=b'\x93NUMPY\x01\x00'+struct.pack('<H',4096)+b' '*4095+b'\n';self.refuse(d)
  h=b"{'descr': __import__('os').system('false'), 'fortran_order':False, 'shape':(3,)}\n";d[E.MEMBERS[0]]=b'\x93NUMPY\x01\x00'+struct.pack('<H',len(h))+h+bytes(3);self.refuse(d)
 def test_cap_and_disk_failures_cleanup_new_output(self):
  self.write()
  for key,value in [('SOURCE_CAP',1),('MEMBER_CAP',1),('OUTPUT_CAP',1),('META_CAP',1)]:
   with patch.object(E,key,value):
    with self.assertRaises(ValueError):self.export()
   self.assertFalse(self.out.exists())
  calls=[]
  def disk(*_):
   calls.append(1)
   if len(calls)>1:raise ValueError('disk reserve')
  with patch.object(E,'disk',disk):
   with self.assertRaisesRegex(ValueError,'disk reserve'):self.export()
  self.assertFalse(self.out.exists());self.assertGreater(len(calls),1)
 def test_symlink_inputs_and_existing_output_preserved(self):
  self.write();alias=self.root/'alias';alias.symlink_to(self.rows)
  with self.assertRaisesRegex(ValueError,'symlink input'):E.export_fixture(alias,self.meta,self.out,expected_rows_sha256=E.digest(self.rows.read_bytes()),expected_meta_sha256=E.digest(self.meta.read_bytes()))
  self.out.mkdir();(self.out/'keep').write_text('keep')
  with self.assertRaisesRegex(ValueError,'fresh canonical output'):self.export()
  self.assertEqual((self.out/'keep').read_text(),'keep')
 def test_replaced_output_directory_is_not_deleted(self):
  self.write();real_open=E.os.open;moved=self.root/'owned-renamed';triggered=[]
  def replace(path,flags,*a,**kw):
   if path=='rows-r16-h3.npz' and flags&os.O_CREAT and not triggered:
    triggered.append(True);self.out.rename(moved);self.out.mkdir();(self.out/'unowned-sentinel').write_text('preserve');raise OSError('generated write failure')
   return real_open(path,flags,*a,**kw)
  with patch.object(E.os,'open',replace):
   with self.assertRaises(OSError):self.export()
  self.assertEqual((self.out/'unowned-sentinel').read_text(),'preserve');self.assertTrue(moved.is_dir());self.assertEqual(list(moved.iterdir()),[])
 def test_foreign_same_name_file_not_deleted_on_exclusive_failure(self):
  self.write();real_open=E.os.open;triggered=[]
  def insert(path,flags,*a,**kw):
   if path=='rows-r16-h3.npz' and flags&os.O_CREAT and not triggered:
    triggered.append(True);(self.out/'rows-r16-h3.npz').write_text('foreign-sentinel')
   return real_open(path,flags,*a,**kw)
  with patch.object(E.os,'open',insert):
   with self.assertRaises(FileExistsError):self.export()
  self.assertEqual((self.out/'rows-r16-h3.npz').read_text(),'foreign-sentinel')
 def test_central_directory_count_bound_before_constructor(self):
  self.write();raw=bytearray(self.rows.read_bytes());at=raw.rfind(b'PK\x05\x06');raw[at+8:at+12]=struct.pack('<HH',257,257);self.rows.write_bytes(raw)
  with patch.object(E.zipfile,'ZipFile',side_effect=AssertionError('constructor must not run')):
   with self.assertRaisesRegex(ValueError,'bounded single-disk directory'):self.export()
  self.assertFalse(self.out.exists())
 def test_crc_corruption_removes_partial_output(self):
  self.write();raw=bytearray(self.rows.read_bytes())
  # Alter a payload byte while retaining the original central-directory CRC.
  with zipfile.ZipFile(self.rows)as z:
   i=z.getinfo(E.MEMBERS[0]);offset=i.header_offset+30+len(i.filename)+len(i.extra)+len(npy('cls'))-1
  raw[offset]^=1;self.rows.write_bytes(raw)
  with self.assertRaises(zipfile.BadZipFile):self.export()
  self.assertFalse(self.out.exists())
if __name__=='__main__':unittest.main()
