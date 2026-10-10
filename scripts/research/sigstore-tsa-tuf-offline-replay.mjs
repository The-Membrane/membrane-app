// Offline signature replay of the retained Sigstore TSA TUF candidate. The
// bootstrap pin is selected locally; this does not establish its provenance
// or provide an independent UTC witness for a holder artifact.
import { createHash, X509Certificate } from 'node:crypto'
import { constants as fsConstants, readFileSync, statSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATA_DIR = join(HERE, 'fixtures/sigstore-tuf-candidate')
const DEFAULT_ROTATION_DIR = join(HERE, 'fixtures/sigstore-tuf-roots')
const GLOBAL_TUF_PACKAGE = '/opt/homebrew/lib/node_modules/npm/node_modules/tuf-js/package.json'
const SELECTED_CANDIDATE_SHA256 = '5ae8f58367fc8d81149ffcb6f539cadbb786249081ef543ef41abdac1fe8c541'
const SELECTED_BOOTSTRAP_SHA256 = '5fe1e509a47277183a004745942c0a116379297da9f1cca529774320f1a5dfab'
const SELECTED_TUF_PACKAGE_SHA256 =
  '366dfa94788da0dd695da5b5b8f44c7a3dec71cd892c74a6df61948f37e1c9fc'
const SELECTED_TUF_STORE_SHA256 = 'b62f551bf662d2374d29df046aa6fdb130adfa68e45393006a0fc6a912a7efc1'
const TIMESTAMP_URI = 'https://timestamp.sigstore.dev/api/v1/timestamp'
const TIMESTAMPING_EKU = '1.3.6.1.5.5.7.3.8'
const ROOT_ROTATIONS = Object.freeze([
  {
    version: 13,
    name: '13.root.json',
    sha256: '39277f1fbd482f84d924b6cb77748f62ab0f031b3b5b9b29e681dae056c32250',
  },
  {
    version: 14,
    name: '14.root.json',
    sha256: 'c8c41ec13f06ccabf5b48541ee2550098b4c7b5349e1d180390c29a7d5c2642c',
  },
])
const LIMITS = Object.freeze({
  candidate: 256 * 1024,
  root: 128 * 1024,
  metadata: 128 * 1024,
  target: 128 * 1024,
  packageJson: 16 * 1024,
  store: 32 * 1024,
  certificate: 16 * 1024,
})
const requireFromHere = createRequire(import.meta.url)

function insist(condition, reason) {
  if (!condition) throw new Error(reason)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function boundedBuffer(bytes, limit, label) {
  insist(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= limit, `${label}_size`)
  return bytes
}

function utf8Json(bytes, limit, label) {
  boundedBuffer(bytes, limit, label)
  const json = bytes.toString('utf8')
  insist(Buffer.from(json, 'utf8').equals(bytes), `${label}_utf8`)
  let value
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error(`${label}_json`)
  }
  insist(isRecord(value), `${label}_shape`)
  return value
}

function jsonStringBytes(value, limit, label) {
  insist(typeof value === 'string', `${label}_missing`)
  return boundedBuffer(Buffer.from(value, 'utf8'), limit, label)
}

function metadataBytes(candidate, role) {
  const raw = jsonStringBytes(candidate.tuf?.signedMetadataJson?.[role], LIMITS.metadata, role)
  const parsed = utf8Json(raw, LIMITS.metadata, role)
  const record = candidate.tuf?.metadata?.[role]
  insist(isRecord(record) && isRecord(parsed.signed), `${role}_record`)
  insist(parsed.signed._type === role, `${role}_type`)
  insist(record.version === parsed.signed.version, `${role}_version_record`)
  insist(record.sha256 === sha256(raw), `${role}_digest_record`)
  const expiry = Date.parse(parsed.signed.expires)
  insist(Number.isFinite(expiry), `${role}_expiry_invalid`)
  insist(record.expires === new Date(expiry).toISOString(), `${role}_expiry_record`)
  return raw
}

function canonicalDate(value, label) {
  insist(typeof value === 'string', `${label}_missing`)
  const time = Date.parse(value)
  insist(Number.isFinite(time), `${label}_invalid`)
  return new Date(time).toISOString()
}

function certificateFromTarget(value, index) {
  const encoded = value?.rawBytes
  insist(
    typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),
    `authority_certificate_${index}_base64`,
  )
  const bytes = Buffer.from(encoded, 'base64')
  insist(
    bytes.length > 0 && bytes.length <= LIMITS.certificate && bytes.toString('base64') === encoded,
    `authority_certificate_${index}_bytes`,
  )
  return new X509Certificate(bytes)
}

