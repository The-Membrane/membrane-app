"""Staged tiny saved-only fixtures; no market arrays, jobs or raw shard reads."""
import copy
import types
import unittest
from pathlib import Path

import numpy as np


def load(name, path):
    m = types.ModuleType(name); m.__file__ = path
    exec(compile(Path(path).read_bytes(), path, 'exec'), vars(m))
    return m


M = load('saved_pair_subject', str(Path(__file__).with_name('q26-weighted-causal-primary-pair-accept.py')))
K = load('saved_pair_kernel', str(Path(__file__).with_name('q26-weighted-causal-primary-pair.py')))
RANGES = (Path(__file__).resolve().parents[1]/'r164_ranges.py').read_bytes()


def fixture():
    rows = []
    for sg in range(5):
        for block in (0, 2, 4, 7, 9, 11):
            for j in range(10):
                for repeat in range(1+j % 3):
                    rows.append((.02+.065*j+.001*sg, int((block+sg+j+repeat) % 4 == 0),
                                 sg, 17532+182*block+10+j))
    v = np.asarray(rows); payloads = {}; results = []; catalogues = []
    for pos, key in enumerate(M.CELLS):
        result = K.cell(v[:, 0], v[:, 1], v[:, 2].astype(np.int64), v[:, 3].astype(np.int64),
                        horizon=key[0], level_index=key[1])
        arrays = {k: x.copy() for k, x in M.flatten(result).items()}
        arrays['series'] = v[:, 2].astype(np.int16)
        arrays['cluster'] = arrays['series'].copy()
        arrays['row_index'] = np.concatenate([np.arange(int((arrays['series'] == sg).sum()), dtype=np.int64)+pos*10000 for sg in range(5)])
        payloads[key] = arrays
        results.append(M.native(np, {k: x for k, x in result.items() if k != 'private_arrays'}))
        catalogues.append(dict(cell=[*key, 'alts'], names=['toy'+str(i) for i in range(5)],
                               file_order=['/synthetic/'+str(i)+'.npz' for i in range(5)],
                               has_boot=False, original_joint_mask=True))
    detail = dict(schema='q26-weighted-causal-primary-pair-detail-v1', cells=results, catalogues=catalogues)
    public = dict(schema='q26-weighted-causal-primary-pair-summary-v1',
                  cells=[{k: x for k, x in r.items() if k != 'folds'} for r in results],
                  calculations_complete=True, scientific_acceptance=False,
                  original_R164_NOT_RUN_unchanged=True, base_forecast_model_fits=0,
                  interpretation='Historical descriptive weighted causal amendment; partial support retained; no power or promotion.')
    return payloads, detail, public


def verify(payloads, detail, public):
    return M.verify_saved(np, payloads, detail, public, kernel=K, original_ranges_raw=RANGES)


class Tests(unittest.TestCase):
    def test_populated_both_cells_and_independent_original_AST(self):
        p, d, s = fixture(); proof = verify(p, d, s)
        self.assertTrue(proof['both_fixed_cells_verified'])
        self.assertTrue(proof['original_reference_independent_AST_endpoints_bins_and_native_metrics_exact'])
        self.assertFalse(proof['raw_shard_membership_independently_reconstructed'])
        self.assertTrue(all(r['native_rows'] > 500 for r in d['cells']))
        self.assertTrue(any(f['arms']['F']['available'] for f in d['cells'][0]['folds']))

    def test_one_endpoint_ulp_tamper_refused(self):
        p, d, s = fixture(); a = p[(24, 5)]['F_lower']; i = int(np.flatnonzero(np.isfinite(a))[0])
        a[i] = np.nextafter(a[i], np.inf)
        with self.assertRaisesRegex(ValueError, 'array bits'):
            verify(p, d, s)

    def test_fold_and_support_tamper_refused(self):
        p, d, s = fixture(); bad = copy.deepcopy(d); bad['cells'][0]['folds'][0]['past_rows'] += 1
        with self.assertRaises(ValueError): verify(p, bad, s)
        bad = copy.deepcopy(s); bad['cells'][1]['views'][0]['pairs']['Rclock']['comparable_rows'] += 1
        with self.assertRaises(ValueError): verify(p, d, bad)

    def test_original_reference_corruption_rejected_independently(self):
        p, d, s = fixture()
        with self.assertRaisesRegex(ValueError, 'original ranges source identity'):
            M.original_reference(np, p[(24, 5)]['p'], p[(24, 5)]['y'], p[(24, 5)]['sg'], p[(24, 5)]['day'], RANGES+b'\n')
        reference = M.original_reference(np, p[(24, 5)]['p'], p[(24, 5)]['y'], p[(24, 5)]['sg'], p[(24, 5)]['day'], RANGES)
        self.assertGreater(reference['metric']['groups'], 0)

    def test_source_key_dtype_order_and_cross_cell_alias_refused(self):
        p, d, s = fixture(); p[(24, 5)]['row_index'][1] = p[(24, 5)]['row_index'][0]
        with self.assertRaises(ValueError): verify(p, d, s)
        p, d, s = fixture(); p[(72, 7)]['row_index'] = p[(24, 5)]['row_index'].copy()
        with self.assertRaisesRegex(ValueError, 'disjoint'): verify(p, d, s)

    def test_production_catalogue_binds_all130_metadata_paths_in_order(self):
        files = ['/invented/shard-%03d.npz' % i for i in range(130)]
        cat = dict(file_order=files.copy(), names=['toy-%03d' % i for i in range(130)])
        detail = dict(catalogues=[copy.deepcopy(cat), copy.deepcopy(cat)])
        M.bind_production_catalogues(detail, files)
        detail['catalogues'][1]['file_order'][0:2] = files[1::-1]
        with self.assertRaisesRegex(ValueError, 'exact accepted file order'):
            M.bind_production_catalogues(detail, files)
        detail = dict(catalogues=[copy.deepcopy(cat), copy.deepcopy(cat)])
        detail['catalogues'][0]['names'].pop()
        with self.assertRaises(ValueError): M.bind_production_catalogues(detail, files)


if __name__ == '__main__':
    unittest.main()
