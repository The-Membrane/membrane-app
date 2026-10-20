"""Synthetic contracts; Torch fixture skips explicitly in original Torch-free runtime."""
import copy
import importlib.util
import os
import json
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import r16_shallow_nn_observer as O
import r16_shallow_nn_protocol as P


def runtime_chain_fixture(root):
    from types import SimpleNamespace
    names=[f'p{i}' for i in range(30)];versions={n:'1' for n in names};records={};distributions=[]
    for name in names:
        member=Path(name+'.dist-info/RECORD');file=root/member;file.parent.mkdir();file.write_text('record')
        records[name]=P.R.pin(file)
        distributions.append(SimpleNamespace(metadata={'Name':name},files=[member],locate_file=lambda f:root/f))
    scope=root/'scope.json';scope.write_text(json.dumps(dict(schema='r16-shallow-torch-install-v1',versions=versions)))
    flags=dict(no_user_site=sys.flags.no_user_site,isolated=sys.flags.isolated)
    current=dict(base={'packages':list(versions.items())},torch_version='TEST',torch_threads=1,torch_interop_threads=8,deterministic_algorithms=False,python_flags=flags)
    probe=dict(complete=True,optimizer_steps=0,historical_inputs=False,denied_input_attempts=[],cpu_only=True,numpy_abi_shared_roundtrip=True,
        scope_sha256=P.R.A.sha(scope),inventory=versions,record_pins=records,native_pins=[],executable=sys.executable,prefix=str(root),base_prefix=sys.base_prefix,
        python_version=sys.version,torch_version='TEST',numpy_version=np.__version__,torch_threads=1,torch_interop_final=8,deterministic_algorithms=False,python_flags=flags)
    probe_path=root/'probe.json';probe_path.write_text(json.dumps(probe))
    install=dict(complete=True,probe=P.R.pin(probe_path),scope_sha256=P.R.A.sha(scope),download_report_packages=30,pip_check_passed=True,optimizer_fits=False,historical_inputs=False)
    install_path=root/'install.json';install_path.write_text(json.dumps(install))
    request=dict(runtime_probe_path=str(probe_path),runtime_install_manifest_path=str(install_path),runtime_install_scope_path=str(scope))
    return request,current,distributions,probe,install


def successor_runtime_fixture(root,probe):
    def write(path,value):path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value));return P.R.pin(path)
    versions=probe['inventory'];packages=[dict(name=n,version=v,url='https://invalid/'+n,sha256='a'*64) for n,v in versions.items()]
    lock=root/'wheels/lock.json';write(lock,dict(packages=packages))
    runtime_manifest=write(root/'wheels/manifest.json',dict(files={'lock.json':dict(bytes=lock.stat().st_size,sha256=P.R.A.sha(lock))}))
    source=root/'accepted.py';source.write_text('# synthetic source');source_pin=P.R.pin(source)
    old=dict(schema='r16-shallow-torch-install-v1',versions=versions,runtime_manifest=runtime_manifest,scripts=[source_pin],source_files=[source_pin])
    old_pin=write(root/'old-plan/scope.json',old);prior=[old_pin]
    failed=root/'failed'
    report=dict(install=[dict(metadata={'name':p['name'],'version':p['version']},download_info={'url':p['url'],'archive_info':{'hashes':{'sha256':p['sha256']}}}) for p in packages])
    prior.extend([write(failed/'run.json',dict(complete=False,stage='synthetic probe')),write(failed/'probe.json',dict(complete=False,error='unfrozen local import torch.ops',denied_input_attempts=[])),write(failed/'pip-report.json',report)])
    for name,text in (('pip-check.log','No broken requirements found.'),('probe.log','failed synthetic probe')):
        path=failed/name;path.write_text(text);prior.append(P.R.pin(path))
    scope=dict(old,schema=P.SUCCESSOR,parent_scope_sha256=old_pin['sha256'],original_installer_complete=False,prior_evidence=prior,
        runtime_identity=dict(versions=versions,record_pins=probe['record_pins'],native_pins=probe['native_pins']))
    scope_path=root/'successor-scope.json';scope_pin=write(scope_path,scope)
    corrected=dict(probe,scope_sha256=scope_pin['sha256']);probe_path=root/'successor-probe.json';probe_pin=write(probe_path,corrected)
    manifest=dict(complete=True,corrected_probe_complete=True,original_installer_complete=False,scope_sha256=scope_pin['sha256'],prior_scope_sha256=old_pin['sha256'],probe=probe_pin,versions=versions)
    manifest_path=root/'successor-manifest.json';write(manifest_path,manifest)
    request=dict(runtime_probe_path=str(probe_path),runtime_install_manifest_path=str(manifest_path),runtime_install_scope_path=str(scope_path))
    return request,scope,corrected,manifest,old_pin


