import json, hashlib, pathlib, sys, os
def require(ok, reason):
 if not ok: raise ValueError(reason)
def checked_path(base, name):
 relative=pathlib.Path(name)
 require(not relative.is_absolute() and ".." not in relative.parts, "path_escape")
 p=base/relative
 require(not any(q.is_symlink() for q in [p,*p.parents]), "symlink_input")
 require(p.resolve().is_relative_to(base.resolve()), "path_escape")
 return p
ROOT=pathlib.Path(sys.argv[1]).resolve()
OUT=pathlib.Path(os.path.abspath(sys.argv[2]))
require(not any(q.is_symlink() for q in [OUT,*OUT.parents]), "symlink_output")
require(not OUT.exists(), "output_exists")
RAW='data/research/venue-signals/morpho-v2-rlusd-idle-holder-capture-v1-2026-10-10T11-08-57.571Z-e1af086c-7e72-438f-bdf9-e33288db883e'
ACCEPT='data/research/venue-signals/morpho-v2-rlusd-parent-acceptance-2026-10-10-b095f724-549b-4b14-acdc-37618f5c7275'
def read(base,name,sha=None,size=None):
 p=checked_path(base,name)
 b=p.read_bytes(); require(sha is None or hashlib.sha256(b).hexdigest()==sha, name)
 require(size is None or len(b)==size, name)
 return json.loads(b)
a=ROOT/ACCEPT;r=ROOT/RAW
m=read(a,'manifest.json','4cbbb38337023d2212f250349c8e2bc12ff2e77205e5cf7f56b62847171127a0')
# Verify bytes, including non-JSON logs, without interpreting them.
for e in m['inventory']:
 p=checked_path(a,e['file'])
 b=p.read_bytes();require(len(b)==e['bytes'] and hashlib.sha256(b).hexdigest()==e['fileSha256'],e['file'])
t=read(r,'terminal.json','e99907118fd622241bf3247bd313bb9f35d44168157ab81acdf002bdc8ca5bda')
require(t['schema']=='morpho_v2_rlusd_idle_holder_terminal_v1', 'terminal_schema')
require(len(t['files'])==102 and len(set(e['file'] for e in t['files']))==102, 'terminal_files')
require({p.name for p in r.iterdir()}=={'terminal.json',*(e['file'] for e in t['files'])}, 'cohort_set')
for e in t['files']:read(r,e['file'],e['fileSha256'],e['bytes'])
p=read(r,'provenance.json','9cdca6666dd55bbd38da0b0d431917759a066efa382aa73cc9124f538b0a338b')
require(len(p['sourcePins'])==51 and len(p['inputPins'])==4, 'closure_counts')
for e in p['sourcePins']+p['inputPins']:
 # Historical originals live in the acceptance closure, not current workspace sources.
 b=checked_path(a/'closure',e['path']).read_bytes();require(len(b)==e['bytes'] and hashlib.sha256(b).hexdigest()==e['fileSha256'], e['path'])
d=read(r,'report.json','4eb38c922a8373f0aeb38e1a1dcb6e7a4f52b0e38380a27b60293e447fb59422')
require(d['schema']=='morpho_v2_rlusd_idle_holder_native_join_report_v1', 'report_schema')
S='3479286870294737294548835'
identity={'profileId':'rlusd-vault-v2-idle','routeKey':'RLUSD → VaultV2 [RLUSD]','destination':d['subject']['vault'],'asset':d['subject']['asset'],'assetDecimals':18,'shareDecimals':18}
points=[]
for p in d['points'][1:]:
 require(p['probeSharesRaw']==S and p['historicalOwnedEntitlementAssetRaw'] is None, 'anchor_basis')
 points.append({'identity':identity,'owner':p['owner'],'source':p['source'],'regime':{'kind':'zero_adapter_idle','liquidityAdapter':p['liquidityAdapter'],'liquidityData':p['liquidityData'],'vaultRuntimeCodeHash':p['runtimes']['vault']['runtimeKeccak256'],'assetRuntimeCodeHash':p['runtimes']['asset']['runtimeKeccak256']},'idleCashRaw':p['CAssetRaw'],'historicalOwnerSharesRaw':None,'fixedCurrentStockConversion':{'method':'native_preview_redeem_fixed_current_shares','source':p['source'],'probeSharesRaw':S,'asset':p['asset'],'assetDecimals':18,'shareDecimals':18,'assetsRaw':p['probeEaAssetRaw']}})
result={'schema':'morpho_v2_rlusd_idle_research_facts_v1','researchOnly':True,'authority':False,'captureCurrentReference':d['currentSource'],'captureSharesRaw':S,'anchors':points,'actualHistoricalOwnerSharesDiagnosticRaw':[p['actualOwnerSharesRaw'] for p in d['points'][1:]],'historicalOwnedEntitlementAssetRaw':None,'verificationCompletedAtUtc':None}
OUT.mkdir(mode=0o700)
os.chmod(OUT,0o700)
b=(json.dumps(result,indent=2,ensure_ascii=False)+'\n').encode()
fd=os.open(OUT/'rlusd-original-research-facts.json', os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
with os.fdopen(fd,'wb') as output: output.write(b)
print(json.dumps({'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'clock':'unset; parent must stamp actual readback completion'}))
