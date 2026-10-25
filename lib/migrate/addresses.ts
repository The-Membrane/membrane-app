/**
 * Where each piece of the migration lives, per chain. Nothing here is guessed:
 *
 *   mainnet (1)  Bundler3, GeneralAdapter1 and the Aave V3 core migration adapter are Morpho's
 *                deployments, listed in @morpho-org/blue-sdk@5.0.0 lib/addresses and checked
 *                on-chain 2026-10-25 13:36 UTC via ethereum-rpc.publicnode.com:
 *                GeneralAdapter1.BUNDLER3() == bundler3, GeneralAdapter1.MORPHO() == Morpho Blue,
 *                AaveV3MigrationAdapter.AAVE_V3_POOL() == the Aave V3 core pool.
 *                Membrane is NOT deployed on mainnet (pre-launch), so `cdp` and `membraneAdapter`
 *                are null and every mainnet plan says so.
 *                Spark: Morpho ships no Spark migration adapter. A stock AaveV3MigrationAdapter
 *                constructed with the Spark pool would serve (existing code, a deploy, no new
 *                contract); until one exists the Spark flow is blocked with that reason.
 *   anvil (31337) The self-contained local stack contracts/migrator/script/DeployLocal.s.sol
 *                writes to contracts/migrator/deployments/local.json (deterministic on a fresh
 *                anvil). It carries its own Cdp: the app's DeployFullSystem deployment never
 *                calls cdp.setTransmuterForPeg and passes no paired asset, so the peg borrow
 *                the flash repay needs reverts there (TransmuterNotWired).
 */

import localDeployment from '@/contracts/migrator/deployments/local.json'

import type { Address } from './types'

export interface MigrateChainConfig {
  chainId: number
  label: string
  bundler3: Address | null
  generalAdapter1: Address | null
  /** Bundler3 AaveV3MigrationAdapter bound to the Aave V3 core pool. */
  aaveV3Adapter: Address | null
  /** Bundler3 AaveV3MigrationAdapter bound to the Spark pool (none deployed by Morpho). */
  sparkAdapter: Address | null
  morpho: Address | null
  aavePool: Address | null
  sparkPool: Address | null
  /** Membrane. null = no Membrane deployment on this chain. */
  cdp: Address | null
  membraneAdapter: Address | null
  /** The Transmuter's paired asset (the only debt token the peg borrow can repay). */
  pairedAsset: Address | null
  /** Membrane denom per collateral token address (lower-case). */
  denoms: Record<string, `0x${string}`>
  /** Token address per symbol on THIS chain (the source position's addresses are mainnet's). */
  tokens: Record<string, Address>
  /** A Morpho market this chain's flow targets when the source market id is not on it. */
  morphoMarket: { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint } | null
  source: string
}

const MAINNET: MigrateChainConfig = {
  chainId: 1,
  label: 'Ethereum',
  bundler3: '0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245',
  generalAdapter1: '0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0',
  aaveV3Adapter: '0xb09e40EbE31b738fbf20289270a397118707D475',
  sparkAdapter: null,
  morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  aavePool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  sparkPool: '0xC13e21B648A5Ee794902342038FF3aDAB66BE987',
  cdp: null,
  membraneAdapter: null,
  pairedAsset: null,
  denoms: {},
  tokens: {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  morphoMarket: null,
  source: 'Morpho deployments (@morpho-org/blue-sdk@5.0.0), checked on-chain 2026-10-25',
}

interface LocalJson {
  chainId: number
  bundler3: Address
  generalAdapter1: Address
  aaveV3Adapter: Address
  morpho: Address
  aavePool: Address
  cdp: Address
  membraneAdapter: Address
  usdc: Address
  weth: Address
  wethDenom: `0x${string}`
  morphoOracle: Address
  morphoIrm: Address
  morphoLltv: number
}

function fromLocal(j: Partial<LocalJson>): MigrateChainConfig | null {
  if (!j.cdp || !j.bundler3) return null
  return {
    chainId: 31337,
    label: 'Anvil (local)',
    bundler3: j.bundler3,
    generalAdapter1: j.generalAdapter1 ?? null,
    aaveV3Adapter: j.aaveV3Adapter ?? null,
    sparkAdapter: null,
    morpho: j.morpho ?? null,
    aavePool: j.aavePool ?? null,
    sparkPool: null,
    cdp: j.cdp,
    membraneAdapter: j.membraneAdapter ?? null,
    pairedAsset: j.usdc ?? null,
    denoms: j.weth && j.wethDenom ? { [j.weth.toLowerCase()]: j.wethDenom } : {},
    tokens: j.weth && j.usdc ? { WETH: j.weth, ETH: j.weth, USDC: j.usdc } : {},
    morphoMarket:
      j.usdc && j.weth && j.morphoOracle && j.morphoIrm && j.morphoLltv !== undefined
        ? { loanToken: j.usdc, collateralToken: j.weth, oracle: j.morphoOracle, irm: j.morphoIrm, lltv: BigInt(j.morphoLltv) }
        : null,
    source: 'contracts/migrator/deployments/local.json (DeployLocal.s.sol)',
  }
}

const REGISTRY: Record<number, MigrateChainConfig> = { 1: MAINNET }
/** Review L-5: the local anvil stack is dev/test only. A production build leaves it out unless
 *  NEXT_PUBLIC_MIGRATE_LOCAL=1 is set explicitly. */
const LOCAL_ENABLED = process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_MIGRATE_LOCAL === '1'
const local = LOCAL_ENABLED ? fromLocal(localDeployment as Partial<LocalJson>) : null
if (local) REGISTRY[31337] = local

export function migrateConfig(chainId: number | undefined): MigrateChainConfig | null {
  if (chainId === undefined) return null
  return REGISTRY[chainId] ?? null
}

/** The chain a source position lives on. The simulator adapters read mainnet only. */
export const SOURCE_CHAIN_ID = 1