class Contracts(unittest.TestCase):
    def test_membership_order_and_horizon_identity(self):
        R=dict(sid=np.array([0,0]),ts=np.array([1,1]),T=np.array([1,3]),Tidx=np.array([0,1]));g=np.array([0,0])
        a=O.membership([0,1],R,g);b=O.membership([1,0],R,g)
        self.assertNotEqual(a['ordered_indices'],b['ordered_indices']);self.assertEqual(a['sorted_indices'],b['sorted_indices'])
        self.assertNotEqual(a['row_identity_sha256'],b['row_identity_sha256'])
        R['T'][0]=12;self.assertNotEqual(a['row_identity_sha256'],O.membership([0,1],R,g)['row_identity_sha256'])
    def test_original_anchors_and_no_payload_bound(self):
        self.assertEqual(O.anchors(P.R.A.NN.run_tier)[1:],(280,330))
        b=P.archive_bounds();self.assertEqual(len(b),3)
        import r16_shallow_nn_monitor as N
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);out=root/'out';out.mkdir();escape=root/'escape';escape.mkdir();(out/'work-cache').symlink_to(escape,target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'root symlink'):N.cache_environment(out,create=True)
            self.assertEqual(list(escape.iterdir()),[])

        self.assertGreater(sum(b.values()),393_000_000);self.assertLess(sum(b.values()),394_000_000)
        import subprocess
        import r16_shallow_nn_monitor as N
        from unittest.mock import Mock
        with patch.object(N.subprocess,'run',return_value=Mock(returncode=1,stdout='',stderr='denied')):
            with self.assertRaisesRegex(RuntimeError,'RSS observation unavailable'):N.resident_bytes(123)
        with patch.object(N.subprocess,'run',side_effect=subprocess.TimeoutExpired('ps',5)):
            with self.assertRaisesRegex(RuntimeError,'RSS observation unavailable'):N.resident_bytes(123)
        for denied in (True,False):
            with tempfile.TemporaryDirectory() as t:
                out=Path(t)/'out';policy=dict(wall_seconds=28800,grace_seconds=30,rss_bytes=1000)
                scope=dict(out=str(out.resolve()),phase='allocation',resource_policy=policy,archive_bounds={},evidence={'inputs':{}})
                def stage(directory,inputs):directory.mkdir();return {}
                child=Mock(pid=987654);child.poll.return_value=None if denied else 0;child.wait.return_value=-15 if denied else 0
                timer=[0,0,1] if denied else [0,28801]
                with patch.object(P,'preflight',return_value=scope),patch.object(P,'disk',return_value={}),patch.object(P,'stage',side_effect=stage),patch.object(N.subprocess,'Popen',return_value=child),patch.object(N.os,'getpgid',return_value=child.pid),patch.object(N,'resident_bytes',side_effect=RuntimeError('RSS unavailable')),patch.object(N,'terminate_group') as kill,patch.object(N.time,'monotonic',side_effect=timer):
                    with self.assertRaisesRegex(RuntimeError,'RSS unavailable' if denied else 'wall cap'):N.run('scope','digest',out)
                value=P.R.A.read_unique_json(out/'monitor.json');self.assertFalse(value['complete'])
                self.assertEqual(kill.call_count,1 if denied else 0)
                self.assertEqual(P.R.A.read_unique_json(out/'monitor-start.json')['child_pgid'],child.pid)
    def test_hardlink_inodes_and_existing_output(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);source=root/'source';source.mkdir();pins={}
            for name in P.INPUTS:
                p=source/name;p.write_bytes(name.encode());pins[name]=P.R.pin(p)
            out=root/'out';proof=P.stage(out,pins)
            for name in P.INPUTS:
                self.assertEqual((source/name).stat().st_ino,(out/name).stat().st_ino)
                self.assertEqual(proof[name]['incremental_payload_bytes'],0)
            with self.assertRaises(FileExistsError):P.stage(out,pins)
            cache=out/'work-cache';cache.mkdir();same_name=cache/'rows-T1.npz';same_name.write_bytes(b'x'*33)
            with patch.object(P,'CACHE_BYTES',32),patch.object(P.shutil,'disk_usage',return_value=type('Usage',(),{'free':9_000_000_000})()):
                with self.assertRaisesRegex(RuntimeError,'allowance'):P.disk(out,{})
                same_name.write_bytes(b'x'*32);self.assertEqual(P.disk(out,{})['incremental_file_bytes'],32)
            (out/'rows-nn-T1.npz').write_bytes(b'a'*40);(out/'process.log').write_bytes(b'l'*7)
            usage=type('Usage',(),{'free':2202})()
            with patch.object(P,'RESERVE',2000),patch.object(P,'LOG_BYTES',100),patch.object(P,'CACHE_BYTES',32),patch.object(P,'TEMP',50),patch.object(P.R,'utc',return_value='2026-10-19T03:00:00+00:00'),patch.object(P.shutil,'disk_usage',return_value=usage) as measurement:
                with self.assertRaises(P.DiskReserveError) as caught:P.disk(out,{'rows-nn-T1.npz':100})
                self.assertIsInstance(caught.exception,RuntimeError);self.assertEqual(measurement.call_count,1)
                sample=dict(resource='disk',code='disk_reserve_insufficient',sampled_at_utc='2026-10-19T03:00:00+00:00',free_bytes=2202,required_bytes=2203,reserve_bytes=2000,
                    remaining_archive_bytes=60,remaining_log_cache_allowance_bytes=93,temporary_reserve_bytes=50,incremental_file_bytes=79,cache_bytes=32)
                self.assertEqual(caught.exception.sample,sample);self.assertLess(len(str(caught.exception)),1000)
                self.assertEqual(json.loads(str(caught.exception).split(': ',1)[1]),sample)
                usage.free=2203;measurement.reset_mock()
                self.assertEqual(P.disk(out,{'rows-nn-T1.npz':100})['free_bytes'],2203);self.assertEqual(measurement.call_count,1)


            runtime_root=root/'runtime';runtime_root.mkdir()
            request,current,distributions,probe,install=runtime_chain_fixture(runtime_root)
            nested=Path('p0/_vendor/zipp-1.dist-info/RECORD');nested_file=runtime_root/nested;nested_file.parent.mkdir(parents=True);nested_file.write_text('vendored RECORD')
            library=Path('p0/_vendor/lib.so');library_file=runtime_root/library;library_file.write_bytes(b'native fixture')
            distributions[0].files.extend([nested,library]);probe['native_pins']=[P.R.pin(library_file)]
            Path(request['runtime_probe_path']).write_text(json.dumps(probe));install['probe']=P.R.pin(request['runtime_probe_path'])
            Path(request['runtime_install_manifest_path']).write_text(json.dumps(install))
            import importlib.metadata as md
            with patch.object(sys,'prefix',str(runtime_root)),patch.object(md,'distributions',return_value=distributions),patch.object(P,'OLD_INSTALL_SCOPE_SHA',P.R.A.sha(request['runtime_install_scope_path'])):
                native,_=P.runtime_proof(request,current);self.assertEqual(len(native),31)
                original=list(distributions[0].files)
                distributions[0].files=original[1:]
                with self.assertRaisesRegex(ValueError,'top-level'):P.runtime_proof(request,current)
                distributions[0].files=original+[Path('duplicate.dist-info/RECORD')]
                with self.assertRaisesRegex(ValueError,'top-level'):P.runtime_proof(request,current)
                distributions[0].files=original
                for defect in ('probe_pin','inventory','record_keys','native_census'):
                    bad_probe=copy.deepcopy(probe);bad_install=copy.deepcopy(install)
                    if defect=='inventory':bad_probe['inventory'].pop('p0')
                    if defect=='record_keys':bad_probe['record_pins'].pop('p0')
                    if defect=='native_census':
                        extra=runtime_root/'extra.so';extra.write_bytes(b'x');bad_probe['native_pins'].append(P.R.pin(extra))
                    Path(request['runtime_probe_path']).write_text(json.dumps(bad_probe))
                    bad_install['probe']=P.R.pin(request['runtime_probe_path'])
                    if defect=='probe_pin':bad_install['probe']['sha256']='0'*64
                    Path(request['runtime_install_manifest_path']).write_text(json.dumps(bad_install))
                    with self.assertRaises(ValueError):P.runtime_proof(request,current)

            request_s,scope_s,probe_s,manifest_s,old_pin=successor_runtime_fixture(runtime_root,probe)
            with patch.object(sys,'prefix',str(runtime_root)),patch.object(md,'distributions',return_value=distributions),patch.object(P,'OLD_INSTALL_SCOPE_SHA',old_pin['sha256']):
                for defect in ('none','fabricated_old_complete','parent','prior_scope','probe_pin'):
                    changed_scope=copy.deepcopy(scope_s);changed_manifest=copy.deepcopy(manifest_s);changed_probe=copy.deepcopy(probe_s)
                    if defect=='parent':changed_scope['parent_scope_sha256']='0'*64
                    if defect=='prior_scope':changed_scope['prior_evidence'][0]['sha256']='0'*64
                    Path(request_s['runtime_install_scope_path']).write_text(json.dumps(changed_scope));scope_sha=P.R.A.sha(request_s['runtime_install_scope_path'])
                    changed_probe['scope_sha256']=scope_sha;Path(request_s['runtime_probe_path']).write_text(json.dumps(changed_probe))
                    changed_manifest['scope_sha256']=scope_sha;changed_manifest['probe']=P.R.pin(request_s['runtime_probe_path'])
                    if defect=='fabricated_old_complete':changed_manifest['original_installer_complete']=True
                    if defect=='probe_pin':changed_manifest['probe']['sha256']='0'*64
                    Path(request_s['runtime_install_manifest_path']).write_text(json.dumps(changed_manifest))
                    with patch.object(P,'SUCCESSOR_SCOPE_SHA',scope_sha):
                        if defect=='none':self.assertEqual(len(P.runtime_proof(request_s,current)[0]),31)
                        else:
                            with self.assertRaises(ValueError):P.runtime_proof(request_s,current)
    def test_denials_persist_when_swallowed_and_inode_alias_protected(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);raw=root/'raw';raw.mkdir();out=root/'out';out.mkdir();data=root/'data';data.write_bytes(b'x')
            alias=root/'alias';os.link(data,alias);saved=[]
            scope=dict(evidence=dict(datasets=str(raw),raw_pins=[],inputs={'x':P.R.pin(data)}),archive_bounds={})
            hook,_,reads,ledger=P.audit(scope,out,lambda n,v:saved.append(copy.deepcopy(v)))
            for path,mode,flags in ((raw/'unknown','r',os.O_RDONLY),(alias,'w',os.O_WRONLY),(out/'unknown','w',os.O_WRONLY)):
                try:hook('open',(str(path),mode,flags))
                except PermissionError:pass
            self.assertEqual(ledger['total'],3);self.assertEqual(saved[-1]['violations']['total'],3);self.assertEqual(reads,{})
            cache=out/'work-cache';cache.mkdir();os.link(data,cache/'alias')
            with self.assertRaises(PermissionError):hook('os.remove',(str(cache/'alias'),-1))
            with self.assertRaises(PermissionError):hook('os.mkdir',(str(out/'unowned'),0o700,-1))
            hook('os.rename',(str(out/'child.json.tmp'),str(out/'child.json'),-1,-1))
            with self.assertRaises(PermissionError):hook('os.rename',(str(out/'child.json.tmp'),str(data),-1,-1))
    def test_real_audit_atomic_receipt_and_swallowed_denial(self):
        import sys
        with tempfile.TemporaryDirectory() as t:
            out=Path(t)/'out';out.mkdir();raw=Path(t)/'raw';raw.mkdir()
            cache=out/'work-cache/tmp';cache.mkdir(parents=True)
            scope=dict(evidence=dict(datasets=str(raw),raw_pins=[],inputs={}),archive_bounds={})
            hook,state,_,ledger=P.audit(scope,out,lambda name,value:P.R.atomic_json(out/name,value))
            sys.addaudithook(hook)
            try:
                with patch.object(P,'disk',return_value={}):
                    P.R.atomic_json(out/'child.json',dict(complete=False))
                    fd,name=tempfile.mkstemp(dir=cache)
                    with os.fdopen(fd,'w') as file:file.write('owned temporary data')
                    fd=os.open(cache,os.O_RDONLY)
                    try:os.rename(Path(name).name,'renamed',src_dir_fd=fd,dst_dir_fd=fd);os.unlink('renamed',dir_fd=fd)
                    finally:os.close(fd)
                    try:(raw/'not-approved').read_bytes()
                    except PermissionError:pass
                    saved=P.R.A.read_unique_json(out/'audit.json')
                self.assertEqual(saved['violations']['total'],1);self.assertEqual(ledger['total'],1)
            finally:state['active']=False
    def test_all_models_daily_coverage(self):
        with tempfile.TemporaryDirectory() as t:
            out=Path(t)
            for T,w in ((1,3),(3,4),(12,5)):
                sid=np.array([0,0],np.int32);ts=np.array([86400,90000],np.int64)
                np.savez(out/f'rows-T{T}.npz',sid=sid,ts=ts)
                payload=dict(sid=sid,ts=ts,**{m:np.array([[.5]*w,[np.nan]*w],np.float32) for m in O.MODELS})
                np.savez(out/f'rows-nn-T{T}.npz',**payload)
            self.assertEqual(len(O.coverage(out)),3)
            payload['ngru'][0,0]=np.nan;np.savez(out/'rows-nn-T12.npz',**payload)
            with self.assertRaisesRegex(ValueError,'coverage'):O.coverage(out)


