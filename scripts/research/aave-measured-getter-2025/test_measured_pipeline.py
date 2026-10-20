"""Synthetic complete CLI pipeline; only provider pins change in test-only copies.
Mac bridge skips Linux AS limit, converts RSS units, and relaxes platform gate.
It does not establish Linux enforcement. No real cache/history/model input used.
"""
import copy
import gzip
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

D = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location(name, D / (name + '.py'))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

F = load('test_measured_admission'); M = F.M
E = load('measured_evaluation'); K = load('measured_kernel'); J = load('measured_join')
R = load('measured_runner')
enc = lambda v: (json.dumps(v, sort_keys=True, separators=(',', ':')) + '\n').encode()
pin = lambda b: {'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()}
desc = lambda p, b: {'path': str(p), **pin(b)}

def fixture():
    b, p, pins, audit, _ = F.fixture()
    feature, measurement, ar = b['rows'][0], p['measurements'][0], audit['rows'][0]
    b['rows'] = []; p['measurements'] = []; p['exactObservedStates'] = []; audit['rows'] = []
    rawrows = []
    for i, c in enumerate(E.frozen_calendar()):
        T = c['issueAt']; B = 10 * (i + 1); h = '0x' + format(B, '064x')
        row = copy.deepcopy(feature); row.update(issueAt=T, blockNumber=B, blockTimestamp=T-5,
            nextBlockNumber=B+1, nextBlockTimestamp=T+7, blockHash=h,
            nextBlockHash='0x'+format(B+1, '064x'), nextBlockParentHash=h)
        m = copy.deepcopy(measurement); m.update(issueAt=T, blockNumber=B)
        m['stateTag']['blockHash'] = h
        for call in m['calls'].values(): call['stateTag']['blockHash'] = h
        aa = copy.deepcopy(ar); aa.update(issueAt=T, featureBlock=B, featureHash=h)
        b['rows'].append(row); p['measurements'].append(m); audit['rows'].append(aa)
        p['exactObservedStates'].append({'blockNumber': B, 'blockHash': h})
        lags = copy.deepcopy(aa['lags'])
        for x in lags.values(): x.update(maxIncludedEventBlock=B-1, maxIncludedRecordedTs=T-6)
        rawrows.append(dict(c, status='RAW_LAGS_STOCK_JOIN_PENDING',
            strictPreIssuePrefix={'cumulativeNetRaw': '5', 'lastIncludedBlock': B-1, 'lastIncludedRecordedTs': T-6},
            boundaryPrefixes={str(w): {'cumulativeNetRaw': str(5-j)} for j,w in enumerate((3600,21600,86400,604800),1)}, lags=lags))
    p['measuredEpochs']['measured']['effectiveToExclusiveBlock'] = 2000
    raw = {'status': 'RAW_LAGS_STOCK_JOIN_PENDING', 'conditionalReconstructionOffsetRawNotQualifiedStock': '5', 'rows': rawrows}
    return b, p, audit, raw


class Pipeline(unittest.TestCase):
    def test_R_masks_only_logS_and_keeps_A_original_weights(self):
        original = F.K
        vectors = [[float(i) if j == 1 else 0.0 for j in range(14)] for i in range(4)]
        target = [0.0] * 14; target[1] = .3; prep = K.preprocessing(vectors)
        for bw in K.BANDWIDTHS:
            self.assertEqual(K.weights(vectors, target, prep, bw, 'A'), original.weights(vectors, target, prep, bw))
            changed = target.copy(); changed[1] = 2.7
            self.assertEqual(K.weights(vectors, target, prep, bw, 'R'), K.weights(vectors, changed, prep, bw, 'R'))
        self.assertNotEqual(K.weights(vectors, target, prep, .5, 'A'), K.weights(vectors, changed, prep, .5, 'A'))

    def test_synthetic118_join_and_actual_AR_core_through_cli(self):
        b, p, audit, raw = fixture()
        with tempfile.TemporaryDirectory(dir=D) as temp:
            t = Path(temp)
            cachebody = b'SYNTHETIC'; cp = t/'fake-cache'; cp.write_bytes(cachebody); cache = desc(cp, cachebody)
            fb = enc(b); feature = t/'features.json'; feature.write_bytes(fb)
            p['featureFileSHA256'] = pin(fb)['sha256']; pb = enc(p); proof = t/'proof.json'; proof.write_bytes(pb)
            raw['inputPins'] = {'cache': cache}; rb = enc(raw); cal = enc(E.frozen_calendar())
            w = {'rows': p['measurements'], 'measurementProofDescriptors': p['measurements'][0]['evidenceDescriptors']}; wb = enc(w)
            bodies = {'raw': rb, 'calendar': cal, 'features': fb, 'proof': pb, 'witness': wb}
            inputs = {}
            for name, body in bodies.items():
                path=t/(name+'.json');path.write_bytes(body);inputs[name]=desc(path,body)
            inputs['cache'] = cache
            auth = {'schema': 'q9-root-measured-base-stock-join-authority-v1', 'status': 'ROOT_MEASURED_EXACT_STATES',
                'measurementProfile': M.PROFILE, 'limits': M.LIMITS, 'boundInputs': copy.deepcopy(inputs),
                'calendarPin': J.CAL_PIN, 'originCount': 118, 'measurementProofDescriptors': w['measurementProofDescriptors'],
                'measurementProofRoles': ['candidate','canonicalWitness','executionReceipt','getterWitness']}
            ab=enc(auth);ap=t/'authority.json';ap.write_bytes(ab);inputs['authority']=desc(ap,ab)
            # Fixture-only RAW_PIN replacement, never production source mutation.
            js=(D/'measured_join.py').read_text();old=next(x for x in js.splitlines() if x.startswith('RAW_PIN='));js=js.replace(old,'RAW_PIN='+repr(pin(rb)),1)
            jp=t/'synthetic_join.py';jp.write_text(js)
            osource=(D/'measured_onejoin.py').read_text();oldpin=(len((D/'measured_join.py').read_bytes()),pin((D/'measured_join.py').read_bytes())['sha256'])
            osource=osource.replace(repr(oldpin),repr((len(js.encode()),pin(js.encode())['sha256'])))
            if sys.platform != 'linux':
                osource=osource.replace('resource.setrlimit(resource.RLIMIT_AS,(256*2**20,256*2**20));','')
                osource=osource.replace("resource.getrusage(resource.RUSAGE_SELF).ru_maxrss", "(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss//1024)")
            op=t/'onejoin.py';op.write_text(osource)
            deps={'join':desc(jp,js.encode()),'admission':desc(D/'measured_admission.py',(D/'measured_admission.py').read_bytes()),'kernel':desc(D/'measured_kernel.py',(D/'measured_kernel.py').read_bytes())}
            config={'executionAuthorized':True,'inputs':inputs,'dependencies':deps,'launcher':desc(op,osource.encode()),'output':str(t/'audit.json')}
            cfg=t/'join-config';cfg.write_bytes(enc(config))
            result=subprocess.run([sys.executable,'-B',str(op),'--config',str(cfg),'--config-sha256',pin(enc(config))['sha256']],capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr)
            jr=json.loads(result.stdout);self.assertEqual(jr['cachePasses'],0);self.assertEqual(jr['measurementProfile'],M.PROFILE)
            self.assertEqual(len(json.loads((t/'audit.json').read_bytes())['rows']),118)
            # Test-only cache provider and threshold fixtures. A/R estimator and measured admission remain byte-identical.
            pilot_code='''import hashlib
class Seq:
 def __init__(self,a,b):self.a=a;self.b=b
 def __len__(self):return 969263
 def __getitem__(self,k):return self.a if k==0 else self.b
def load_cache(path,pin,expected_rows):
 b=path.read_bytes();assert len(b)==pin['bytes'] and hashlib.sha256(b).hexdigest()==pin['sha256'];return Seq(1674808907,1791932579),Seq(10,10),{'syntheticOnly':True,'rows':969263}
def path(ts,cash,T,h):return [(0,10),(h//2,8),(h,9)],h,True
'''
            threshold_code='''class Index:
 def __init__(self,points,h):self.base=points[0][1];self.terminal=points[-1][1];self.minimum=min(c for _,c in points)
'''
            pp=t/'pilot.py';pp.write_text(pilot_code);tp=t/'threshold.py';tp.write_text(threshold_code)
            source=(D/'measured_runner.py').read_text()
            for name, body in [('pilot',pilot_code.encode()),('threshold',threshold_code.encode())]:
                old=R.FIXED[name];source=source.replace("'"+name+"': ("+str(old[0])+", '"+old[1]+"')", "'"+name+"': ("+str(len(body))+", '"+pin(body)['sha256']+"')")
            source=source.replace(repr(R.CACHE),repr(pin(cachebody)))
            # Original literal CACHE declaration is stable but JSON-style quote spelling differs.
            source=source.replace("CACHE = {'bytes': 55020818, 'sha256': '1d3d46360eff4b9f5e8e398372e5aa47aa665015878e099abbbfba7f92ed8345'}", 'CACHE = '+repr(pin(cachebody)))
            if sys.platform != 'linux':
                source=source.replace("need(sys.platform == 'linux', 'cloud_linux_only')", "need(True, 'cloud_linux_only')")
                source=source.replace('resource.setrlimit(resource.RLIMIT_AS, (768 * MiB, 768 * MiB))','pass # test bridge skips Linux AS')
                source=source.replace("'RSSKiB': usage.ru_maxrss", "'RSSKiB': usage.ru_maxrss//1024")
            rp=t/'runner.py';rp.write_text(source)
            sources={name:desc(path,path.read_bytes()) for name,path in [('runner',rp),('kernel',D/'measured_kernel.py'),('admission',D/'measured_admission.py'),('evaluator',D/'measured_evaluation.py'),('pilot',pp),('threshold',tp)]}
            inputs={name:desc(path,path.read_bytes()) for name,path in [('cache',cp),('features',feature),('proof',proof),('audit',t/'audit.json')]}
            config={'executionAuthorized':True,'sources':sources,'inputs':inputs,'outputPath':str(t/'forecast')}
            cfg=t/'forecast-config';cfg.write_bytes(enc(config))
            result=subprocess.run([sys.executable,'-B',str(rp),'--execute-reviewed-historical-once','--config',str(cfg),'--config-sha256',pin(enc(config))['sha256']],capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr)
            summary=json.loads((t/'forecast'/'summary.json').read_bytes())
            self.assertEqual(summary['evidenceProfile'],M.PROFILE);self.assertEqual(summary['profileLimits'],M.LIMITS)
            self.assertEqual(set(summary['primary24hMinimum']),{'A','R'})
            complete=json.loads(gzip.decompress((t/'forecast'/'report.json.gz').read_bytes()))
            self.assertEqual(complete['underlyingPathProviderCalls'],472)
            self.assertEqual(complete['relativeQDefinition']['additionalPathReads'],0)
            for arm in ('A','R'):
                report=complete['arms'][arm]
                self.assertEqual(report['CV']['CVOriginCount'],30)
                self.assertEqual(report['frozenTrainingPreprocessing']['donorCount'],59)
                self.assertEqual([report['primary24hMinimum'][x]['n'] for x in ('CAL','DEV')],[29,30])
                grid=complete['relativeQ'][arm][0]['horizons']['86400']['kernel_base']
                self.assertEqual(len(grid),13)
                self.assertEqual(grid['cash_fraction_5_4']['QRawExact'],{'numerator':'25','denominator':'2'})
                self.assertEqual(grid['cash_fraction_5_4']['minimumShortageProbability'],{'numerator':'1','denominator':'1'})
                self.assertEqual(grid['cash_fraction_1_10']['minimumShortageProbability'],{'numerator':'0','denominator':'1'})
            receipt=json.loads((t/'forecast'/'receipt.json').read_bytes());self.assertEqual(receipt['cacheBytePasses'],1)
            # Execution-default remains inert and exclusive outputs cannot be reused.
            inert=subprocess.run([sys.executable,'-B',str(rp)],capture_output=True,text=True,timeout=5)
            self.assertNotEqual(inert.returncode,0)

if __name__=='__main__':unittest.main()
