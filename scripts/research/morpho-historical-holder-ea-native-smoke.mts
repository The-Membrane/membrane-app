import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, statfsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { configuredProviders, readProviderPolicy } from './carry-depth-quote-archive.mjs'
import { createMorphoHistoricalHolderEaCaptureControl } from './morpho-historical-holder-ea-capture-control.mjs'
import * as historicalEaModule from '../../lib/carry/morphoV2HistoricalHolderEaEvidence'
import type { MorphoV2HistoricalHolderEaCurrentSource } from '../../lib/carry/morphoV2HistoricalHolderEaEvidence'
import * as historicalReaderModule from '../../lib/carry/morphoV2HistoricalHolderEaReader.server'
import * as trustedProfilesModule from '../../lib/carry/morphoV2TrustedProfiles'
// tsx exposes app modules through a CJS default in an ESM research entrypoint.
const historicalEa =
  (historicalEaModule as { default?: typeof historicalEaModule }).default ?? historicalEaModule
const historicalReader =
  (historicalReaderModule as { default?: typeof historicalReaderModule }).default ??
  historicalReaderModule
const trustedProfiles =
  (trustedProfilesModule as { default?: typeof trustedProfilesModule }).default ??
  trustedProfilesModule
const {
  approveMorphoV2HistoricalHolderEaEvidence,
  decodeMorphoV2HistoricalHolderEaUint,
  morphoV2HistoricalHolderEaCalldata,
} = historicalEa
const { readMorphoV2HistoricalHolderEaOrigin } = historicalReader
const { resolveMorphoV2TrustedProfile } = trustedProfiles

/** One bounded native acquisition. Hypothetical S does not claim wallet ownership. */
const output = resolve(process.argv[2] ?? '')
if (process.argv.length !== 3 || !output.startsWith('/private/tmp/'))
  throw Error('output_path_required')
const free = statfsSync('/System/Volumes/Data')
if (free.bavail * free.bsize < 256 * 1024 * 1024) throw Error('disk_reserve')
mkdirSync(output, { mode: 0o700 })
const started = Date.now()
const control = createMorphoHistoricalHolderEaCaptureControl()
const activeWindows = new Map<string, object>()
const providers = configuredProviders(null, readProviderPolicy()).filter((p: { host: string }) =>
  ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].includes(p.host),
)
if (providers.length !== 2 || new Set(providers.map((p: { host: string }) => p.host)).size !== 2)
  throw Error('configured_pair_missing')
const clients = providers.map((provider: { url: string; host: string }) => {
  return {
    host: provider.host,
    request: (wire: { method: string; params: unknown[] }) =>
      control.request(
        provider.host,
        wire,
        (params: typeof wire, timeoutMs: number) => {
          const native = createPublicClient({
            chain: mainnet,
            transport: http(provider.url, { timeout: timeoutMs, retryCount: 0 }),
          })
          return native.request(params as never)
        },
        activeWindows.get(provider.host),
      ),
  }
})
const seal = (name: string, value: Record<string, unknown>) => {
  const text = JSON.stringify(value),
    bodySha256 = createHash('sha256').update(text).digest('hex')
  const bytes = JSON.stringify({ ...value, bodySha256 }) + '\n'
  const fd = openSync(resolve(output, name), 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return {
    path: name,
    bytes: Buffer.byteLength(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bodySha256,
  }
}
const results: unknown[] = []
let status = 'failed'
try {
  const finalized = []
  for (const client of clients) {
    if ((await client.request({ method: 'eth_chainId', params: [] })) !== '0x1')
      throw Error('wrong_chain')
    const header = (await client.request({
      method: 'eth_getBlockByNumber',
      params: ['finalized', false],
    })) as { number: string }
    finalized.push(Number(BigInt(header.number)))
  }
  const height = Math.min(...finalized),
    headers = []
  for (const client of clients)
    headers.push(
      (await client.request({
        method: 'eth_getBlockByNumber',
        params: [`0x${height.toString(16)}`, false],
      })) as { number: string; hash: `0x${string}`; timestamp: string },
    )
  if (
    headers.some(
      (h) =>
        Number(BigInt(h.number)) !== height ||
        h.hash !== headers[0].hash ||
        h.timestamp !== headers[0].timestamp,
    )
  )
    throw Error('header_disagreement')
  const currentSource: MorphoV2HistoricalHolderEaCurrentSource = {
    chainId: 1,
    blockNumber: height,
    blockHash: headers[0].hash,
    blockTime: new Date(Number(BigInt(headers[0].timestamp)) * 1000).toISOString(),
    finalized: true,
  }
  for (const [asset, route, destination, token] of [
    [
      'USDC',
      'USDC → VaultV2 [USDC]',
      '0x0026038a7fefef439d94bd99b4a10017e839d3a7',
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    ],
    [
      'USDT',
      'USDT → VaultV2 [USDT]',
      '0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11',
      '0xdac17f958d2ee523a2206206994597c13d831ec7',
    ],
  ]) {
    const profile = resolveMorphoV2TrustedProfile(route, destination, token)
    if (!profile) throw Error('trusted_profile_missing')
    const sharesRaw = '1000000000000000000000',
      origins = [],
      currentEa = []
    for (const client of clients) {
      const window = control.openWindow()
      activeWindows.set(client.host, window)
      let observation
      try {
        observation = await readMorphoV2HistoricalHolderEaOrigin(client, currentSource, {
          profile,
          sharesRaw,
          deadlineMs: 12000,
        })
      } finally {
        control.closeWindow(window)
        activeWindows.delete(client.host)
      }
      if (!observation) throw Error('historical_origin_unavailable')
      origins.push({ host: client.host, observation })
      const raw = await client.request({
        method: 'eth_call',
        params: [
          { to: destination, data: morphoV2HistoricalHolderEaCalldata(sharesRaw) },
          { blockHash: currentSource.blockHash, requireCanonical: true },
        ],
      })
      currentEa.push(decodeMorphoV2HistoricalHolderEaUint(raw).toString())
    }
    const approved = approveMorphoV2HistoricalHolderEaEvidence(
      { schemaVersion: 1, kind: 'morpho_v2_historical_holder_ea_pair_v1', origins },
      {
        profile,
        currentSource,
        sharesRaw,
        originHosts: clients.map((c: { host: string }) => c.host) as [string, string],
        asOfMs: Date.now(),
      },
    )
    if (currentEa[0] !== currentEa[1]) throw Error('current_Ea_disagreement')
    results.push({ asset, currentEaRaw: currentEa[0], approval: approved, origins })
  }
  status = 'passed'
} catch {
  /* Preserve partial native bytes; do not retry or expose provider URLs. */
}
// Origin deadlines can return before the physical transport settles. Retain its
// bounded final attempt before sealing; never launch another RPC here.
const events = await control.finish()
const receipt = seal('native-historical-holder-ea.json', {
  schemaVersion: 1,
  status,
  startedAtUtc: new Date(started).toISOString(),
  completedAtUtc: new Date().toISOString(),
  requestedRaw: '1000000',
  sharesAreHypothetical: true,
  pastOwnershipProven: false,
  currentOwnerProven: false,
  executionProven: false,
  forecastValidated: false,
  results,
  events,
})
console.log(JSON.stringify({ status, reads: events.length, assets: results.length, ...receipt }))
if (status !== 'passed') process.exitCode = 1