@unittest.skipUnless(importlib.util.find_spec('torch'),'Torch absent: original-run parity pending candidate runtime')
class OriginalTiny(unittest.TestCase):
    def run_original(self,out,observed,allocation=False,cold=False):
        import torch
        NN=P.R.A.NN;torch.set_num_threads(1);keys=[]
        for group in range(4):
            i=0
            while True:
                key=f'tiny-{group}-{i}'
                if NN.D.groups_of([key])[0]==group:keys.append(key);break
                i+=1
        sid=np.tile(np.repeat(np.arange(4,dtype=np.int32),8),3)
        ts=np.tile(np.tile(np.arange(1,9,dtype=np.int64)*86400,4),3);n=len(ts)
        R=dict(sid=sid,ts=ts,Y=np.tile(np.array([[1,0,0,0,0]],np.int8),(n,1)),LF=np.zeros((n,5),np.float32),
            T=np.repeat([1,3,12],32).astype(np.int32),Tidx=np.repeat([0,1,2],32).astype(np.int32))
        R.update({k:np.zeros(n,np.float32) for k in NN.STATIC})
        class Tiny(torch.nn.Module):
            def __init__(self):
                super().__init__();self.layer=torch.nn.Linear(1,5);self.drop=torch.nn.Dropout(.1)
            def forward(self,h,d,s,lf):return self.layer(self.drop(s[:,:1]))+lf
        def batch(SA,sid,ts,F,Tidx,nT):
            return np.zeros((len(sid),1,1),np.float32),np.zeros((len(sid),1,1),np.float32),np.ones((len(sid),1),np.float32)
        rng_states=[]
        def log(message):
            local=sys._getframe(1).f_locals
            rng_states.append(json.dumps(local['rng'].bit_generator.state,sort_keys=True))
        captured=[];observer=O.Observer(NN.run_tier,lambda n,v:captured.append((n,v)),allocation=allocation)
        args=type('Args',(),dict(out=str(out),models=','.join(O.MODELS)))()
        audit_scope=dict(evidence=dict(datasets='/private/tmp/history-forecasts-datasets',raw_pins=[],inputs={}),archive_bounds=P.archive_bounds())
        hook,audit_state,_,ledger=P.audit(audit_scope,out,lambda name,value:P.R.atomic_json(out/name,value))
        if cold:
            self.assertIsNone(tempfile.tempdir);tempfile.tempdir=None
        audit_state['active']=observed or cold
        if observed or cold:sys.addaudithook(hook)
        with patch.object(P,'disk',return_value={}),patch.object(NN,'tier_rows',return_value=R),patch.object(NN,'build_batch',side_effect=batch),patch.object(NN,'make_model',side_effect=lambda *a:Tiny()) as maker:
            try:
                if cold and os.environ.get('TORCHINDUCTOR_CACHE_DIR'):
                    self.assertIsNone(tempfile.tempdir)
                    self.assertEqual(Path(tempfile.gettempdir()).resolve(),out.resolve()/'work-cache/tmp')
                    fd,name=tempfile.mkstemp();os.write(fd,b'cold temporary probe');os.close(fd);os.unlink(name)
                    with tempfile.TemporaryDirectory() as directory:
                        directory=Path(directory);(directory/'a').write_bytes(b'x');fd=os.open(directory,os.O_RDONLY)
                        try:os.rename('a','b',src_dir_fd=fd,dst_dir_fd=fd);os.unlink('b',dir_fd=fd)
                        finally:os.close(fd)
                if observed:observer.install()
                try:info=NN.run_tier(args,'shallow',{},keys,log)
                except O.AllocationComplete:info=None
            finally:
                observer.uninstall();audit_state['active']=False
                self.last_audit=copy.deepcopy(ledger);self.last_maker_count=maker.call_count;self.last_completed=len(observer.completed)
            self.assertEqual(ledger['total'],0)
            state=torch.get_rng_state().numpy().tobytes()
            if allocation:
                self.assertEqual(maker.call_count,0);self.assertEqual(observer.starts,1);self.assertEqual(observer.completed,[])
            elif observed:observer.require_complete()
        return info,(state,rng_states),captured
    def test_rng_stopping_predictions_fit_order(self):
        with tempfile.TemporaryDirectory() as t:
            a=Path(t)/'a';b=Path(t)/'b';a.mkdir();b.mkdir()
            import r16_shallow_nn_monitor as N
            observed_env=N.cache_environment(b,create=True);plain_env=N.cache_environment(a,create=True)
            with patch.dict(os.environ,observed_env),patch.object(tempfile,'tempdir',observed_env['TMPDIR']):seen,state1,receipts=self.run_original(b,True)
            with patch.dict(os.environ,plain_env),patch.object(tempfile,'tempdir',plain_env['TMPDIR']):plain,state0,_=self.run_original(a,False)
            self.assertEqual(state0,state1)
            for x,y in zip(plain['fits'],seen['fits']):
                self.assertEqual({k:v for k,v in x.items() if k!='sec'},{k:v for k,v in y.items() if k!='sec'})
            self.assertEqual([(v['cell'][0],v['cell'][1],v['model']) for _,v in receipts],O.ORDER)
            for T in (1,3,12):
                with np.load(a/f'rows-nn-T{T}.npz') as z0,np.load(b/f'rows-nn-T{T}.npz') as z1:
                    for name in z0.files:self.assertEqual(O.array_hash(z0[name]),O.array_hash(z1[name]))
    def test_cold_subprocess_temp_cache_and_original_parity(self):
        import subprocess
        import r16_shallow_nn_monitor as N
        with tempfile.TemporaryDirectory() as t:
            root=Path(t).resolve();records={}
            for mode in ('old','observed','plain'):
                out=root/mode;out.mkdir();env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1')
                for key in N.cache_environment(out):env.pop(key,None)
                if mode!='old':env.update(N.cache_environment(out,create=True))
                done=subprocess.run([sys.executable,__file__,'--cold',str(out),mode],env=env,capture_output=True,text=True,timeout=120)
                self.assertEqual(done.returncode,0,done.stderr[-4000:]);records[mode]=P.R.A.read_unique_json(out/'cold.json')
            self.assertEqual(records['old']['status'],'expected-cold-default-cache-failure')
            self.assertGreater(records['old']['denials'],0);self.assertEqual(records['old']['model_constructors'],1);self.assertEqual(records['old']['completed_fits'],0)
            self.assertEqual(records['observed']['denials'],0);self.assertEqual(records['plain']['denials'],0)
            self.assertEqual(records['observed']['prediction_hashes'],records['plain']['prediction_hashes'])
            self.assertEqual(records['observed']['fits'],records['plain']['fits'])
            self.assertEqual(records['observed']['rng'],records['plain']['rng']);self.assertEqual(len(records['observed']['fits']),20)
    def test_stop_before_first_constructor(self):
        with tempfile.TemporaryDirectory() as t:
            info,_,receipts=self.run_original(Path(t),True,True)
            self.assertIsNone(info);self.assertEqual([n for n,_ in receipts],['allocation.json'])
            self.assertEqual(receipts[0][1]['neural_fits'],0);self.assertEqual(len(receipts[0][1]['allocated_prediction_matrices']),5)
            self.assertFalse(list(Path(t).glob('rows-nn*')))


