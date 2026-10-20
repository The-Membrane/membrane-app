"""Frozen evidence, inode staging, conservative budgets and persistent audit ledger."""
from __future__ import annotations
import io
import json
import os
from pathlib import Path
import shutil
import sys
import numpy as np
import r16_shallow_merge_runner as M
R=M.R
HERE=Path(__file__).resolve().parent
INPUTS=('rows-T1.npz','rows-T3.npz','rows-T12.npz','rows-meta.json','merge-provenance.json')
MERGE_SCOPE_SHA='73329c0dbd283f65e80977b0d4239216e946dfae73afa8ce8013c3c38d87a8fb'
MERGE_INDEPENDENT_SHA='4613a894421b40312364b464621595aa12c1ebab34890b2fe5bfd272eef29a1a'
LOG_BYTES=100_000_000
RESERVE=2_000_000_000
TEMP=50_000_000
CACHE_BYTES=50_000_000
SCHEMA='r16-shallow-original-nn-v1'
OLD_INSTALL_SCOPE_SHA='836109c1091f58e1ee8814dd3339f3935eb4b1c3014aee53accca6beec2f6d3d'
SUCCESSOR='r16-shallow-torch-probe-successor-v1'
SUCCESSOR_SCOPE_SHA='e6422b00364410681debf3399d970ca3823194ae10163c8b0d047f0d13f5c117'
NEW=('r16_shallow_nn_observer.py','r16_shallow_nn_protocol.py','r16_shallow_nn_runner.py','r16_shallow_nn_monitor.py','test_r16_shallow_nn_observer.py')


def runtime():
    import torch
    return dict(base=R.runtime(),torch_version=torch.__version__,torch_threads=torch.get_num_threads(),
        torch_interop_threads=torch.get_num_interop_threads(),cuda_version=torch.version.cuda,prefix=sys.prefix,base_prefix=sys.base_prefix,python_flags=dict(no_user_site=sys.flags.no_user_site,isolated=sys.flags.isolated),deterministic_algorithms=torch.are_deterministic_algorithms_enabled(),
        default_dtype=str(torch.get_default_dtype()),default_device=str(torch.get_default_device()))



def observer_sources():
    return {str((HERE/name).relative_to(R.ROOT)):R.A.sha(HERE/name) for name in NEW}


def fixture_proof(path,probe,current):
    value=R.A.read_unique_json(path)
    if value.get('complete') is not True or value.get('tests_run')!=9 or value.get('skipped')!=0 or value.get('errors')!=0 or value.get('failures')!=0:
        raise ValueError('successful nine-fixture/no-skip observer selftest required')
    if value.get('source_sha256')!=observer_sources() or value.get('probe_sha256')!=R.A.sha(probe):raise ValueError('observer selftest sources/probe differ')
    if value.get('runtime')!=current:raise ValueError('observer selftest runtime differs')
    import ast
    tree=ast.parse((HERE/'test_r16_shallow_nn_observer.py').read_text())
    expected=[f'test_r16_shallow_nn_observer.{c.name}.{name}' for c in sorted((n for n in tree.body if isinstance(n,ast.ClassDef)),key=lambda n:n.name) for name in sorted(n.name for n in c.body if isinstance(n,ast.FunctionDef) and n.name.startswith('test_'))]
    if value.get('ordered_test_ids')!=expected or value.get('historical_inputs') is not False:
        raise ValueError('observer selftest test identity differs')
    return R.pin(path)


def check_sources(scope):
    for relative,digest in scope['source_sha256'].items():
        if R.A.sha(R.ROOT/relative)!=digest:raise ValueError('frozen source changed: '+relative)