function certificateSummary(certificate, role) {
  return {
    role,
    derBase64: certificate.raw.toString('base64'),
    sha256: sha256(certificate.raw),
    subject: certificate.subject,
    issuer: certificate.issuer,
    validFrom: canonicalDate(certificate.validFrom, 'certificate_valid_from'),
    validTo: canonicalDate(certificate.validTo, 'certificate_valid_to'),
  }
}

function authorityFromVerifiedTarget(target, clock) {
  const authorities = target.timestampAuthorities
  insist(Array.isArray(authorities) && authorities.length === 1, 'target_authority_count')
  const authority = authorities[0]
  insist(isRecord(authority), 'target_authority_shape')
  insist(authority.uri === TIMESTAMP_URI, 'target_authority_uri')
  insist(
    isRecord(authority.subject) &&
      authority.subject.organization === 'sigstore.dev' &&
      authority.subject.commonName === 'sigstore-tsa-selfsigned',
    'target_authority_subject',
  )
  const chain = authority.certChain?.certificates
  insist(Array.isArray(chain) && chain.length >= 2 && chain.length <= 4, 'target_authority_chain')
  const certificates = chain.map(certificateFromTarget)
  for (let index = 0; index < certificates.length - 1; index += 1) {
    const child = certificates[index]
    const issuer = certificates[index + 1]
    insist(child.checkIssued(issuer) && child.verify(issuer.publicKey), 'authority_chain_invalid')
  }
  const leaf = certificates[0]
  const root = certificates.at(-1)
  insist(root.ca && root.checkIssued(root) && root.verify(root.publicKey), 'authority_root_invalid')
  insist(!leaf.ca, 'authority_leaf_is_ca')
  insist(
    Array.isArray(leaf.keyUsage) && leaf.keyUsage.includes(TIMESTAMPING_EKU),
    'authority_leaf_not_timestamping',
  )
  for (const issuer of certificates.slice(1)) insist(issuer.ca, 'authority_issuer_not_ca')
  for (const certificate of certificates) {
    insist(
      Date.parse(certificate.validFrom) <= clock.getTime() &&
        clock.getTime() < Date.parse(certificate.validTo),
      'authority_certificate_expired',
    )
  }
  insist(isRecord(authority.validFor), 'target_authority_valid_for')
  const start = canonicalDate(authority.validFor.start, 'authority_start')
  const end =
    authority.validFor.end === undefined
      ? null
      : canonicalDate(authority.validFor.end, 'authority_end')
  insist(Date.parse(start) <= clock.getTime(), 'authority_not_yet_valid')
  insist(end === null || clock.getTime() < Date.parse(end), 'authority_expired')
  const summarized = certificates.map((certificate, index) =>
    certificateSummary(
      certificate,
      index === 0 ? 'leaf' : index === certificates.length - 1 ? 'root' : 'intermediate',
    ),
  )
  return {
    uri: authority.uri,
    subject: authority.subject,
    validFor: { start, end },
    leaf: summarized[0],
    intermediates: summarized.slice(1, -1),
    root: summarized.at(-1),
  }
}

