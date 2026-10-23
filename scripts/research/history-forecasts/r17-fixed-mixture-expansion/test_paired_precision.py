import os
import resource
import time
import unittest
import numpy as np
import paired_precision as P

class Precision(unittest.TestCase):
    def stats(self):
        return P.sufficient(np.array([0,0,1,2],np.int32),np.array([1704067200,1704153600,1735603200,1735689600],np.int64),np.array([0.,.8,.2,.9]),np.array([.1,.6,.4,.8]),np.array([1,0,0,255],np.uint8),np.array([1,1,1,0],bool),status=P.READY)
    def test_uint8(self):
        d=P.delta([.2],[.8],np.array([1],np.uint8));self.assertAlmostEqual(d[0,1],np.log(4.));self.assertAlmostEqual(d[0,0],.6)
    def test_unknown_placeholder(self):
        s=self.stats();self.assertEqual(s['unknown_N'].sum(),1);self.assertNotEqual(s['completed'][...,0,:].sum(),s['completed'][...,1,:].sum())
        self.assertEqual(s['events'].sum(),1)
    def test_tiny_row_oracle(self):
        s=self.stats();K=len(s['blocks']);ws=np.zeros((1,277),np.uint16);ws[0,:3]=[2,1,274];wb=np.zeros((1,K),np.uint16);wb[0,0]=1;wb[0,-1]=K-1
        safe,d=P.calculate(s,ws,wb)
        for label in(0,1):
            y=np.array([1,0,0,label],float);dif=P.delta([.1,.6,.4,.8],[0.,.8,.2,.9],y);sid=s['sid'];bi=np.searchsorted(s['blocks'],s['ts']//P.BLOCK)
            for mi,mode in enumerate(('time_only','series_only','series_label_x_time')):
                for vi,yr in enumerate(('pooled','2024','2025')):
                    take=np.ones(4,bool)if vi==0 else (s['ts']<1735689600 if vi==1 else s['ts']>=1735689600)
                    w=wb[0,bi] if mi==0 else ws[0,sid] if mi==1 else wb[0,bi]*ws[0,sid]
                    den=int(w[take].sum());self.assertEqual(d['draw_denominators'][mi,vi,0],den)
                    if den:self.assertTrue(np.allclose(d['draw_means'][mi,vi,label,0],np.sum(dif[take]*w[take,None],axis=0)/den,rtol=0,atol=1e-14))
    def test_global_weights(self):
        s=self.stats();ws,wb=P.weights(len(s['blocks']),draws=20);self.assertEqual(ws.shape,(20,277));self.assertTrue(np.all(ws.sum(1)==277));self.assertTrue(np.all(wb.sum(1)==len(s['blocks'])))
        _,d=P.calculate(s,ws,wb);self.assertTrue(np.array_equal(d['series_weights'],ws));self.assertTrue(np.array_equal(d['block_weights'],wb))
        # 2024-12-31 and2025-01-01 share one epoch block; no annual redraw.
        self.assertEqual(1735603200//P.BLOCK,1735689600//P.BLOCK)
    def test_exact_multinomial_tiny(self):
        count=np.zeros((277,2),np.int64);count[0]=[1,1];matrix=np.zeros((277,2));matrix[0]=[1.,3.]
        ws=np.ones((4,277),np.uint16);wb=np.array([[2,0],[1,1],[1,1],[0,2]],np.uint16)
        draw,den=P.weighted(matrix,count,ws,wb,'time_only');self.assertTrue(np.array_equal(draw,[1.,2.,2.,3.]));self.assertEqual(draw.mean(),2.);self.assertEqual(draw.var(),.5)
    def test_zero_denominator(self):
        s=self.stats();ws=np.zeros((1,277),np.uint16);ws[0,276]=277;wb=np.ones((1,len(s['blocks'])),np.uint16)
        safe,d=P.calculate(s,ws,wb);self.assertEqual(safe['views']['pooled']['resampling']['series_only']['0']['zero_denominator_draws'],1);self.assertTrue(np.isnan(d['draw_means'][1]).all())
    def test_empty_year(self):
        s=P.sufficient(np.array([0],np.int32),np.array([1704067200],np.int64),np.array([.2]),np.array([.1]),np.array([0],np.uint8),np.ones(1,bool),status=P.READY);ws,wb=P.weights(1,draws=5);r,d=P.calculate(s,ws,wb);self.assertEqual(r['views']['2025']['J_n'],0);self.assertIsNone(r['views']['2025']['observed_delta']);self.assertEqual(r['views']['2025']['resampling']['time_only']['0']['zero_denominator_draws'],5)
    def test_refusals(self):
        with self.assertRaisesRegex(ValueError,'DRAFT'):P.run('/absent','x')
        s=self.stats()
        with self.assertRaises(ValueError):P.sufficient(s['sid'],s['ts'],np.full(4,np.nan),np.ones(4),np.zeros(4,np.uint8),np.ones(4,bool),status=P.READY)
        with self.assertRaisesRegex(ValueError,'duplicate'):P.sufficient(np.array([0,0],np.int32),np.array([1704067200]*2,np.int64),np.zeros(2),np.zeros(2),np.zeros(2,np.uint8),np.ones(2,bool),status=P.READY)

@unittest.skipUnless(os.environ.get('Q26_PRECISION_BENCHMARK')=='1','explicit generated fullshape benchmark')
class GeneratedBenchmark(unittest.TestCase):
    def test_fullshape(self):
        start=time.monotonic();n=186232;i=np.arange(n);sid=(i%277).astype(np.int32);day=(i//277)%731;ts=(1704067200+day*86400).astype(np.int64);A=(.03+(i%19)*.01).astype(float);C=A*.99;y=(i%23==0).astype(np.uint8);known=np.ones(n,bool);known[0]=False
        s=P.sufficient(sid,ts,A,C,y,known,status=P.READY);ws,wb=P.weights(len(s['blocks']));r,p=P.calculate(s,ws,wb)
        self.assertEqual(r['views']['pooled']['J_n'],n);self.assertEqual(ws.shape[0],10000)
        import io
        buf=io.BytesIO();np.savez_compressed(buf,**s,**p);self.assertLess(len(buf.getvalue()),16*1024**2)
        print(dict(compressed_bytes=len(buf.getvalue()),scope='GENERATED_ONLY_FULL186232_SHAPE',seconds=time.monotonic()-start,OS_peak_RSS_native=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,logical_bytes=sum(v.nbytes for v in [*s.values(),*p.values()])),flush=True)
if __name__=='__main__':unittest.main()
