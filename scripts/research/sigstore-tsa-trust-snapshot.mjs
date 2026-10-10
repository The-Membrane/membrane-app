// Explicit capture of public Sigstore TSA trust material. The output records
// a local TUF-client result; it is not a standalone TUF proof, does not pass a
// root-provenance gate, and never witnesses an independent UTC clock.
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRODUCTION_MIRROR = 'https://tuf-repo-cdn.sigstore.dev'
const TARGET_NAME = 'trusted_root.json'
const CACHE_PREFIX = '/private/tmp/sigstore-tsa-tuf-'
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PROJECT_MODULES = join(PROJECT_ROOT, 'node_modules') + sep
const GLOBAL_TUF_PACKAGE_JSON =
  '/opt/homebrew/lib/node_modules/npm/node_modules/@sigstore/tuf/package.json'
const PINNED_TUF_VERSION = '3.1.1'
const TIMESTAMPING_EKU = '1.3.6.1.5.5.7.3.8'
const requireFromHere = createRequire(import.meta.url)
const DEFAULT_OUTPUT = resolve(
  PROJECT_ROOT,
  'data/research/venue-signals/sigstore-tsa-trust-v1/candidate.json',
)
const LIMITS = Object.freeze({
  cacheFiles: 32,
  cacheBytes: 4 * 1024 * 1024,
  cacheFileBytes: 1024 * 1024,
  snapshotBytes: 256 * 1024,
  certificates: 4,
  certificateBytes: 16 * 1024,
})

function requireTrue(condition, reason) {
  if (!condition) throw new Error(reason)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedJson(bytes, label) {
  requireTrue(bytes.length > 0 && bytes.length <= LIMITS.cacheFileBytes, `${label}_size`)
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    requireTrue(isRecord(value), `${label}_shape`)
    return value
  } catch {
    throw new Error(`${label}_json`)
  }
}

function exactUtf8(bytes, label) {
  const value = bytes.toString('utf8')
  requireTrue(Buffer.from(value, 'utf8').equals(bytes), `${label}_utf8`)
  return value
}

// Resolve without a package install. The only fallback is the audited package
// bundled by this Mac's npm. A moved, replaced, or upgraded copy needs review.
export async function resolveDefaultTufClient() {
  let packageJsonPath
  let source = 'project_node_modules'
  try {
    packageJsonPath = requireFromHere.resolve('@sigstore/tuf/package.json')
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    packageJsonPath = GLOBAL_TUF_PACKAGE_JSON
    source = 'npm_bundled_global'
  }
  const packageRealPath = await realpath(packageJsonPath)
  requireTrue(
    source === 'npm_bundled_global'
      ? packageRealPath === GLOBAL_TUF_PACKAGE_JSON
      : packageRealPath.startsWith(PROJECT_MODULES),
    'unexpected_tuf_package_path',
  )
  const packageBytes = await readFile(packageRealPath)
  requireTrue(packageBytes.length <= 16 * 1024, 'tuf_package_size')
  const packageInfo = boundedJson(packageBytes, 'tuf_package')
  requireTrue(
    packageInfo.name === '@sigstore/tuf' &&
      packageInfo.version === PINNED_TUF_VERSION &&
      packageInfo.main === 'dist/index.js',
    'unexpected_tuf_package_version_or_entry',
  )
  const packageDirectory = dirname(packageRealPath)
  const entryPath = await realpath(join(packageDirectory, packageInfo.main))
  const seedPath = await realpath(join(packageDirectory, 'seeds.json'))
  requireTrue(
    entryPath === join(packageDirectory, 'dist/index.js') &&
      seedPath === join(packageDirectory, 'seeds.json'),
    'unexpected_tuf_package_contents_path',
  )
  const seedBytes = await readFile(seedPath)
  const entryBytes = await readFile(entryPath)
  requireTrue(seedBytes.length <= 64 * 1024, 'tuf_seeds_size')
  requireTrue(entryBytes.length <= 128 * 1024, 'tuf_entry_size')
  const seeds = boundedJson(seedBytes, 'tuf_seeds')
  const encodedRoot = seeds[PRODUCTION_MIRROR]?.['root.json']
  requireTrue(
    typeof encodedRoot === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(encodedRoot),
    'production_seed_missing',
  )
  const seedRootBytes = Buffer.from(encodedRoot, 'base64')
  requireTrue(
    seedRootBytes.length <= LIMITS.cacheFileBytes &&
      seedRootBytes.toString('base64') === encodedRoot,
    'production_seed_invalid',
  )
  const seedRootJson = exactUtf8(seedRootBytes, 'production_seed')
  requireTrue(
    boundedJson(seedRootBytes, 'production_seed').signed?._type === 'root',
    'production_seed_root',
  )
  const client = requireFromHere(entryPath)
  requireTrue(
    typeof client.getTrustedRoot === 'function' && client.DEFAULT_MIRROR_URL === PRODUCTION_MIRROR,
    'unexpected_tuf_client',
  )
  return {
    getTrustedRoot: client.getTrustedRoot,
    seedRootJson,
    provenance: {
      name: '@sigstore/tuf',
      version: packageInfo.version,
      source,
      packageLocation: source === 'npm_bundled_global' ? packageDirectory : 'project_node_modules',
      packageJsonSha256: sha256(packageBytes),
      entrySha256: sha256(entryBytes),
      seedsJsonSha256: sha256(seedBytes),
      seedRootSha256: sha256(seedRootBytes),
    },
  }
}