function loadTrustedStore() {
  let packagePath
  try {
    packagePath = requireFromHere.resolve('tuf-js/package.json')
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    packagePath = GLOBAL_TUF_PACKAGE
  }
  insist(statSync(packagePath).size <= LIMITS.packageJson, 'tuf_package_size')
  const packageBytes = readFileSync(packagePath)
  const packageInfo = utf8Json(packageBytes, LIMITS.packageJson, 'tuf_package')
  insist(packageInfo.name === 'tuf-js' && packageInfo.version === '3.0.1', 'tuf_library_version')
  insist(sha256(packageBytes) === SELECTED_TUF_PACKAGE_SHA256, 'tuf_package_digest')
  const storeBytes = readFileSync(join(dirname(packagePath), 'dist/store.js'))
  boundedBuffer(storeBytes, LIMITS.store, 'tuf_store')
  insist(sha256(storeBytes) === SELECTED_TUF_STORE_SHA256, 'tuf_store_digest')
  const { TrustedMetadataStore } = createRequire(packagePath)('./dist/store.js')
  insist(typeof TrustedMetadataStore === 'function', 'tuf_library_missing_store')
  return {
    TrustedMetadataStore,
    version: packageInfo.version,
    packageJsonSha256: sha256(packageBytes),
    storeSha256: sha256(storeBytes),
  }
}

export async function replaySigstoreTufCandidate({
  candidateBytes,
  root13Bytes,
  root14Bytes,
  now = new Date(),
}) {
  const clock = now instanceof Date ? now : new Date(now)
  insist(Number.isFinite(clock.getTime()), 'verification_clock_invalid')
  const candidate = utf8Json(candidateBytes, LIMITS.candidate, 'candidate')
  insist(candidate.schema === 'sigstore-tsa-trust-snapshot-v1', 'candidate_schema')
  insist(candidate.status === 'candidate_local_tuf_client_result', 'candidate_status')
  insist(candidate.offlineTufReplay === false, 'candidate_replay_claim')
  insist(candidate.rootProvenanceGateSatisfied === false, 'candidate_root_claim')
  insist(candidate.source?.mirror === 'https://tuf-repo-cdn.sigstore.dev', 'candidate_mirror')
  insist(candidate.source?.bootstrap === 'package_bundled_production_root', 'candidate_bootstrap')

  const seed = jsonStringBytes(candidate.tuf?.bootstrap?.seedRootJson, LIMITS.root, 'seed_root')
  insist(sha256(seed) === SELECTED_BOOTSTRAP_SHA256, 'bootstrap_pin_mismatch')
  insist(candidate.tuf.bootstrap.seedRootSha256 === SELECTED_BOOTSTRAP_SHA256, 'bootstrap_record')
  insist(
    candidate.source?.tufClient?.seedRootSha256 === SELECTED_BOOTSTRAP_SHA256,
    'source_seed_record',
  )
  insist(utf8Json(seed, LIMITS.root, 'seed_root').signed?.version === 12, 'seed_root_version')

  const rotations = [root13Bytes, root14Bytes]
  for (const [index, rotation] of ROOT_ROTATIONS.entries()) {
    const bytes = boundedBuffer(rotations[index], LIMITS.root, `root_${rotation.version}`)
    insist(sha256(bytes) === rotation.sha256, `root_${rotation.version}_digest`)
    insist(
      utf8Json(bytes, LIMITS.root, `root_${rotation.version}`).signed?.version === rotation.version,
      `root_${rotation.version}_version`,
    )
  }

  const finalRoot = metadataBytes(candidate, 'root')
  insist(utf8Json(finalRoot, LIMITS.root, 'root_15').signed.version === 15, 'final_root_version')
  const timestamp = metadataBytes(candidate, 'timestamp')
  const snapshot = metadataBytes(candidate, 'snapshot')
  const targets = metadataBytes(candidate, 'targets')
  const target = jsonStringBytes(candidate.trustedRootJson, LIMITS.target, 'trusted_root_target')
  const rawTarget = utf8Json(target, LIMITS.target, 'trusted_root_target')
  insist(
    rawTarget.mediaType === 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
    'target_media_type',
  )
  insist(candidate.tuf?.target?.name === 'trusted_root.json', 'target_name')
  insist(candidate.tuf.target.length === target.length, 'target_length_record')
  insist(candidate.tuf.target.sha256 === sha256(target), 'target_digest_record')
  insist(
    candidate.tuf.target.targetsMetadataVersion === candidate.tuf.metadata.targets.version,
    'target_metadata_version_record',
  )
  insist(
    candidate.tuf.target.targetsMetadataExpires === candidate.tuf.metadata.targets.expires,
    'target_metadata_expiry_record',
  )
  insist(
    JSON.stringify(candidate.trustedRoot) === JSON.stringify(rawTarget),
    'parsed_target_record',
  )

  const library = loadTrustedStore()
  const store = new library.TrustedMetadataStore(seed)
  store.referenceTime = clock
  for (const bytes of rotations) store.updateRoot(bytes)
  store.updateRoot(finalRoot)
  store.updateTimestamp(timestamp)
  store.updateSnapshot(snapshot, false)
  store.updateDelegatedTargets(targets, 'targets', 'root')
  const targetInfo = store.targets?.signed.targets?.['trusted_root.json']
  insist(targetInfo && targetInfo.hashes?.sha256, 'signed_target_sha256_missing')
  await targetInfo.verify(Readable.from([target]))
  insist(targetInfo.hashes.sha256 === sha256(target), 'signed_target_digest')
  const authority = authorityFromVerifiedTarget(rawTarget, clock)
  insist(
    isDeepStrictEqual(candidate.timestampAuthority, authority),
    'candidate_authority_differs_from_verified_target',
  )

  return {
    schema: 'sigstore-tsa-tuf-offline-replay-v1',
    status: 'locally_verified_under_selected_bootstrap_pin',
    rootProvenanceGateSatisfied: false,
    independentUtcWitness: false,
    portableVerifier: false,
    validationTimeUtc: clock.toISOString(),
    validationClockBasis: 'untrusted_local_or_caller_supplied',
    selectedBootstrapRootSha256: SELECTED_BOOTSTRAP_SHA256,
    rotatedRootVersions: [13, 14, 15],
    signedMetadataVersions: {
      timestamp: store.timestamp.signed.version,
      snapshot: store.snapshot.signed.version,
      targets: store.targets.signed.version,
    },
    trustedRootTargetSha256: sha256(target),
    trustedRootTargetLength: target.length,
    timestampAuthority: {
      uri: authority.uri,
      subject: authority.subject,
      validFor: authority.validFor,
      leafSha256: authority.leaf.sha256,
      rootSha256: authority.root.sha256,
    },
    tufLibrary: {
      name: 'tuf-js',
      version: library.version,
      packageJsonSha256: library.packageJsonSha256,
      storeSha256: library.storeSha256,
      source: 'host_npm_bundle_or_matching_local_package',
    },
  }
}

