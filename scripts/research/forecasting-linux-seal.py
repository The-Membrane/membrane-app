import pathlib,json,hashlib,shutil
r=pathlib.Path(__file__).resolve().parents[2]; evidence=pathlib.Path('/workspace/membrane-datasets/forecasting-cloud/linux-recovery')
node=pathlib.Path(shutil.which('node')).resolve(); deps=(r/'node_modules/vitest').resolve(); packages=set(); links={str(r/'node_modules'):str((r/'node_modules').resolve()),str(r/'node_modules/vitest'):str(deps)}
def find(name,base):
 for p in [base,*base.parents]:
  candidate=p/'node_modules'/name
  if (candidate/'package.json').exists():
   links[str(candidate)]=str(candidate.resolve()); return candidate.resolve()
 return None
def visit(p):
 if p in packages:return
 packages.add(p); j=json.loads((p/'package.json').read_text())
 for name in {**j.get('dependencies',{}),**j.get('optionalDependencies',{}),**j.get('peerDependencies',{})}:
  q=find(name,p)
  if q:visit(q)
tsx=(r/'node_modules/.pnpm/tsx@4.21.0/node_modules/tsx').resolve()
visit(tsx)
visit(deps)
visit((r/'node_modules/viem').resolve())
for name in ['react','react-dom','@chakra-ui/react']:visit((r/'node_modules'/name).resolve())
files={node,r/'package.json',r/'pnpm-lock.yaml'}
for p in packages:
 files.update(x for x in p.rglob('*') if x.is_file() and 'node_modules' not in x.relative_to(p).parts)
for dirname in ['lib','components','scripts','pages','config','helpers','theme','tests/unit']:
 
 for suffix in ['*.ts','*.tsx','*.json','*.mjs','*.js','*.cjs','*.py']:
  files.update((r/dirname).rglob(suffix))
for n in ['forecasting-linux-gate.py','forecasting-linux-seal.py','forecasting-linux.vitest.config.ts','forecasting-offline-trap.ts','conditional-cash-time-holdout.mjs']:files.add(r/'scripts/research'/n)
files.add(r/'scripts/lib/boundedLocalReceiptFile.mjs')
for n in ['sampledRecoveryOutlook','sampledRecoveryHistoryAnalysis','fixedEntitlementCashOutlook','morphoV2NativeHolderIdentity','sparseVenueFlowOutlook','forecastCloudHistoryReplay']:files.add(r/'tests/unit'/f'{n}.test.ts')
files.update((evidence.parent/'data/research/venue-signals').glob('conditional-sampled-cash-history-v1.*.json'))
pins={str(p.resolve()):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}
for tag,suite in [('focused','sampledRecoveryOutlook'),('history','sampledRecoveryHistoryAnalysis'),('fixed-cash','fixedEntitlementCashOutlook'),('native-cash','morphoV2NativeHolderIdentity'),('sparse-flow','sparseVenueFlowOutlook'),('holdout-replay','forecastCloudHistoryReplay'),('holder-api','morphoV2HolderExitAssessmentApi'),('direct-cash','conditionalCashHolderTimeProcess'),('native-api','morphoNativeCashOutlookApi'),('native-card','morphoNativeCashOutlookCard.node'),('typecheck-core','core'),('typecheck-sparse','sparse')]:
 spec={'schema':'forecasting-linux-recovery-gate-v1','tag':tag,'checkout':str(r),'datasetsRoot':'/workspace/membrane-datasets','evidenceRoot':str(evidence),
 'argv':[str(node),'--max-old-space-size=192','--max-semi-space-size=1','--require',str(r/'scripts/research/forecasting-heap-workers.cjs'),str((deps/'vitest.mjs').resolve()),'run','--config',str(r/'scripts/research/forecasting-linux.vitest.config.ts'),f'tests/unit/{suite}.test.ts'],
 'pins':pins,'links':links,'parentSpecSha256':'57c4d7f0bca25e6e23894212967330f73c92f26bc3da87dad2ffa74870ebf251' if tag=='focused' else '56631024f3140a7de2cab112baceb28c7abece36a05c236b9a14991b9091f6f8'}
 if tag=='native-api':spec['argv'].insert(3,'--expose-gc')
 if tag=='native-card':
  spec['argv']=[str(node),'--max-old-space-size=192','--max-semi-space-size=1','--require',str(r/'scripts/research/forecasting-heap-workers.cjs'),'--import',str(tsx/'dist/loader.mjs'),'--import',str(r/'scripts/research/forecasting-offline-trap.ts'),str(r/'tests/unit/morphoNativeCashOutlookCard.node.test.tsx')]
 if tag in ['typecheck-core','typecheck-sparse']:
  spec['argv']=[str(node),'--max-old-space-size=192','--max-semi-space-size=1',str((r/'node_modules/typescript/bin/tsc').resolve()),'--project',str(r/'scripts/research'/('forecasting-linux.typecheck-sparse.json' if tag=='typecheck-sparse' else 'forecasting-linux.typecheck.json')),'--pretty','false']
 p=evidence/f'{tag}.spec.json';p.write_text(json.dumps(spec,indent=2)+'\n');p.chmod(0o600); immutable=evidence/(tag+'.'+hashlib.sha256(p.read_bytes()).hexdigest()+'.spec.json'); immutable.write_bytes(p.read_bytes()); immutable.chmod(0o600)
 print(tag,len(pins),'pins',len(packages),'dependency packages',sum(p.stat().st_size for p in files),'bytes',hashlib.sha256(p.read_bytes()).hexdigest())
