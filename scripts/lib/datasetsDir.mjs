// datasetsDir.mjs — where research builders read and write their data.
//
// Board rule N18 (owner, 2026-10-11): every dataset we fetch, build or collect lives in the
// private repo triccs/membrane-datasets, not in this public repo. Clone it next to this repo
// (../membrane-datasets) or point MEMBRANE_DATASETS_DIR at the clone. This repo keeps code,
// small test fixtures, aggregate results a doc cites, and copies of files a live page serves.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Absolute path of the datasets clone. Throws with the fix when it is missing. */
export function datasetsDir(root = process.cwd()) {
  const dir = resolve(process.env.MEMBRANE_DATASETS_DIR ?? join(root, '..', 'membrane-datasets'))
  if (!existsSync(dir)) {
    throw new Error(
      `membrane-datasets not found at ${dir}. Clone triccs/membrane-datasets next to this repo ` +
        'or set MEMBRANE_DATASETS_DIR (agent board rule N18).',
    )
  }
  return dir
}

/** Path of one dataset directory (or a file inside it) in the datasets clone. */
export function datasetPath(root, ...parts) {
  return join(datasetsDir(root), ...parts)
}