def accepted(request):
    path=Path(request['merge_scope_path'])
    if R.A.sha(path)!=MERGE_SCOPE_SHA:raise ValueError('unaccepted merge scope')
    old=R.A.read_unique_json(path)
    receipt_path=Path(request['merge_independent_path'])
    if R.A.sha(receipt_path)!=MERGE_INDEPENDENT_SHA:raise ValueError('unaccepted merge independent receipt')
    receipt=R.A.read_unique_json(receipt_path);merged=Path(request['merged_dir']).resolve()
    if Path(request['merged_dir']).is_symlink():raise ValueError('merged directory symlink prohibited')
    if set(p.name for p in merged.iterdir())!=set(INPUTS):raise ValueError('exact five merged inputs required')
    if receipt.get('complete') is not True or receipt['row_totals']!=M.EXPECTED or receipt['canonical_series']!=277:
        raise ValueError('merge proof incomplete')
    for name,key in (('merge-provenance.json','provenance_sha256'),('rows-meta.json','metadata_sha256')):
        if R.A.sha(merged/name)!=receipt[key]:raise ValueError('merge sidecar proof changed')
    meta=R.A.read_unique_json(merged/'rows-meta.json')
    for T in M.EXPECTED:
        entry=meta['outputs'][T]
        if entry['rows']!=M.EXPECTED[T] or entry['name']!=f'rows-T{T}.npz' or R.A.sha(merged/entry['name'])!=entry['sha256']:
            raise ValueError('merged payload pin differs')
    check_sources(old)
    raw=old['evidence']['raw_pins']
    if len(raw)!=282:raise ValueError('exact282 raw input pins required')
    for pin in raw:R.check_pin(pin)
    return old,dict(merge_scope=R.pin(path),merge_independent=R.pin(receipt_path),
        inputs={name:R.pin(merged/name) for name in INPUTS},raw_pins=raw,
        datasets=old['evidence']['datasets'],canonical_keys=meta['series'])


def archive_bounds():
    """NPY header + zlib compressBound-style bound + conservative ZIP64 framing."""
    bounds={}
    for T,n in M.EXPECTED.items():
        width=len(R.A.D.LV[int(T)]);total=120
        for name,dtype,shape in [('sid','<i4',(n,)),('ts','<i8',(n,))]+[(m,'<f4',(n,width)) for m in R.A.NN.MODELS]:
            header=io.BytesIO();np.lib.format.write_array_header_1_0(header,dict(descr=dtype,fortran_order=False,shape=shape))
            size=int(np.prod(shape))*np.dtype(dtype).itemsize+len(header.getvalue())
            compressed=size+(size>>12)+(size>>14)+(size>>25)+13
            total+=compressed+30+len(name)+4+20+24+46+len(name)+4+32
        bounds[f'rows-nn-T{T}.npz']=total
    return bounds



class DiskReserveError(RuntimeError):
    """The exact triggering sample survives existing string-based failure receipts."""
    def __init__(self,sample):
        self.sample=sample
        super().__init__('fresh disk reserve insufficient: '+json.dumps(sample,sort_keys=True,separators=(',',':')))


def disk(out,bounds):
    out=Path(out);excluded={out/name for name in INPUTS};used=sum(p.stat().st_size for p in out.rglob('*') if p.is_file() and p not in excluded) if out.exists() else 0
    archive_used=sum((out/name).stat().st_size for name in bounds if (out/name).is_file())
    other=used-archive_used
    if any((out/name).is_file() and (out/name).stat().st_size>limit for name,limit in bounds.items()):raise RuntimeError('NN archive byte bound exceeded')
    cache=sum(p.stat().st_size for p in (out/'work-cache').rglob('*') if p.is_file()) if (out/'work-cache').exists() else 0
    if other<cache or other-cache>LOG_BYTES or cache>CACHE_BYTES:raise RuntimeError('log/receipt/cache allowance exceeded')
    remaining=sum(max(0,limit-((out/name).stat().st_size if (out/name).exists() else 0)) for name,limit in bounds.items())
    free=shutil.disk_usage(out if out.exists() else out.parent).free
    allowance=max(0,LOG_BYTES+CACHE_BYTES-other);required=RESERVE+remaining+allowance+TEMP
    if free<required:
        raise DiskReserveError(dict(resource='disk',code='disk_reserve_insufficient',sampled_at_utc=R.utc(),free_bytes=free,required_bytes=required,reserve_bytes=RESERVE,
            remaining_archive_bytes=remaining,remaining_log_cache_allowance_bytes=allowance,temporary_reserve_bytes=TEMP,
            incremental_file_bytes=used,cache_bytes=cache))
    return dict(free_bytes=free,incremental_file_bytes=used,remaining_archive_bound=remaining)


