// Outcome-blind control collection staging ledger. This version performs NO live RPC.
// It preserves the full 304-anchor denominator and imports only the sealed corrected
// first-anchor controls; screening and continuation pages remain explicit unsupported work.
// Dry: node scripts/research/morpho-v2-full-cohort-controls-v2.mjs
// Bounded local checkpoint: node scripts/research/morpho-v2-full-cohort-controls-v2.mjs --run true --max-anchors 32
// Offline: node scripts/research/morpho-v2-full-cohort-controls-v2.mjs --verify true
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardDisk, MANIFEST_SHA } from './morpho-v2-full-cohort-controls.mjs'
import {
  loadFrozen as loadFirstAnchor,
  verify as verifyFirstAnchor,
} from './morpho-v2-first-anchor-controls-v2.mjs'

export const STUDY = 'morpho-v2-full-cohort-controls-stage-v2'
export const DENOMINATOR = 304
export const SIGNER_FIRST64_SHA = '9bf2a8705910c65eae377a2f63eec73dd6a82f907d9ec1ccee7ead015dcc754e'
export const FIRST_ANCHOR_SHA = '49cb3d86dbb6106998715a44b359575a9952a510b33f49fffa784d928b773914'
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const SHA = /^[\da-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const unsigned = ({ checkpointSha256, ...rest }) => rest
const seal = (value) => ({
  ...unsigned(value),
  checkpointSha256: sha(JSON.stringify(unsigned(value))),
})

function pinned(path, expected) {
  if (!SHA.test(expected)) throw new Error('Missing source physical SHA')
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned source physical SHA mismatch')
  return JSON.parse(bytes)
}

export function loadFrozen(base = resolve('data/research/venue-signals')) {
  const manifest = pinned(resolve(base, 'morpho-v2-full-cohort-manifest.json'), MANIFEST_SHA)
  const signer = pinned(resolve(base, 'morpho-v2-signer-baseline-v2.json'), SIGNER_FIRST64_SHA)
  const firstAnchor = pinned(
    resolve(base, 'morpho-v2-first-anchor-controls-v2.json'),
    FIRST_ANCHOR_SHA,
  )
  const firstFrozen = loadFirstAnchor({
    manifestPath: resolve(base, 'morpho-v2-full-cohort-manifest.json'),
    factoryPath: resolve(
      base,
      '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa.json',
    ),
    treatedPath: resolve(base, 'morpho-v2-full-cohort-baseline.json'),
    controlPath: resolve(base, 'morpho-v2-full-cohort-controls.json'),
  })
  verifyFirstAnchor(firstAnchor, firstFrozen)
  if (
    manifest.study !== 'morpho-v2-full-cohort-manifest-v1' ||
    manifest.status !== 'complete' ||
    manifest.rows?.length !== DENOMINATOR ||
    manifest.controlPageSize !== 32 ||
    signer.study !== 'morpho-v2-full-cohort-signer-baseline-v2' ||
    signer.status !== 'complete-first64-preoutcome' ||
    signer.manifestSha256 !== MANIFEST_SHA ||
    signer.rows?.length !== 64 ||
    signer.checkpointSha256 !== sha(JSON.stringify(unsigned(signer))) ||
    firstAnchor.denominator !== DENOMINATOR ||
    firstAnchor.screened.length !== 4 ||
    firstAnchor.selected.length !== 2
  )
    throw new Error('Frozen stage source metadata mismatch')
  for (let i = 0; i < signer.rows.length; i++) {
    const treated = signer.rows[i],
      row = manifest.rows[i]
    if (
      treated.index !== i ||
      treated.proposalIndex !== row.proposalIndex ||
      treated.vault !== row.vault ||
      treated.anchorBlock !== row.anchorBlock ||
      treated.preBlock !== row.anchorBlock - 1
    )
      throw new Error('Frozen treated/manifest linkage mismatch')
  }
  if (
    signer.rows[0].status !== 'baseline-success' ||
    signer.rows[0].qAssets !== firstFrozen.anchor.baseline.qAssets ||
    firstAnchor.selected.some((x) => x.status !== 'baseline-success')
  )
    throw new Error('First-anchor corrected source mismatch')
  return { manifest, signer, firstAnchor }
}

export function planRow(frozen, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= DENOMINATOR)
    throw new Error('Invalid anchor index')
  const source = frozen.manifest.rows[index]
  const controls = source.controls
  const firstPage = controls.firstCleanCandidates
  if (
    !Array.isArray(firstPage) ||
    firstPage.length !== Math.min(32, controls.counts.clean) ||
    controls.nextCleanOffset !== (controls.counts.clean > 32 ? 32 : null) ||
    new Set(firstPage.map((x) => x.vault)).size !== firstPage.length ||
    firstPage.some(
      (x) =>
        x.vault === source.vault ||
        x.creationBlock >= source.anchorBlock ||
        x.creationTimestamp >= source.anchorTimestamp ||
        x.ageSeconds !== source.anchorTimestamp - x.creationTimestamp,
    )
  )
    throw new Error('Frozen candidate page mismatch')
  const treated = frozen.signer.rows[index] ?? null
  const noCleanCandidates = controls.counts.clean === 0
  const requiresContinuationPage = controls.nextCleanOffset !== null
  const disposition =
    index === 0
      ? 'first-anchor-control-baseline-complete'
      : noCleanCandidates
        ? 'no-clean-control-candidates'
        : treated === null
          ? 'treated-baseline-not-in-sealed-source'
          : treated.status !== 'baseline-success'
            ? 'treated-baseline-unavailable'
            : requiresContinuationPage
              ? 'unsupported-screening-and-continuation'
              : 'unsupported-control-screening'
  return {
    index,
    proposalIndex: source.proposalIndex,
    vault: source.vault,
    asset: source.asset,
    anchorBlock: source.anchorBlock,
    anchorBlockHash: source.anchorBlockHash,
    treatedStatus: treated?.status ?? 'not-in-sealed-source',
    qAssets: treated?.qAssets ?? null,
    cleanCandidates: controls.counts.clean,
    noCleanCandidates,
    requiresContinuationPage,
    treatedInSealedSource: treated !== null,
    firstPageCandidates: firstPage.map((x) => x.vault),
    nextCleanOffset: controls.nextCleanOffset,
    screened: index === 0 ? frozen.firstAnchor.screened : [],
    selected: index === 0 ? frozen.firstAnchor.selected : [],
    disposition,
  }
}

