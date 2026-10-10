// One foreground continuity tick. Large holder-filtered windows use the two
// origins observed to serve them; Infura is paced after observed HTTP 429s.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { tickContinuity } from './susde-public-pending-continuity-archive.mjs'

const HOSTS = ['rpc.ankr.com', 'mainnet.infura.io']
const GAP_MS = 2500
const MAX_ATTEMPTS = 3
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function pacedInfuraClients(urls, { clients = publicRpcClients, delay = sleep } = {}) {
  const selected = HOSTS.map((host) => urls.find((url) => new URL(url).hostname === host))
  if (selected.some((url) => !url)) throw Error('susde_continuity_origins_not_configured')
  return clients(selected).map((client) => {
    if (new URL(client.provider).hostname !== 'mainnet.infura.io') return client
    let queue = Promise.resolve()
    return {
      ...client,
      request(method, params) {
        const work = queue.then(async () => {
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            await delay(GAP_MS + (attempt - 1) * 1500)
            try {
              return await client.request(method, params)
            } catch (error) {
              if (attempt === MAX_ATTEMPTS || error?.message !== 'public_rpc_unavailable')
                throw error
            }
          }
          throw Error('susde_continuity_rpc_unavailable')
        })
        queue = work.catch(() => {})
        return work
      },
    }
  })
}

export async function foregroundTick(issueSequence, options = {}) {
  if (!Number.isSafeInteger(issueSequence) || issueSequence < 1)
    throw Error('susde_continuity_issue_invalid')
  const urls = options.urls ?? configuredPublicRpcUrls(readEnv('.env.local'))
  const peers = pacedInfuraClients(urls, options)
  const result = await (options.tick ?? tickContinuity)({
    issueSequence,
    urls: peers.map((peer) => peer.provider),
    clients: () => peers,
  })
  return {
    issueSequence,
    status: result.status,
    appended: result.appended ?? 0,
    coveredThroughBlock: result.coveredThroughBlock ?? null,
    endBlock: result.endBlock ?? null,
    windows: result.windows ?? 0,
    complete: result.complete ?? false,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--issue' || !/^[1-9]\d*$/.test(args[1]))
    throw Error('usage: --issue N')
  foregroundTick(Number(args[1]))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(String(error?.message ?? 'susde_continuity_tick_failed').split(' ')[0])
      process.exitCode = 1
    })
}
