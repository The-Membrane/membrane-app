import copy
import unittest

from r164_derived_history_view import derive_history_view


class DerivedHistoryViewTests(unittest.TestCase):
    def setUp(self):
        self.intraday = {'rows': [
            {'cluster':'A','series':'venue:A','i0':2,'T':24,'k':5,'p_garch':0.0,'p_h3':0.9,'extra':{'keep':[1]}},
            {'cluster':'B','series':'venue:B','i0':7,'T':72,'k':7,'p_garch':1.0},
            {'cluster':'A','series':'venue:A','i0':1,'T':24,'k':5,'p_garch':0.3},
            {'cluster':'A','series':'venue:A','i0':2,'T':72,'k':7,'p_garch':0.4}]}
        for row in self.intraday['rows']:
            row.update(p_fH=0.2,p_rec12=0.3,p_base12=0.4,y=0)
        self.step = {'series':[{'series':'B','quarter_fits':1},{'series':'A','quarter_fits':2}]}
        self.counts = dict(expected_series=2,expected_rows=4,expected_origins=3,expected_quarter_fits=3)
    def derive(self):
        return derive_history_view(self.intraday,self.step,**self.counts)
    def test_full_rows_relative_order_values_and_input_immutability(self):
        old=copy.deepcopy(self.intraday)
        out=self.derive(); rows=out['checkpoints']['A']['result']['rows']
        self.assertEqual(rows,[old['rows'][0],old['rows'][2],old['rows'][3]])
        self.assertEqual([r['p_garch'] for r in rows],[0.0,0.3,0.4])
        self.assertEqual(self.intraday,old)
        rows[0]['extra']['keep'].append(2)
        self.assertEqual(self.intraday,old)
    def test_provenance_and_quarter_counts(self):
        out=self.derive()
        self.assertFalse(out['provenance']['original_checkpoint_bytes_recovered'])
        self.assertFalse(out['provenance']['fitted_states_recovered'])
        self.assertEqual(out['checkpoints']['A']['result']['quarter_fits'],2)
    def test_duplicate_key(self):
        self.intraday['rows'][3]=copy.deepcopy(self.intraday['rows'][0])
        with self.assertRaisesRegex(ValueError,'duplicate'):self.derive()
    def test_identity_mismatch(self):
        self.intraday['rows'][1]['cluster']='C'
        with self.assertRaisesRegex(ValueError,'cluster'):self.derive()
    def test_missing_series_rows(self):
        self.intraday['rows'][1].update(cluster='A',series='venue:A',i0=7)
        with self.assertRaisesRegex(ValueError,'identity_set'):self.derive()
    def test_ambiguous_mapping(self):
        self.intraday['rows'][2]['series']='other:A'
        with self.assertRaisesRegex(ValueError,'ambiguous'):self.derive()
    def test_all_count_mismatches(self):
        for field in self.counts:
            with self.subTest(field=field):
                counts=dict(self.counts);counts[field]+=1
                with self.assertRaises(ValueError):derive_history_view(self.intraday,self.step,**counts)
    def test_missing_or_bad_quarter_counts(self):
        for value in (None,True,1.0,0,-1):
            with self.subTest(value=value):
                self.step['series'][0]['quarter_fits']=value
                with self.assertRaises(ValueError):self.derive()
    def test_duplicate_step_identity(self):
        self.step['series'][1]['series']='B'
        with self.assertRaisesRegex(ValueError,'duplicate'):self.derive()
    def test_missing_required_row_fields(self):
        for field in ('series','cluster','i0','T','k','p_garch'):
            with self.subTest(field=field):
                row=self.intraday['rows'][0];value=row.pop(field)
                with self.assertRaises(ValueError):self.derive()
                row[field]=value
    def test_no_integer_coercion(self):
        for field in ('i0','T','k'):
            for value in (True,1.0,'1',None,-1):
                with self.subTest(field=field,value=value):
                    old=self.intraday['rows'][0][field];self.intraday['rows'][0][field]=value
                    with self.assertRaises(ValueError):self.derive()
                    self.intraday['rows'][0][field]=old
    def test_invalid_gjr_never_substitutes_h3(self):
        for value in (None,True,float('nan'),float('inf'),-0.1,1.1,10**1000,'0.2'):
            with self.subTest(kind=type(value).__name__):
                self.intraday['rows'][0]['p_garch']=value
                with self.assertRaises(ValueError):self.derive()
    def test_original_four_controls_and_binary_label_required(self):
        for field in ('p_fH','p_rec12','p_base12','y'):
            for value in (None,True,float('nan'),float('inf'),-0.1,1.1,'0'):
                with self.subTest(field=field,kind=type(value).__name__):
                    row=self.intraday['rows'][0];original=row[field];row[field]=value
                    with self.assertRaises(ValueError):self.derive()
                    row[field]=original
        self.intraday['rows'][0]['y']=0.5
        with self.assertRaisesRegex(ValueError,'binary_label'):self.derive()
    def test_original_cell_domain(self):
        for field,value in (('T',1),('T',3),('k',10)):
            row=self.intraday['rows'][0];old=row[field];row[field]=value
            with self.assertRaisesRegex(ValueError,'original_cell'):self.derive()
            row[field]=old
    def test_h3_missing_is_not_filter(self):
        self.intraday['rows'][0]['p_h3']=None
        self.intraday['rows'][0]['h3_unavailable_reason']='synthetic missing'
        out=self.derive()
        self.assertEqual(sum(len(v['result']['rows']) for v in out['checkpoints'].values()),4)
        self.assertIsNone(out['checkpoints']['A']['result']['rows'][0]['p_h3'])
    def test_default_original_counts_enforced(self):
        with self.assertRaisesRegex(ValueError,'series_count'):derive_history_view(self.intraday,self.step)
    def test_invalid_fixture_expected_counts(self):
        for value in (True,0,1.0):
            counts=dict(self.counts);counts['expected_series']=value
            with self.assertRaises(ValueError):derive_history_view(self.intraday,self.step,**counts)

if __name__ == '__main__':unittest.main()