export function verifyCheckpoint(saved, frozen) {
  if (
    !saved ||
    !Array.isArray(saved.rows) ||
    saved.rows.length > DENOMINATOR ||
    saved?.checkpointSha256 !== sha(JSON.stringify(unsigned(saved))) ||
    saved.study !== STUDY ||
    saved.status !==
      (saved.rows.length === DENOMINATOR ? 'plan-complete-controls-partial' : 'plan-partial') ||
    saved.denominator !== DENOMINATOR ||
    saved.manifestPhysicalSha256 !== MANIFEST_SHA ||
    saved.signerFirst64PhysicalSha256 !== SIGNER_FIRST64_SHA ||
    saved.firstAnchorPhysicalSha256 !== FIRST_ANCHOR_SHA ||
    saved.prospective !== false ||
    saved.liveRpcUsed !== false
  )
    throw new Error('Control-v2 stage checkpoint metadata mismatch')
  for (let i = 0; i < saved.rows.length; i++)
    if (JSON.stringify(saved.rows[i]) !== JSON.stringify(planRow(frozen, i)))
      throw new Error('Control-v2 stage row mismatch')
  return saved
}

function save(out, checkpoint, stat) {
  const bytes = JSON.stringify(seal(checkpoint))
  if (Buffer.byteLength(bytes) > MAX_OUTPUT_BYTES) throw new Error('Control-v2 stage output cap')
  mkdirSync(dirname(out), { recursive: true })
  guardDisk(out, Buffer.byteLength(bytes), stat)
  const temp = `${out}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, out)
  return JSON.parse(bytes)
}

export function run({ frozen, out, maxAnchors = 32, stat = statfsSync }) {
  if (!Number.isSafeInteger(maxAnchors) || maxAnchors < 1 || maxAnchors > 32)
    throw new Error('Invalid bounded anchor batch')
  mkdirSync(dirname(out), { recursive: true })
  guardDisk(out, 0, stat)
  let saved = existsSync(out)
    ? verifyCheckpoint(JSON.parse(readFileSync(out, 'utf8')), frozen)
    : seal({
        study: STUDY,
        status: 'plan-partial',
        denominator: DENOMINATOR,
        manifestPhysicalSha256: MANIFEST_SHA,
        signerFirst64PhysicalSha256: SIGNER_FIRST64_SHA,
        firstAnchorPhysicalSha256: FIRST_ANCHOR_SHA,
        prospective: false,
        liveRpcUsed: false,
        rows: [],
      })
  const stop = Math.min(DENOMINATOR, saved.rows.length + maxAnchors)
  while (saved.rows.length < stop) {
    const next = [...saved.rows, planRow(frozen, saved.rows.length)]
    saved = save(
      out,
      {
        ...saved,
        status: next.length === DENOMINATOR ? 'plan-complete-controls-partial' : 'plan-partial',
        rows: next,
      },
      stat,
    )
  }
  return verifyCheckpoint(saved, frozen)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (
      args.length % 2 ||
      args.some((x, i) => (i % 2 === 0 ? !['--run', '--verify', '--max-anchors'].includes(x) : !x))
    )
      throw new Error('Invalid options')
    const opts = Object.fromEntries(
      Array.from({ length: args.length / 2 }, (_, i) => args.slice(2 * i, 2 * i + 2)),
    )
    if (
      (opts['--run'] && opts['--run'] !== 'true') ||
      (opts['--verify'] && opts['--verify'] !== 'true') ||
      (opts['--run'] && opts['--verify']) ||
      (opts['--max-anchors'] && !opts['--run'])
    )
      throw new Error('Invalid mode')
    const frozen = loadFrozen()
    const out = resolve('data/research/venue-signals/morpho-v2-full-cohort-controls-stage-v2.json')
    if (opts['--verify']) {
      const saved = verifyCheckpoint(JSON.parse(readFileSync(out, 'utf8')), frozen)
      process.stdout.write(
        JSON.stringify({ mode: 'verify', staged: saved.rows.length, measuredAnchors: 1 }) + '\n',
      )
    } else if (opts['--run']) {
      const saved = run({
        frozen,
        out,
        maxAnchors: opts['--max-anchors'] === undefined ? 32 : Number(opts['--max-anchors']),
      })
      process.stdout.write(
        JSON.stringify({
          mode: 'run',
          staged: saved.rows.length,
          measuredAnchors: 1,
          liveRpcUsed: false,
        }) + '\n',
      )
    } else {
      process.stdout.write(
        JSON.stringify({
          mode: 'dry',
          denominator: DENOMINATOR,
          measuredAnchors: 1,
          staged: existsSync(out)
            ? verifyCheckpoint(JSON.parse(readFileSync(out, 'utf8')), frozen).rows.length
            : 0,
          liveRpcUsed: false,
        }) + '\n',
      )
    }
  } catch {
    // Never disclose credential-bearing provider errors or local absolute paths.
    process.stderr.write(
      'Control-v2 stage stopped; check pinned sources, checkpoint, or resources.\n',
    )
    process.exitCode = 1
  }
}
