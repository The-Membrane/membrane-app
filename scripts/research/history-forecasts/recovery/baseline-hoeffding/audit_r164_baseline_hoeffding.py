"""Fixed synthetic baseline CI countermeasure; no new original-ranges calls or NPZ reads."""
import argparse
from fractions import Fraction as F
import hashlib
import itertools
import json
import math
from pathlib import Path
import platform
import resource
import shutil
import sys
import time
SCHEMA='codex-r164-baseline-hoeffding-v1'
INPUT_SHA='43b4195ed5fd247944e2a65adb42675624a7427a5245658f6f1feafc2b498994'
POLICY=dict(rss_bytes=1000000000,wall_seconds=60,disk_reserve_bytes=2000000000,output_bytes=1000000)
RADIUS=math.sqrt(math.log(20)/8)
SOURCE_NAMES=('r164_ranges.py','r164_score.py','r164_power.py','a_touch.py','a2_touch.py','a3_touch.py','a4_touch.py','a5_touch.py','a6_touch.py')
PIN_NAMES={'input_result','input_acceptance','implementation','tests','original_world_helper','original_world_tests','runtime_proof',*('source_'+name for name in SOURCE_NAMES)}
LIMITS='Synthetic independent-block laws only; fixed baseline endpoints/equal block weights. Forty groups are not forty independent units. Common support[0,1] even under shared shocks. No CAL/refit, market, PartB power repair, forecast revision, promotion, reserve or NOT RUN claims.'


def need(ok,message):
 if not ok:raise ValueError(message)
def pin(p):
 p=Path(p).resolve();b=p.read_bytes();return dict(path=str(p),size=len(b),sha256=hashlib.sha256(b).hexdigest())
def runtime():return dict(python=sys.version,executable=str(Path(sys.executable).resolve()),prefix=sys.prefix,platform=platform.platform())
def protocol():return dict(constructions=['PU','DIS'],states=dict(independent=256,shared=81),theta=[3,4],blocks=4,support=[0,1],confidence=.9,radius_formula='sqrt(log(20)/8)',fixed=True)
def exact(v):return dict(numerator=v.numerator,denominator=v.denominator,value=float(v))
def frac(v):return F(v['numerator'],v['denominator'])
def states(law):
 if law=='independent':
  for index,bits in enumerate(itertools.product((0,1),repeat=8)):
   pairs=tuple(zip(bits[::2],bits[1::2]));num=math.prod((1 if y else 3) if j%2==0 else (3 if y else 1) for j,y in enumerate(bits))
   yield index,pairs,F(num,4**8)
 elif law=='shared':
  for index,digits in enumerate(itertools.product(range(3),repeat=4)):
   yield index,tuple(((0,0),(0,1),(1,1))[j] for j in digits),F(math.prod(2 if j==1 else 1 for j in digits),4**4)
 else:raise ValueError('unknown law')
def interval(mean):return [max(0.,float(mean)-RADIUS),min(1.,float(mean)+RADIUS)]
def contains(ci,theta):return F.from_float(ci[0])<=theta<=F.from_float(ci[1])
def summarize(rows,key):
 coverage=sum(F(*r['weight']) for r in rows if r[key]['includes_theta']);collapse=sum(F(*r['weight']) for r in rows if r[key]['CI']==[1.,1.])
 widths=[r[key]['CI'][1]-r[key]['CI'][0] for r in rows]
 return dict(inclusion=exact(coverage),miss_mass=exact(1-coverage),collapse_1_1_mass=exact(collapse),expected_CI_width=math.fsum(float(F(*r['weight']))*w for r,w in zip(rows,widths)),minimum_CI_width=min(widths),maximum_CI_width=max(widths))