function validDate(value, label) {
  requireTrue(typeof value === 'string', `${label}_missing`)
  const time = Date.parse(value)
  requireTrue(Number.isFinite(time), `${label}_invalid`)
  return new Date(time).toISOString()
}

function validVersion(value, label) {
  requireTrue(Number.isSafeInteger(value) && value >= 1, `${label}_version`)
  return value
}

function metadataSummary(bytes, name, now) {
  const document = boundedJson(bytes, name)
  const signed = document.signed
  requireTrue(isRecord(signed) && signed._type === name, `${name}_type`)
  const expires = validDate(signed.expires, `${name}_expires`)
  requireTrue(Date.parse(expires) > now.getTime(), `${name}_expired`)
  return {
    document,
    rawJson: exactUtf8(bytes, `${name}_metadata`),
    record: {
      version: validVersion(signed.version, name),
      expires,
      sha256: sha256(bytes),
    },
  }
}

function verifyReference(reference, bytes, label) {
  requireTrue(isRecord(reference), `${label}_reference`)
  requireTrue(
    reference.length === undefined || reference.length === bytes.length,
    `${label}_length`,
  )
  if (reference.hashes !== undefined) {
    requireTrue(isRecord(reference.hashes), `${label}_hashes`)
    const expected = reference.hashes.sha256
    requireTrue(typeof expected === 'string' && /^[a-f\d]{64}$/i.test(expected), `${label}_sha256`)
    requireTrue(sha256(bytes) === expected.toLowerCase(), `${label}_hash_mismatch`)
  }
}

function requireBase64(value, label) {
  requireTrue(typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value), `${label}_base64`)
  const bytes = Buffer.from(value, 'base64')
  requireTrue(
    bytes.length > 0 &&
      bytes.length <= LIMITS.certificateBytes &&
      bytes.toString('base64') === value,
    `${label}_base64`,
  )
  return bytes
}

function certificateRecord(rawBytes, role) {
  const certificate = new X509Certificate(rawBytes)
  return {
    role,
    derBase64: rawBytes.toString('base64'),
    sha256: sha256(rawBytes),
    subject: certificate.subject,
    issuer: certificate.issuer,
    validFrom: validDate(certificate.validFrom, 'certificate_valid_from'),
    validTo: validDate(certificate.validTo, 'certificate_valid_to'),
  }
}