def stage(out,inputs):
    out=Path(out)
    if out.exists() or out.is_symlink():raise FileExistsError('fresh result directory required')
    out.mkdir();proof={}
    for name,pin in inputs.items():
        source=Path(pin['path'])
        if source.is_symlink():raise ValueError('symlink input prohibited')
        R.check_pin(pin);dest=out/name;os.link(source,dest)
        a,b=source.stat(),dest.stat()
        if (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino) or b.st_nlink<2 or dest.is_symlink():raise ValueError('POSIX hardlink proof failed')
        proof[name]=dict(source=str(source),destination=str(dest.resolve()),device=b.st_dev,inode=b.st_ino,nlink=b.st_nlink,
            size=b.st_size,sha256=R.A.sha(dest),incremental_payload_bytes=0)
        if proof[name]['sha256']!=pin['sha256']:raise ValueError('staged hash differs')
    return proof


def audit(scope,out,persist):
    """Deny unlisted raw reads and writes; keep denied attempts even if caught."""
    out=Path(out).resolve();root=Path(scope['evidence']['datasets']).resolve()
    allowed={p['path'] for p in scope['evidence']['raw_pins']};reads={};ledger=dict(total=0,attempts=[])
    immutable={(Path(p['path']).stat().st_dev,Path(p['path']).stat().st_ino) for p in scope['evidence']['inputs'].values()}
    state=dict(active=True,busy=False)
    exact={'nn-log.txt','nn-meta.json','allocation.json','allocation.json.tmp','child.json','child.json.tmp',
        'coverage.json','coverage.json.tmp','audit.json','audit.json.tmp','links.json','links.json.tmp',
        'dev-r162-nn.json','score.json','score.json.tmp'}|set(scope['archive_bounds'])
    exact|={f'fit-{i:02d}.json{suffix}' for i in range(20) for suffix in ('','.tmp')}
    def deny(reason,path):
        ledger['total']+=1
        if len(ledger['attempts'])<32:ledger['attempts'].append(dict(reason=reason,path=str(path)[:512]))
        state['busy']=True
        try:persist('audit.json',dict(violations=ledger,opened_raw_inputs=reads))
        finally:state['busy']=False
        raise PermissionError(reason)
    cache=out/'work-cache'
    def resolved(value,dir_fd=-1):
        path=Path(os.fsdecode(value))
        if not path.is_absolute() and dir_fd not in (-1,None):
            if '..' in path.parts:deny('relative cache escape',path)
            st=os.fstat(dir_fd);base=None
            for candidate in [cache]+[p for p in cache.rglob('*') if p.is_dir()]:
                c=candidate.stat()
                if (c.st_dev,c.st_ino)==(st.st_dev,st.st_ino):base=candidate;break
            if base is None:deny('unowned directory descriptor',path)
            path=base/path
        return Path(os.path.abspath(path)).resolve()
    def immutable_check(path):
        if path.exists():
            st=path.stat()
            if (st.st_dev,st.st_ino) in immutable:deny('immutable input inode mutation',path)
    def hook(event,args):
        if not state['active'] or state['busy']:return
        if event=='os.rename':
            source=resolved(args[0],args[2]);dest=resolved(args[1],args[3]);immutable_check(source);immutable_check(dest)
            if source.is_relative_to(cache) and dest.is_relative_to(cache):return
            if source.parent==out and dest.parent==out and source.name==dest.name+'.tmp' and source.name in exact and dest.name in exact:return
            deny('unlisted rename',source);return
        if event in ('os.mkdir','os.remove','os.rmdir'):
            path=resolved(args[0],args[2] if event=='os.mkdir' else args[1]);immutable_check(path)
            if not path.is_relative_to(cache):deny('unowned working-cache mutation',path)
            disk(out,scope['archive_bounds']);return
        if event in ('os.link','os.symlink','os.chmod','os.truncate'):
            deny('filesystem mutation operation prohibited after staging',args[0]);return
        if event!='open':return
        target=args[0];mode=args[1];flags=args[2] or 0
        writing=bool(flags&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)) or isinstance(mode,str) and any(c in mode for c in 'wax+')
        if isinstance(target,int):
            st=os.fstat(target)
            if writing and (st.st_dev,st.st_ino) in immutable:deny('immutable input inode write',target)
            if writing and target not in (1,2):
                owned=any(p.is_file() and p.resolve().is_relative_to(cache) and (p.stat().st_dev,p.stat().st_ino)==(st.st_dev,st.st_ino) for p in cache.rglob('*'))
                if not owned:deny('unlisted writable descriptor',target)
            return
        lexical=Path(os.path.abspath(os.fsdecode(target)));path=lexical.resolve()
        if writing:
            immutable_check(path)
            if not (path.parent==out and path.name in exact or path.is_relative_to(cache)):deny('unlisted write',path)
            disk(out,scope['archive_bounds'])
        if lexical.is_relative_to(root) or path.is_relative_to(root):
            if writing or str(path) not in allowed:deny('unlisted raw read/write',path)
            reads[str(path)]=reads.get(str(path),0)+1
    return hook,state,reads,ledger




