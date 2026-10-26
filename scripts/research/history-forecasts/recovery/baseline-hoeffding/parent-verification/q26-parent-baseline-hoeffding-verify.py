from pathlib import Path
from fractions import Fraction as F
from decimal import Decimal as D,localcontext
import hashlib,json,math
E=Path('/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence')
def pin(p):
 b=p.read_bytes();return dict(path=str(p),size=len(b),sha256=hashlib.sha256(b).hexdigest())
def near(a,b):assert math.isclose(a,float(b),rel_tol=1e-12,abs_tol=1e-13),(a,b)
p=E/'r164-baseline-hoeffding-v1/result.json';v=json.loads(p.read_text());orig=json.loads((E/'r164-range-uncertainty-v1/result.json').read_text());src={(w['law'],w['index']):w for w in orig['worlds']};rows=v['comparisons'];assert v['complete'] and len(rows)==674
assert len({(r['law'],r['index'],r['construction']) for r in rows})==674
with localcontext() as ctx:
 ctx.prec=60;rad=(D(20).ln()/8).sqrt();near(v['radius'],rad)
 for r in rows:
  law,i,c=r['law'],r['index'],r['construction'];base=4 if law=='independent' else 3;n=i;digits=[]
  for _ in range(4):digits.insert(0,n%base);n//=base
  assert n==0;states=[((0,0),(0,1),(1,0),(1,1))[d] if base==4 else ((0,0),(0,1),(1,1))[d] for d in digits]
  weight=F(1)
  for d in digits:weight*=((F(3,16),F(9,16),F(1,16),F(3,16)) if base==4 else (F(1,4),F(1,2),F(1,4)))[d]
  scores=[F(1-a+b,2) for a,b in states];mu=sum(scores)/4
  assert r['weight']==[weight.numerator,weight.denominator] and r['block_scores']==[[x.numerator,x.denominator] for x in scores]
  assert r['coverage_mean']==dict(numerator=mu.numerator,denominator=mu.denominator,value=float(mu))
  old=src[law,i]['cell']['constructions'][c]['coverage_ci90'];assert r['original']['CI']==old
  assert r['original']['includes_theta']==(F.from_float(old[0])<=F(3,4)<=F.from_float(old[1]))
  center=D(mu.numerator)/D(mu.denominator);new=[max(D(0),center-rad),min(D(1),center+rad)]
  for x,y in zip(r['hoeffding']['CI'],new):near(x,y)
  assert r['hoeffding']['includes_theta']==(mu>=F(1,4))
 for law in ('independent','shared'):
  for c in ('PU','DIS'):
   rr=[r for r in rows if r['law']==law and r['construction']==c];assert len(rr)==(256 if law=='independent' else 81)
   assert sum(F(*r['weight']) for r in rr)==1
   for name in ('original','hoeffding'):
    s=v['summary'][law][c][name];inc=sum(F(*r['weight']) for r in rr if r[name]['includes_theta']);col=sum(F(*r['weight']) for r in rr if r[name]['CI']==[1.,1.]);ws=[r[name]['CI'][1]-r[name]['CI'][0] for r in rr]
    for key,z in [('inclusion',inc),('miss_mass',1-inc),('collapse_1_1_mass',col)]:assert s[key]['numerator']==z.numerator and s[key]['denominator']==z.denominator;near(s[key]['value'],z)
    near(s['expected_CI_width'],sum(D(w.numerator)/D(w.denominator)*D(str(x)) for w,x in zip([F(*r['weight']) for r in rr],ws)));near(s['minimum_CI_width'],min(ws));near(s['maximum_CI_width'],max(ws))
   new=v['summary'][law][c]['hoeffding'];expected=F(65511,65536) if law=='independent' else F(1);assert F(new['inclusion']['numerator'],new['inclusion']['denominator'])==expected
   near(new['expected_CI_width'],D(29933)/32768*rad+D(2337)/8192 if law=='independent' else D(15)/16*rad+D(9)/32)
for q in list(v['pins'].values())+[v['request']]:assert pin(Path(q['path']))==q
assert (E/'r164-baseline-hoeffding-parent-stderr-v1.txt').stat().st_size==0
print(json.dumps(dict(complete=True,result=pin(p),comparison_records=674,all_law_construction_summaries=4,arithmetic='independent radix index decoding, exact weights and inclusion,60-digit Decimal CI/width calculations, closed-form mean-width identities, all17finalpins'),sort_keys=True))
for law,cs in v['summary'].items():
 for c,s in cs.items():print(law,c,json.dumps(s,sort_keys=True))