function authorityFromRoot(rawRoot, decodedRoot, now) {
  requireTrue(Array.isArray(rawRoot.timestampAuthorities), 'raw_authorities_missing')
  requireTrue(rawRoot.timestampAuthorities.length === 1, 'expected_one_timestamp_authority')
  requireTrue(Array.isArray(decodedRoot?.timestampAuthorities), 'decoded_authorities_missing')
  requireTrue(
    decodedRoot.timestampAuthorities.length === 1,
    'expected_one_decoded_timestamp_authority',
  )

  const raw = rawRoot.timestampAuthorities[0]
  const decoded = decodedRoot.timestampAuthorities[0]
  requireTrue(isRecord(raw) && isRecord(decoded), 'authority_shape')
  requireTrue(
    typeof raw.uri === 'string' &&
      raw.uri === decoded.uri &&
      raw.uri === 'https://timestamp.sigstore.dev/api/v1/timestamp',
    'authority_uri',
  )
  requireTrue(
    isRecord(raw.subject) &&
      raw.subject.organization === decoded.subject?.organization &&
      raw.subject.commonName === decoded.subject?.commonName,
    'authority_subject',
  )

  const rawChain = raw.certChain?.certificates
  const decodedChain = decoded.certChain?.certificates
  requireTrue(
    Array.isArray(rawChain) &&
      Array.isArray(decodedChain) &&
      rawChain.length >= 2 &&
      rawChain.length <= LIMITS.certificates &&
      rawChain.length === decodedChain.length,
    'authority_chain',
  )

  const certificates = rawChain.map((entry, index) => {
    const bytes = requireBase64(entry?.rawBytes, `certificate_${index}`)
    const decodedBytes = decodedChain[index]?.rawBytes
    requireTrue(decodedBytes instanceof Uint8Array, `decoded_certificate_${index}`)
    requireTrue(
      bytes.equals(Buffer.from(decodedBytes)),
      `certificate_${index}_differs_from_tuf_result`,
    )
    return new X509Certificate(bytes)
  })
  for (let index = 0; index < certificates.length - 1; index += 1) {
    const child = certificates[index]
    const issuer = certificates[index + 1]
    requireTrue(
      child.checkIssued(issuer) && child.verify(issuer.publicKey),
      'authority_chain_invalid',
    )
  }
  const root = certificates.at(-1)
  requireTrue(
    root.ca && root.checkIssued(root) && root.verify(root.publicKey),
    'authority_root_invalid',
  )
  requireTrue(!certificates[0].ca, 'authority_leaf_is_ca')
  requireTrue(
    Array.isArray(certificates[0].keyUsage) && certificates[0].keyUsage.includes(TIMESTAMPING_EKU),
    'authority_leaf_not_timestamping',
  )
  for (const issuer of certificates.slice(1)) requireTrue(issuer.ca, 'authority_issuer_not_ca')
  for (const certificate of certificates) {
    requireTrue(
      Date.parse(certificate.validFrom) <= now.getTime() &&
        now.getTime() < Date.parse(certificate.validTo),
      'authority_certificate_expired',
    )
  }

  const validFor = raw.validFor
  requireTrue(isRecord(validFor), 'authority_valid_for')
  const start = validDate(validFor.start, 'authority_start')
  const end = validFor.end === undefined ? null : validDate(validFor.end, 'authority_end')
  requireTrue(Date.parse(start) <= now.getTime(), 'authority_not_yet_valid')
  requireTrue(end === null || now.getTime() < Date.parse(end), 'authority_expired')

  const chain = certificates.map((cert, index) =>
    certificateRecord(
      cert.raw,
      index === 0 ? 'leaf' : index === certificates.length - 1 ? 'root' : 'intermediate',
    ),
  )
  return {
    uri: raw.uri,
    subject: raw.subject,
    validFor: { start, end },
    leaf: chain[0],
    intermediates: chain.slice(1, -1),
    root: chain.at(-1),
  }
}

async function inspectBoundedCache(directory) {
  const pending = [directory]
  let files = 0
  let totalBytes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    for (const name of await readdir(current)) {
      const entry = join(current, name)
      const stat = await lstat(entry)
      requireTrue(!stat.isSymbolicLink(), 'cache_symlink')
      if (stat.isDirectory()) {
        pending.push(entry)
      } else {
        requireTrue(stat.isFile(), 'cache_non_file')
        files += 1
        totalBytes += stat.size
        requireTrue(
          files <= LIMITS.cacheFiles &&
            stat.size <= LIMITS.cacheFileBytes &&
            totalBytes <= LIMITS.cacheBytes,
          'cache_size_limit',
        )
      }
    }
  }
}

async function readCachedFile(repositoryCache, name) {
  const bytes = await readFile(join(repositoryCache, name))
  requireTrue(bytes.length > 0 && bytes.length <= LIMITS.cacheFileBytes, `${name}_size`)
  return bytes
}

function expectedRepositoryCache(cachePath) {
  const url = new URL(PRODUCTION_MIRROR)
  const repoName = encodeURIComponent(url.host + url.pathname.replace(/\/$/, ''))
  return join(cachePath, repoName)
}

