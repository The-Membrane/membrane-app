import subprocess,time,json,hashlib,shutil,os,sys
from pathlib import Path
E=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence');req=E/'r16-timecell-summary-request-v1.json';r=json.loads(req.read_text());out=E/'r16-timecell-summaries-v1'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
pins={k:dict(p) for k,p in r['artifacts'].items()};pins['request']={'path':str(req),'size':req.stat().st_size,'sha256':sha(req)}
for p in pins.values():
 f=Path(p['path']);assert f.stat().st_size==p['size'] and sha(f)==p['sha256']
assert not out.exists();env=os.environ.copy();env.update(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PYTHONDONTWRITEBYTECODE='1')
cmd=[str(E.parent/'history-forecasts-recovery-runtime/bin/python'),str(E/'audit_r16_timecell_summaries.py'),'--request',str(req),'--request-sha256',sha(req),'--out',str(out)]
start=time.monotonic();peak=0;free=shutil.disk_usage(E).free;assert free>=2000000000
with (E/'r16-timecell-parent-stdout-v1.txt').open('wb') as so,(E/'r16-timecell-parent-stderr-v1.txt').open('wb') as se:
 p=subprocess.Popen(cmd,stdout=so,stderr=se,env=env)
 while p.poll() is None:
  a=subprocess.run(['ps','-o','rss=','-p',str(p.pid)],capture_output=True,text=True)
  if a.stdout.strip():peak=max(peak,int(a.stdout.strip())*1024)
  free=min(free,shutil.disk_usage(E).free)
  if peak>1000000000 or free<2000000000 or time.monotonic()-start>60:
   p.kill();p.wait();raise RuntimeError('parent resource guard')
  time.sleep(.02)
 code=p.wait()
for item in pins.values():
 f=Path(item['path']);assert f.stat().st_size==item['size'] and sha(f)==item['sha256']
proof=dict(complete=code==0,exit_code=code,pid=p.pid,elapsed_seconds=time.monotonic()-start,sampled_peak_RSS_bytes=peak,min_free_bytes=free,pins_unchanged=list(pins),monitor_sha256=sha(Path(__file__)),request=pins['request'])
(E/'r16-timecell-parent-monitor-v1.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof));sys.exit(code)