def cold_child(out,mode):
    import hashlib
    case=OriginalTiny();out=Path(out)
    try:info,rng,_=case.run_original(out,mode!='plain',cold=True)
    except BaseException as error:
        if mode!='old':raise
        import traceback
        frames=[dict(file=Path(f.filename).name,function=f.name,line=f.lineno) for f in traceback.extract_tb(error.__traceback__)]
        assert isinstance(error,FileNotFoundError),type(error).__name__
        assert any(f['file']=='cache_dir_utils.py' and f['function']=='default_cache_dir' for f in frames)
        assert any(f['file']=='tempfile.py' and f['function']=='_get_default_tempdir' for f in frames)
        assert any(f['file']=='r16_nn.py' and f['line']==281 for f in frames)
        assert case.last_audit['total']>0 and case.last_maker_count==1 and case.last_completed==0
        value=dict(status='expected-cold-default-cache-failure',denials=case.last_audit['total'],model_constructors=case.last_maker_count,completed_fits=case.last_completed,error_type=type(error).__name__,failure_frames=frames)
    else:
        assert mode!='old','old cold configuration unexpectedly passed'
        hashes={}
        for T in (1,3,12):
            with np.load(out/f'rows-nn-T{T}.npz') as z:hashes[str(T)]={name:O.array_hash(z[name]) for name in z.files}
        value=dict(status='complete',denials=case.last_audit['total'],prediction_hashes=hashes,
            fits=[{k:v for k,v in fit.items() if k!='sec'} for fit in info['fits']],rng=dict(torch=hashlib.sha256(rng[0]).hexdigest(),numpy=rng[1]))
    (out/'cold.json').write_text(json.dumps(value,allow_nan=False))


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--cold':cold_child(sys.argv[2],sys.argv[3])
    else:unittest.main()