export async function captureSigstoreTsaTrustSnapshot({
  loadTuf = resolveDefaultTufClient,
  outputPath = DEFAULT_OUTPUT,
  now = () => new Date(),
} = {}) {
  const observedAt = now()
  requireTrue(
    observedAt instanceof Date && Number.isFinite(observedAt.getTime()),
    'invalid_local_time',
  )
  const cachePath = await mkdtemp(CACHE_PREFIX)
  let temporaryOutput
  try {
    const loadedClient = await loadTuf()
    const { getTrustedRoot } = loadedClient
    requireTrue(typeof getTrustedRoot === 'function', 'tuf_client_missing')
    const defaultClient = loadTuf === resolveDefaultTufClient
    const provenance = defaultClient
      ? loadedClient.provenance
      : { name: 'injected_test_loader', version: null, source: 'injected_loader' }
    requireTrue(isRecord(provenance), 'tuf_client_provenance_missing')
    const decodedRoot = await getTrustedRoot({
      cachePath,
      mirrorURL: PRODUCTION_MIRROR,
      forceCache: false,
      forceInit: true,
      timeout: 10_000,
      retry: { retries: 1 },
    })

    await inspectBoundedCache(cachePath)
    const repositoryCache = expectedRepositoryCache(cachePath)
    const [rootBytes, timestampBytes, snapshotBytes, targetsBytes, targetBytes] = await Promise.all(
      [
        readCachedFile(repositoryCache, 'root.json'),
        readCachedFile(repositoryCache, 'timestamp.json'),
        readCachedFile(repositoryCache, 'snapshot.json'),
        readCachedFile(repositoryCache, 'targets.json'),
        readCachedFile(repositoryCache, join('targets', TARGET_NAME)),
      ],
    )
    const rootMetadata = metadataSummary(rootBytes, 'root', observedAt)
    const timestampMetadata = metadataSummary(timestampBytes, 'timestamp', observedAt)
    const snapshotMetadata = metadataSummary(snapshotBytes, 'snapshot', observedAt)
    const targetsMetadata = metadataSummary(targetsBytes, 'targets', observedAt)

    const snapshotReference = timestampMetadata.document.signed.meta?.['snapshot.json']
    const targetsReference = snapshotMetadata.document.signed.meta?.['targets.json']
    requireTrue(
      snapshotReference?.version === snapshotMetadata.record.version &&
        targetsReference?.version === targetsMetadata.record.version,
      'metadata_version_mismatch',
    )
    verifyReference(snapshotReference, snapshotBytes, 'snapshot')
    verifyReference(targetsReference, targetsBytes, 'targets')

    const targetReference = targetsMetadata.document.signed.targets?.[TARGET_NAME]
    requireTrue(isRecord(targetReference), 'target_missing')
    verifyReference(targetReference, targetBytes, 'target')
    requireTrue(typeof targetReference.hashes?.sha256 === 'string', 'target_sha256_missing')
    const trustedRootJson = exactUtf8(targetBytes, 'trusted_root')
    const rawRoot = boundedJson(targetBytes, 'trusted_root')
    requireTrue(
      rawRoot.mediaType === 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
      'trusted_root_media_type',
    )
    const authority = authorityFromRoot(rawRoot, decodedRoot, observedAt)

    const candidate = {
      schema: 'sigstore-tsa-trust-snapshot-v1',
      status: 'candidate_local_tuf_client_result',
      offlineTufReplay: false,
      rootProvenanceGateSatisfied: false,
      localObservedAt: observedAt.toISOString(),
      source: {
        tufClient: provenance,
        mirror: PRODUCTION_MIRROR,
        bootstrap: defaultClient ? 'package_bundled_production_root' : 'injected_test_loader',
      },
      tuf: {
        bootstrap: defaultClient
          ? {
              seedRootSha256: provenance.seedRootSha256,
              seedRootJson: loadedClient.seedRootJson,
            }
          : null,
        target: {
          name: TARGET_NAME,
          length: targetBytes.length,
          sha256: sha256(targetBytes),
          targetsMetadataVersion: targetsMetadata.record.version,
          targetsMetadataExpires: targetsMetadata.record.expires,
        },
        metadata: {
          root: rootMetadata.record,
          timestamp: timestampMetadata.record,
          snapshot: snapshotMetadata.record,
          targets: targetsMetadata.record,
        },
        signedMetadataJson: {
          root: rootMetadata.rawJson,
          timestamp: timestampMetadata.rawJson,
          snapshot: snapshotMetadata.rawJson,
          targets: targetsMetadata.rawJson,
        },
      },
      timestampAuthority: authority,
      trustedRootJson,
      trustedRoot: rawRoot,
    }
    const outputBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8')
    requireTrue(outputBytes.length <= LIMITS.snapshotBytes, 'candidate_size_limit')
    const outputDirectory = dirname(outputPath)
    await mkdir(outputDirectory, { recursive: true })
    const outputDirectoryStat = await lstat(outputDirectory)
    requireTrue(
      outputDirectoryStat.isDirectory() && !outputDirectoryStat.isSymbolicLink(),
      'output_directory',
    )
    temporaryOutput = join(outputDirectory, `.candidate-${process.pid}-${randomUUID()}.tmp`)
    await writeFile(temporaryOutput, outputBytes, { flag: 'wx', mode: 0o644 })
    await rename(temporaryOutput, outputPath)
    temporaryOutput = undefined
    return { outputPath, candidate }
  } finally {
    if (temporaryOutput) await rm(temporaryOutput, { force: true })
    await rm(cachePath, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--capture') {
    console.error('Usage: node scripts/research/sigstore-tsa-trust-snapshot.mjs --capture')
    process.exitCode = 2
  } else {
    try {
      const { outputPath } = await captureSigstoreTsaTrustSnapshot()
      console.log(`candidate local TUF-client result: ${outputPath}`)
    } catch (error) {
      console.error(`candidate capture failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}