async function readBoundedFile(path, limit, label) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    insist(stat.isFile() && stat.size > 0 && stat.size <= limit, `${label}_size`)
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    insist(offset === stat.size, `${label}_changed_during_read`)
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

export async function replayRetainedSigstoreTufCandidate(
  dataDir = DEFAULT_DATA_DIR,
  rotationDir = DEFAULT_ROTATION_DIR,
  now = new Date(),
) {
  const directory = await realpath(dataDir)
  const rotationsDirectory = await realpath(rotationDir)
  const [candidateBytes, root13Bytes, root14Bytes] = await Promise.all([
    readBoundedFile(join(directory, 'candidate.json'), LIMITS.candidate, 'candidate'),
    readBoundedFile(join(rotationsDirectory, '13.root.json'), LIMITS.root, 'root_13'),
    readBoundedFile(join(rotationsDirectory, '14.root.json'), LIMITS.root, 'root_14'),
  ])
  insist(sha256(candidateBytes) === SELECTED_CANDIDATE_SHA256, 'retained_candidate_digest')
  return replaySigstoreTufCandidate({ candidateBytes, root13Bytes, root14Bytes, now })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await replayRetainedSigstoreTufCandidate()))
  } catch (error) {
    console.error(`sigstore TSA TUF offline replay failed: ${error.message}`)
    process.exitCode = 1
  }
}
