"""Generated transport fixtures only: no real data, fitting or semantic admission."""
import copy
import datetime as dt
import gzip
import hashlib
import json
import unittest
from unittest import mock
from fractions import Fraction

import r17_asof_e_compact_adapter as A


def descriptor(path, data):
    return {'path':path,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()}


def contract():
    d=descriptor('synthetic-only',b'not an audit')
    return dict(source='dev',r193_commit=A.R193_COMMIT,r193_sha256=A.R193_SHA,
        pool_kind='FULL_R192_ISSUED_SCORED_ROWS_THEN_R193_FILTERS',exclusions=list(A.EXCLUSIONS),
        horizons=list(A.HORIZONS),levels=list(A.LEVELS),
        rowsB=[dict(horizon_hours=h,file=d.copy(),header=d.copy()) for h in A.HORIZONS],
        ordered_source_keys=d.copy(),row_support=d.copy(),filter_evidence=d.copy(),crosswalk_evidence=d.copy(),
        crosswalk=[dict(sid=0,canonical_key='dev:BTC',source='dev',group='btc_eth')],
        support_origin_span=[A.QUERY_START-168*3600,A.QUERY_START+730*A.QUERY_STEP],
        provider_publication_time_verified=False,
        query_grid=dict(start_utc_seconds=A.QUERY_START,count=A.QUERY_COUNT,step_seconds=A.QUERY_STEP))


class AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c=contract()
        cls.lines=[','.join(A.HEADER)]
        for g in A.GROUPS:
            for h in A.HORIZONS:
                for level in A.PERCENT_LEVELS:
                    for i in range(A.QUERY_COUNT):
                        t=A.QUERY_START+i*A.QUERY_STEP
                        # i=0 tests the Jeffreys-only empty pool; i=1 admits two
                        # rows exactly at the resolution cutoff, then one/day.
                        n=0 if i==0 else i+1
                        y=0 if i==0 else 1
                        lo='' if i==0 else str(A.QUERY_START+A.QUERY_STEP-h*3600)
                        hi='' if i==0 else str(t-h*3600)
                        rt='' if i==0 else str(t)
                        date=dt.datetime.fromtimestamp(t,dt.timezone.utc).strftime('%Y-%m-%d')
                        fc=format(float(Fraction(2*y+1,2*(n+1))),'.17g')
                        cls.lines.append(','.join(map(str,('dev',g,h,level,t,date,n,y,lo,hi,rt,'available',int(n==0),fc))))

    def bindings(self, lines=None):
        body=('\n'.join(lines if lines is not None else self.lines)+'\n').encode('ascii')
        compressed=gzip.compress(body,mtime=0,compresslevel=1)
        return compressed,dict(compressed_descriptor=descriptor('fixture.csv.gz',compressed),
            csv_descriptor=descriptor('fixture.csv',body),semantic_contract=copy.deepcopy(self.c),
            contract_sha256=A.sha(A.canonical(self.c)))

    def changed(self,index,field,value):
        lines=self.lines.copy()
        row=lines[index].split(',');row[A.HEADER.index(field)]=value
        lines[index]=','.join(row)
        return lines

    def rejects(self, lines, message):
        data,bindings=self.bindings(lines)
        with self.assertRaisesRegex(ValueError,message):
            A.convert(data,**bindings)

    def test_complete_and_deterministic(self):
        data,b=self.bindings()
        payload,receipt=A.convert(data,**b)
        self.assertEqual((payload,receipt),A.convert(data,**b))
        result=json.loads(payload)
        self.assertEqual(len(result['series']),60)
        curve=result['series'][0]
        self.assertEqual(curve['barrier'],'-0.02')
        self.assertEqual(curve['records'][0],[A.QUERY_START,0,0,None,None])
        self.assertEqual(curve['records'][1],[A.QUERY_START+A.QUERY_STEP,2,1,
            A.QUERY_START+A.QUERY_STEP-6*3600,A.QUERY_START+A.QUERY_STEP-6*3600])
        self.assertEqual(json.loads(receipt)['payload']['sha256'],A.sha(payload))
        self.assertNotIn('semantic_review',result)
        # Input ordering is irrelevant to canonical curve/record ordering.
        shuffled=[self.lines[0]]+list(reversed(self.lines[1:]))
        d2,b2=self.bindings(shuffled)
        p2,_=A.convert(d2,**b2)
        self.assertEqual(payload,p2)

    def test_exact_large_integer_counts(self):
        lines=self.lines.copy()
        for index in range(1,len(lines)):
            row=lines[index].split(',')
            if row[6]!='0':
                row[6]=str(int(row[6])+2**40)
                row[13]=format(float(Fraction(2*int(row[7])+1,2*(int(row[6])+1))),'.17g')
                lines[index]=','.join(row)
        data,b=self.bindings(lines)
        payload,_=A.convert(data,**b)
        self.assertEqual(json.loads(payload)['series'][0]['records'][1][1],2**40+2)

    def test_cli_binding_cap_on_opened_bytes(self):
        # Simulate a concurrently enlarged/replaced file handle. The CLI must
        # cap the opened stream rather than relying on an earlier pathname stat.
        import io
        opened=io.BytesIO(b' '* (1024**2+1))
        with mock.patch('builtins.open',return_value=opened), mock.patch(
                'sys.argv',['adapter','source.gz','bindings.json','out.json','receipt.json']):
            with self.assertRaisesRegex(ValueError,'binding file byte cap'):
                A.main()

    def test_units_cutoff_and_dates(self):
        for field,value,message in [('barrier','-0.02','percent'),('horizon_hours','21600','registered source'),
             ('origin_utc_seconds',str(A.QUERY_START+1),'cutoff grid'),('origin_utc','2024-01-02','date/cutoff')]:
            with self.subTest(field=field):
                self.rejects(self.changed(1,field,value),message)

    def test_counts_and_forecast(self):
        for field,value,message in [('n','2.0','canonical integer'),('n','9007199254740992','count domain'),
             ('sum_y','3','count domain'),('forecast','nan','Jeffreys'),('forecast','inf','Jeffreys'),('forecast','0.5000000000000001','Jeffreys'),
             ('availability','unavailable','availability'),('zero_support','0','zero_support')]:
            with self.subTest(field=field):
                self.rejects(self.changed(1,field,value),message)
        # A valid local Jeffreys value cannot disguise decreasing support.
        lines=self.changed(4,'n','1')
        row=lines[4].split(',');row[7]='1';row[13]='0.75';lines[4]=','.join(row)
        self.rejects(lines,'cumulative counts')

    def test_support(self):
        for index,field,value,message in [(1,'support_ts_min','1','empty support'),
            (2,'resolve_ts_max',str(A.QUERY_START+86401),'resolved clock'),
            (2,'support_ts_max',str(A.QUERY_START+86401),'resolved clock'),
            (3,'support_ts_min',str(A.QUERY_START+86400-6*3600+1),'earliest prefix')]:
            with self.subTest(index=index,field=field):
                self.rejects(self.changed(index,field,value),message)

    def test_source_hash_contract_and_caps(self):
        data,b=self.bindings()
        b['compressed_descriptor']['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'compressed hash'):
            A.convert(data,**b)
        data,b=self.bindings();b['csv_descriptor']['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'CSV hash'):
            A.convert(data,**b)
        data,b=self.bindings();b['contract_sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'contract hash'):
            A.convert(data,**b)
        data,b=self.bindings();b['semantic_contract']['query_grid']['count']=730
        with self.assertRaisesRegex(ValueError,'query grid'):
            A.convert(data,**b)
        data,b=self.bindings();b['csv_descriptor']['size']=A.MAX_CSV_BYTES+1
        with self.assertRaisesRegex(ValueError,'CSV byte cap'):
            A.convert(data,**b)
        data,b=self.bindings();b['csv_descriptor']['size']=1
        with self.assertRaisesRegex(ValueError,'CSV hash/size'):
            A.convert(data,**b)

    def test_header_duplicates_and_census(self):
        self.rejects([self.lines[0]+',extra']+self.lines[1:],'header')
        self.rejects(self.lines[:-1],'census')
        lines=self.lines.copy();lines[-1]=lines[1]
        self.rejects(lines,'duplicate record')
        self.rejects(self.changed(1,'source','blind'),'registered source')

    def test_shared_support_and_nested_events(self):
        # Change all rows of one curve while preserving each curve's internal
        # cumulative consistency. Shared support must still reject it.
        lines=self.lines.copy()
        for index in range(733,1463):
            row=lines[index].split(',');row[6]=str(int(row[6])+1)
            row[13]=format(float(Fraction(2*int(row[7])+1,2*(int(row[6])+1))),'.17g')
            lines[index]=','.join(row)
        self.rejects(lines,'shared level support')
        lines=self.lines.copy()
        for index in range(733,1463):
            row=lines[index].split(',');row[7]='2'
            row[13]=format(float(Fraction(5,2*(int(row[6])+1))),'.17g')
            lines[index]=','.join(row)
        self.rejects(lines,'nested downside outcomes')


if __name__=='__main__':
    unittest.main()
