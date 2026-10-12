/**
 * Where the curator-feed dataset lives on disk. Server-only (collector, API route, tests).
 *
 *   live    .data/curator-feed (app root)   the collector's working copy, git-ignored; every
 *                                           run writes it, the hourly tick keeps it current
 *   seed    <datasets>/curator-feed         the canonical copy in the PRIVATE repo
 *                                           triccs/membrane-datasets (board rule N18: data
 *                                           we collect does not go in a public repo);
 *                                           `--publish` writes it with its PROVENANCE.md
 *
 * <datasets> = MEMBRANE_DATASETS_DIR, else ../membrane-datasets next to the app.
 */

import { join, resolve } from 'path'

import { LIVE_DIR } from './store'

export const DATASET = 'curator-feed'

export const liveDir = (): string => join(process.cwd(), LIVE_DIR)

export const datasetsRoot = (): string =>
  resolve(process.env.MEMBRANE_DATASETS_DIR || join(process.cwd(), '..', 'membrane-datasets'))

export const seedDir = (): string => join(datasetsRoot(), DATASET)
