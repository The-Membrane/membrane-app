/**
 * Hosts that must never be asked for `eth_getLogs` (board R33, 2026-10-11).
 *
 * Both are builder relays. Measured on 2026-10-11:
 *   - rpc.flashbots.net answered `[]` on 268 of 328 checked 10k-block ranges that held
 *     logs. It serves only a slice of history (about blocks 22.3M–22.4M) and answers
 *     `[]` everywhere else, at any pacing. `[]` is not an error, so a viem `fallback`
 *     client takes it as success and never moves on.
 *   - rpc.mevblocker.io was dead at every probe.
 * Remote copies of RECORDER_RPC_URL (CI, the tick box) still list both, so code drops
 * them here rather than relying on every env being fixed.
 *
 * NO IMPORTS: lib/oracleRegistry/manipulation imports this module and must stay
 * dependency-free (it runs from a bare checkout).
 */
export const EXCLUDED_LOG_HOSTS = ['rpc.flashbots.net', 'rpc.mevblocker.io'] as const

/** True when `url`'s hostname is an excluded relay. A URL that does not parse is not
 *  excluded here; whoever uses it will fail on it anyway. */
export function isExcludedLogHost(url: string): boolean {
  let hostname: string
  try {
    // A trailing dot (`rpc.flashbots.net.`) is the same host in DNS.
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return false
  }
  return (EXCLUDED_LOG_HOSTS as readonly string[]).includes(hostname)
}

/** `urls` without the excluded relays, order kept. */
export function withoutExcludedLogHosts(urls: readonly string[]): string[] {
  return urls.filter((u) => !isExcludedLogHost(u))
}