def successor_chain(scope,manifest,probe):
    from packaging.utils import canonicalize_name
    if scope.get('parent_scope_sha256')!=OLD_INSTALL_SCOPE_SHA or scope.get('original_installer_complete') is not False or manifest.get('original_installer_complete') is not False or manifest.get('corrected_probe_complete') is not True or manifest.get('prior_scope_sha256')!=OLD_INSTALL_SCOPE_SHA:raise ValueError('unsupported successor completion chain')
    prior=scope['prior_evidence']
    if len(prior)!=6 or [Path(p['path']).name for p in prior]!=['scope.json','run.json','probe.json','pip-report.json','pip-check.log','probe.log'] or prior[0]['sha256']!=OLD_INSTALL_SCOPE_SHA:raise ValueError('fixed original failed-install evidence required')
    def check_all(value):
        if isinstance(value,dict):
            if {'path','size','sha256'}<=set(value):R.check_pin(value)
            else:
                for child in value.values():check_all(child)
        elif isinstance(value,list):
            for child in value:check_all(child)
    check_all(scope)
    old=R.A.read_unique_json(prior[0]['path']);check_all(old);failed=R.A.read_unique_json(prior[1]['path']);failed_probe=R.A.read_unique_json(prior[2]['path'])
    if old.get('schema')!='r16-shallow-torch-install-v1' or old['versions']!=scope['versions'] or manifest.get('versions')!=scope['versions']:raise ValueError('successor versions/ancestor differ')
    if failed.get('complete') is not False or failed.get('stage')!='synthetic probe' or failed_probe.get('complete') is not False or failed_probe.get('error')!='unfrozen local import torch.ops' or failed_probe.get('denied_input_attempts')!=[]:raise ValueError('original failure evidence differs')
    if (Path(prior[1]['path']).parent/'manifest.json').exists() or Path(prior[4]['path']).read_text().strip()!='No broken requirements found.':raise ValueError('old failure/pip-check state differs')
    if not all(p in scope['scripts'] for p in old['scripts']) or scope['source_files']!=old['source_files']:raise ValueError('old source closure severed')
    runtime_manifest=R.A.read_unique_json(old['runtime_manifest']['path']);lock_info=runtime_manifest['files']['lock.json'];lock_path=Path(old['runtime_manifest']['path']).parent/'lock.json'
    if R.A.sha(lock_path)!=lock_info['sha256'] or lock_path.stat().st_size!=lock_info['bytes']:raise ValueError('ancestor wheel lock differs')
    locked={p['name']:p for p in R.A.read_unique_json(lock_path)['packages']};seen={}
    for item in R.A.read_unique_json(prior[3]['path'])['install']:
        name=canonicalize_name(item['metadata']['name']);expected=locked[name];info=item['download_info']
        if name in seen or item['metadata']['version']!=expected['version'] or info['url']!=expected['url'] or info['archive_info']['hashes']['sha256']!=expected['sha256']:raise ValueError('prior pip report wheel identity differs')
        seen[name]=expected['version']
    identity=scope['runtime_identity']
    if len(seen)!=30 or seen!=scope['versions'] or identity['versions']!=scope['versions'] or identity['record_pins']!=probe['record_pins'] or sorted(identity['native_pins'],key=lambda p:p['path'])!=sorted(probe['native_pins'],key=lambda p:p['path']):raise ValueError('successor runtime/RECORD/native identity differs')


