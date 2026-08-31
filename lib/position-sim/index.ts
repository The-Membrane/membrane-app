/**
 * The position simulator: read a real lending position from an address, put the same
 * collateral/debt vector into Membrane, and run both through a measured stress window.
 *
 * See docs/POSITION_SIMULATOR.md for data provenance, the adapter interface, and the
 * full list of known limitations.
 */

export * from './types'
export * from './membrane'
export * from './scenario'
export * from './compare'
export * from './demo'
export * from './venues'
export * from './share'
export { getMainnetClient, parseAddress, rpcLabel, toNumber, PUBLIC_MAINNET_RPCS } from './rpc'
export { runAdapters, ADAPTERS } from './adapters'
export type { LendingAdapter } from './adapters/types'