def audit(data):
 need(data.get('complete') is True and len(data['worlds'])==337,'input complete/support')
 indexed={(w['law'],w['index']):w for w in data['worlds']};need(len(indexed)==337,'duplicate world')
 expected={(law,i) for law in ('independent','shared') for i,_,_ in states(law)};need(set(indexed)==expected,'state closure')
 result=[];summary={};theta=F(3,4)
 for law in ('independent','shared'):
  declared=list(states(law));need(sum(w for _,_,w in declared)==1,'probability mass')
  pmf={x:sum(w for _,pairs,w in declared if F(1-pairs[0][0]+pairs[0][1],2)==x) for x in (F(0),F(1,2),F(1))}
  need(pmf==({F(0):F(1,16),F(1,2):F(6,16),F(1):F(9,16)} if law=='independent' else {F(0):F(0),F(1,2):F(1,2),F(1):F(1,2)}),'block PMF')
  for index,pairs,weight in declared:
   world=indexed[law,index];need(world['weight']==[weight.numerator,weight.denominator],'state probability changed')
   scores=[F(1-low+high,2) for low,high in pairs];mean=sum(scores)/4;new=interval(mean)
   for construction in ('PU','DIS'):
    cell=world['cell']['constructions'][construction];need(cell['n_groups']==40 and cell['rows_with_range']==640,'baseline support')
    need(world['covered_counts'][construction]==40*mean and F.from_float(cell['coverage_groups'])==mean and F.from_float(cell['coverage_rows'])==mean,'baseline coverage changed')
    old=cell['coverage_ci90'];need(len(old)==2 and all(isinstance(x,(float,int)) and math.isfinite(x) for x in old) and 0<=old[0]<=old[1]<=1,'original CI invalid')
    result.append(dict(law=law,index=index,construction=construction,weight=[weight.numerator,weight.denominator],block_scores=[[x.numerator,x.denominator] for x in scores],coverage_mean=exact(mean),original=dict(CI=old,includes_theta=contains(old,theta)),hoeffding=dict(CI=new,includes_theta=contains(new,theta))))
  summary[law]={}
  for c in ('PU','DIS'):
   rr=[r for r in result if r['law']==law and r['construction']==c];old=summarize(rr,'original');new=summarize(rr,'hoeffding')
   need(frac(old['inclusion'])==frac(data['summary'][law][c]['CI_inclusion_mass']),'original inclusion conservation')
   need(frac(new['inclusion'])==(F(65511,65536) if law=='independent' else F(1)) and frac(new['collapse_1_1_mass'])==0,'Hoeffding analytical control')
   summary[law][c]=dict(original=old,hoeffding=new)
 need(len(result)==674,'comparison closure');return dict(summary=summary,comparisons=result)
def authenticate(path,digest):
 need(pin(path)['sha256']==digest,'request changed');r=json.loads(Path(path).read_text());need(r['admission_status']=='parent_accepted','DRAFT not admitted')
 need(r['schema']==SCHEMA and r['policy']==POLICY and r['protocol']==protocol() and r['runtime']==runtime() and 'torch' not in sys.modules,'protocol/runtime changed')
 need(set(r['pins'])==PIN_NAMES,'pin closure changed')
 for p in r['pins'].values():need(pin(p['path'])==p,'artifact changed')
 need(r['pins']['input_result']['sha256']==INPUT_SHA and r['pins']['implementation']['path']==str(Path(__file__).resolve()),'source/input identity')
 need(r['pins']['input_acceptance']['sha256']=='438ff2b3e86f2547dc005db0f9b420625d210bc61fa9fdfae8f3f284be3318c3','input acceptance identity')
 need(r['pins']['original_world_helper']['sha256']=='8aafce14bb40e79aadb944ac384845c5aef88aca354e5bfcbe24dffc28f7deb3','original state-generator identity')
 accepted=json.loads(Path(r['pins']['input_acceptance']['path']).read_text());need(accepted['complete'] is True and accepted['result']==r['pins']['input_result'] and accepted['world_outputs']==337,'input not accepted')
 return r
def execute(request,digest,out):
 r=authenticate(request,digest);need(str(out.resolve())==r['output'] and not out.exists(),'fresh exact output');out.mkdir();start=time.monotonic();stage='input'
 try:
  data=json.loads(Path(r['pins']['input_result']['path']).read_text());stage='audit';v=audit(data);stage='final'
  for p in r['pins'].values():need(pin(p['path'])==p,'artifact changed during audit')
  need(pin(request)['sha256']==digest and 'torch' not in sys.modules,'request/runtime drift')
  rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024)
  need(rss<=POLICY['rss_bytes'] and time.monotonic()-start<=60 and shutil.disk_usage(out).free>=2000000000,'resource policy')
  v.update(schema=SCHEMA,complete=True,request=pin(request),pins=r['pins'],theta=exact(F(3,4)),radius=RADIUS,runtime=runtime(),limitations=LIMITS,elapsed_seconds=time.monotonic()-start,peak_RSS_bytes=rss)
  b=(json.dumps(v,separators=(',',':'),allow_nan=False)+'\n').encode();need(len(b)<=POLICY['output_bytes'],'output cap')
  with (out/'result.json').open('xb') as f:f.write(b)
 except BaseException as e:
  with (out/'failure.json').open('x') as f:json.dump(dict(complete=False,stage=stage,exception_class=type(e).__name__,elapsed_seconds=time.monotonic()-start),f)
  raise
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--request',required=True,type=Path);p.add_argument('--sha256',required=True);p.add_argument('--out',required=True,type=Path);a=p.parse_args();execute(a.request,a.sha256,a.out)