def runtime_proof(request,current):
    import importlib.metadata as md
    from packaging.utils import canonicalize_name
    probe=R.A.read_unique_json(request['runtime_probe_path']);install=R.A.read_unique_json(request['runtime_install_manifest_path'])
    install_scope=R.A.read_unique_json(request['runtime_install_scope_path']);scope_pin=R.pin(request['runtime_install_scope_path'])
    if not probe.get('complete') or probe.get('optimizer_steps')!=0 or probe.get('historical_inputs') is not False or probe.get('denied_input_attempts')!=[] or not probe.get('cpu_only') or not probe.get('numpy_abi_shared_roundtrip'):raise ValueError('successful no-fit CPU runtime probe required')
    if not install.get('complete') or install.get('probe')!=R.pin(request['runtime_probe_path']) or install.get('scope_sha256')!=scope_pin['sha256'] or probe.get('scope_sha256')!=scope_pin['sha256']:raise ValueError('installation/probe/scope chain differs')
    if install_scope.get('schema')==SUCCESSOR:
        if scope_pin['sha256']!=SUCCESSOR_SCOPE_SHA:raise ValueError('unaccepted successor scope')
        successor_chain(install_scope,install,probe)
    elif install_scope.get('schema')=='r16-shallow-torch-install-v1':
        if scope_pin['sha256']!=OLD_INSTALL_SCOPE_SHA:raise ValueError('unaccepted original install scope')
        if install.get('download_report_packages')!=30 or install.get('pip_check_passed') is not True or install.get('optimizer_fits') is not False or install.get('historical_inputs') is not False:raise ValueError('complete no-fit30-package installation required')
    else:raise ValueError('unsupported runtime proof schema')
    versions=install_scope['versions'];inventory={canonicalize_name(name):version for name,version in current['base']['packages']}
    if len(versions)!=30 or len(current['base']['packages'])!=30 or probe['inventory']!=versions or inventory!=versions or set(probe['record_pins'])!=set(versions):raise ValueError('exact30 package/RECORD inventory differs')
    records={};native=[];prefix=Path(sys.prefix).resolve()
    for distribution in md.distributions():
        name=canonicalize_name(distribution.metadata['Name'])
        members=list(distribution.files or [])
        own_records=[m for m in members if len(Path(m).parts)==2 and Path(m).parts[0].endswith('.dist-info') and Path(m).parts[1]=='RECORD']
        if len(own_records)!=1:raise ValueError('exactly one top-level distribution RECORD required')
        records[name]=R.pin(distribution.locate_file(own_records[0]))
        for member in members:
            path=Path(distribution.locate_file(member)).resolve()
            if not path.is_relative_to(prefix):raise ValueError('distribution member escaped runtime prefix')
            if path.suffix in ('.so','.dylib') and path.is_file():native.append(R.pin(path))
    if records!=probe['record_pins'] or sorted(native,key=lambda p:p['path'])!=sorted(probe['native_pins'],key=lambda p:p['path']):raise ValueError('runtime RECORD/native census differs')
    comparisons=dict(executable=sys.executable,prefix=sys.prefix,base_prefix=sys.base_prefix,python_version=sys.version,
        torch_version=current['torch_version'],numpy_version=np.__version__,torch_threads=current['torch_threads'],
        torch_interop_final=current['torch_interop_threads'],deterministic_algorithms=current['deterministic_algorithms'],python_flags=current['python_flags'])
    if any(probe.get(k)!=v for k,v in comparisons.items()):raise ValueError('probe/current runtime invariant differs')
    return list(records.values())+native,scope_pin


