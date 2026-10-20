"""Pure synthetic assembler checks, without real receipt endorsement or joining."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

D = Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,D/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

S=load('assemble_measured');P=load('test_measured_pipeline');M=P.M


def fixture():
    b,p,a,raw=P.fixture();rows=[]
    for row,measurement in zip(b['rows'],p['measurements']):
        rows.append([row[k] for k in ('issueAt','blockNumber','blockTimestamp','blockHash','nextBlockTimestamp','nextBlockHash')]
                    +[int(row['physicalCashRaw']),int(row['nominalClaimsRaw']),1,15*10**26,0])
    identities=copy.deepcopy(p['measuredEpochs']['measured']['runtimeIdentities'])
    for v in identities.values():v['implementationSlot']='0x'+'0'*24+v['codeAddress'][2:]
    recs={};origins={}
    for row in rows:
        T=row[0];q={'bytes':10,'sha256':hashlib.sha256(str(T).encode()).hexdigest()}
        recs['/Archive/record-'+str(T)+'.json']={'issueAt':T,'pin':q}
        origins[str(T)]={'recordPin':q,'firstGlobalCharge':1,'lastGlobalCharge':44,'journalKind':'synthetic'}
    manifest=S.encode({'schema':'frozen-original-record-manifest/v1','records':recs})
    membership={'bytes':1300,'sha256':'d'*64}
    table={'schema':'q9-compact-measured-stock-table/v1','columns':S.COLUMNS,'rows':rows,
           'sourceQualified':False,'scientificAdmission':False,'identityCatalogue':[identities],
           'originalManifestPin':S.pin(manifest),'membershipPin':membership,'boundaryEqualityCount':0}
    receipt={'schema':'saved118journal-authenticity-audit/v1','status':'PASS','failures':[],
             'counts':{'origins':118,'getterValues':472},'sourceQualified':False,'networkRPC':0,
             'allOriginalEvidencePinsAndStatsUnchanged':True,
             'provenance':{'originDescriptors':origins,'membershipPin':membership}}
    blobs={'table':S.encode(table),'journalAudit':S.encode(receipt),'originalManifest':manifest,'calendar':S.encode(P.E.frozen_calendar())}
    ds={k:{'path':'/synthetic/'+k,**S.pin(v)} for k,v in blobs.items()}
    ds.update(raw={'path':'/Source/raw','bytes':1,'sha256':'a'*64},cache={'path':'/Source/cache','bytes':1,'sha256':'b'*64})
    review={'status':'ROOT_ENDORSED_MEASURED_GETTERS','scope':S.PROFILE_SCOPE,'bindings':copy.deepcopy(ds),
            'limits':M.LIMITS,'finalPathBindingsApproved':True}
    output={k:'/Source/'+k+'.json' for k in ('features','proof','witness','authority')}
    review['outputPaths']=copy.deepcopy(output)
    return blobs,ds,review,output


def run(args):
    b,d,r,o=args
    return S.assemble(b['table'],b['journalAudit'],b['originalManifest'],b['calendar'],d,r,o,M)


class Assembler(unittest.TestCase):
    def test_exact118_truthful_profile_and_no_execution(self):
        args=fixture();before=copy.deepcopy(args);result=run(args)
        self.assertEqual(args,before);self.assertIs(result['joinConfigTemplate']['executionAuthorized'],False)
        b=json.loads(result['files']['features']);p=json.loads(result['files']['proof']);w=json.loads(result['files']['witness'])
        self.assertEqual(len(b['rows']),118);self.assertEqual(len(w['rows']),118)
        times=tuple(r['issueAt'] for r in b['rows']);q,ex=M.qualified_features(b,p,result['descriptors']['features'],times,64800)
        self.assertFalse(ex);self.assertEqual(len(q),118)
        self.assertIn('NOT_RAW_RESPONSE_CAPTURE',w['rows'][0]['returnEncoding'])
        self.assertFalse(result['limits']['sourceCompilationEstablished'])
        self.assertEqual(run(args)['files'],result['files'])
        for key,body in result['files'].items():self.assertEqual(S.pin(body),{k:result['descriptors'][key][k] for k in ('bytes','sha256')})

    def test_pending_receipt_or_final_paths_cannot_activate(self):
        args=fixture();args[2]['status']='PENDING_ROOT_REVIEW'
        with self.assertRaises(ValueError):run(args)
        args=fixture();args[2]['finalPathBindingsApproved']=False;result=run(args)
        self.assertEqual(json.loads(result['files']['authority'])['status'],'PENDING_ROOT_FINAL_PATH_BINDING')
        self.assertFalse(result['joinConfigTemplate']['executionAuthorized'])

    def test_final_approval_binds_exact_output_paths(self):
        args=fixture();args[3]['features']='/different/features.json'
        with self.assertRaisesRegex(ValueError,'root_output_path_binding'):run(args)
        args=fixture();del args[2]['outputPaths']
        with self.assertRaisesRegex(ValueError,'root_output_path_binding'):run(args)

    def test_bad_receipt_original_pin_calendar_and_getter(self):
        for edit in ('receipt','recordPin','calendar','value','clock'):
            args=fixture();blobs,ds,review,_=args
            name='journalAudit' if edit in ('receipt','recordPin') else 'calendar' if edit=='calendar' else 'table'
            x=json.loads(blobs[name])
            if edit=='receipt':x['status']='FAILED'
            if edit=='recordPin':next(iter(x['provenance']['originDescriptors'].values()))['recordPin']['sha256']='0'*64
            if edit=='calendar':x[0]['issueAt']+=1
            if edit=='value':x['rows'][0][7]=3
            if edit=='clock':x['rows'][0][2]=x['rows'][0][0]
            blobs[name]=S.encode(x);ds[name].update(S.pin(blobs[name]));review['bindings']=copy.deepcopy(ds)
            with self.assertRaises(ValueError,msg=edit):run(args)


if __name__=='__main__':unittest.main()