def freeze(request_path,out):
    out=Path(out)
    if out.exists():raise FileExistsError('scope already exists')
    request=R.A.read_unique_json(request_path);old,evidence=accepted(request)
    if request['phase'] not in ('allocation','fit'):raise ValueError('phase must be allocation or fit')
    policy=request['resource_policy']
    if policy['wall_seconds']!=28800 or policy['grace_seconds']!=30:raise ValueError('exact eight-hour/30s operational limit required')
    score_policy=request['score_resource_policy']
    if score_policy['wall_seconds']!=3600 or score_policy['grace_seconds']!=30 or not isinstance(score_policy['rss_bytes'],int) or score_policy['rss_bytes']<=0:raise ValueError('explicit score1h/30s/RSS policy required')
    if not isinstance(policy['rss_bytes'],int) or policy['rss_bytes']<=0:raise ValueError('explicit positive operational RSS cap required')
    target=Path(request['out']).absolute()
    if target.exists() or target.is_symlink() or target.resolve().is_relative_to(Path(evidence['datasets'])):raise ValueError('fresh output outside datasets required')
    current=runtime();native,install_scope=runtime_proof(request,current)
    if current['torch_threads']!=1 or current['default_device']!='cpu':raise ValueError('original CPU/thread1 Torch state required')
    if any(v!='1' for v in current['base']['threads'].values()):raise ValueError('single-thread environment required')
    fixture=fixture_proof(request['observer_fixture_receipt_path'],request['runtime_probe_path'],current)
    if request['phase']=='fit':
        allocation=R.pin(request['allocation_receipt_path']);value=R.A.read_unique_json(allocation['path'])
        accepted_scope=preflight(request['allocation_scope_path'],request['allocation_scope_sha256'])
        if accepted_scope['phase']!='allocation' or accepted_scope['runtime']!=current:raise ValueError('matching allocation scope required')
        allocation_root=Path(allocation['path']).parent
        child=R.A.read_unique_json(allocation_root/'child.json');monitor=R.A.read_unique_json(allocation_root/'monitor.json')
        if value.get('scope_sha256')!=request['allocation_scope_sha256'] or not child.get('complete') or not monitor.get('complete') or child.get('scope_sha256')!=value['scope_sha256'] or monitor.get('scope_sha256')!=value['scope_sha256'] or child.get('phase')!='allocation' or monitor.get('phase')!='allocation':raise ValueError('terminal allocation proof required')
        if value.get('status')!='allocation-only-before-first-make_model' or value.get('neural_fits')!=0:raise ValueError('accepted allocation-only receipt required')
        allocation_proof=[R.pin(request['allocation_scope_path']),R.pin(allocation_root/'child.json'),R.pin(allocation_root/'monitor.json')]
    else:allocation=None;allocation_proof=[]
    pins=dict(old['source_sha256'])
    for name in NEW:pins[str((HERE/name).relative_to(R.ROOT))]=R.A.sha(HERE/name)
    scope=dict(schema=SCHEMA,phase=request['phase'],request=R.pin(request_path),plan=R.pin(request['plan_path']),
        runtime_install_scope=install_scope,observer_fixture=fixture,runtime_probe=R.pin(request['runtime_probe_path']),runtime_install=R.pin(request['runtime_install_manifest_path']),runtime_native_pins=native,runtime=current,evidence=evidence,source_sha256=pins,out=str(target.resolve()),
        allocation_receipt=allocation,allocation_proof=allocation_proof,archive_bounds=archive_bounds(),resource_policy=policy,score_resource_policy=score_policy,
        disk_policy=dict(reserve_bytes=RESERVE,log_receipt_bytes=LOG_BYTES,temporary_bytes=TEMP,working_cache_bytes=CACHE_BYTES),
        original_recipe=dict(seed=20261903,models=list(R.A.NN.MODELS),tiers='shallow',threads=1),created_at=R.utc())
    out.parent.mkdir(parents=True,exist_ok=True);R.atomic_json(out,scope)
    return dict(scope_path=str(out.resolve()),scope_sha256=R.A.sha(out))


def preflight(path,digest):
    if R.A.sha(path)!=digest:raise ValueError('scope SHA changed')
    scope=R.A.read_unique_json(path)
    if scope['schema']!=SCHEMA or scope['archive_bounds']!=archive_bounds():raise ValueError('scope schema/bounds differ')
    check_sources(scope)
    for k in ('request','plan','runtime_probe','runtime_install','runtime_install_scope','observer_fixture'):R.check_pin(scope[k])
    if scope['allocation_receipt']:R.check_pin(scope['allocation_receipt'])
    for entry in scope['runtime_native_pins']+scope['allocation_proof']:R.check_pin(entry)
    for k in ('merge_scope','merge_independent'):R.check_pin(scope['evidence'][k])
    for p in list(scope['evidence']['inputs'].values())+scope['evidence']['raw_pins']:R.check_pin(p)
    current=runtime()
    if current!=scope['runtime']:raise ValueError('runtime changed')
    fixture_proof(scope['observer_fixture']['path'],scope['runtime_probe']['path'],current)
    request=R.A.read_unique_json(scope['request']['path']);runtime_proof(request,current)
    return scope
