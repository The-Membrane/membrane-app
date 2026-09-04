// On-chain Q-Racing game hooks. Reads (pets, BYTES, standings, daily, session) and
// mutations (createPet, startSession, endSession, and the burner-signed gameplay
// actions feed/train/trainBatch/race/runDaily).
//
// WALLET UX CONTRACT (owner rule): the ONLY owner-signed actions are createPet (incl. its
// swap→approve payment sequence), grantSession + burner top-up, and revoke + sweep. ALL
// gameplay is burner-signed and promptless (lib/qgame/session.ts sendBurnerCall).

import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { parseEther, type Abi, type Address, type PublicClient } from 'viem'
import useWallet from '@/hooks/useWallet'
import { getContractAddress } from '@/config/evm/contracts'
import {
  pocketGPAbi,
  petNftAbi,
  bytesAbi,
  petLensAbi,
  standingsAbi,
  TIER_COUNT,
} from '@/lib/qgame/abi'
import { routerAbi } from '@/lib/payments/abi'
import { RouterQuoteSource, type SellToken } from '@/lib/payments/quotes'
import {
  readSession,
  isSessionLive,
  buildGrantSessionCall,
  buildRevokeSessionCall,
  sendBurnerCall,
  defaultSessionExpiry,
  getFeeCapWei,
  DEFAULT_TOPUP_ETH,
  type SessionInfo,
} from '@/lib/qgame/session'
import {
  loadOrCreateBurner,
  getBurnerAccount,
  getBurnerAddress,
  sweepBackTo,
  clearBurner,
} from '@/lib/qgame/burner'
import { runEvmCalls } from '@/services/chain/txRunner'
import { buildApproveIfNeeded } from '@/services/chain/allowance'
import type { EvmCall } from '@/services/chain/types'

// ---- address resolution ----

export type QGameAddresses = {
  pocketGP: Address
  petNFT: Address
  bytes: Address
  petLens: Address
  standings: Address
  dailyMaze: Address
  cdt: Address
  usdc: Address
  weth: Address
  router: Address
}

function resolveAddresses(chainId: number): QGameAddresses | null {
  const g = (n: Parameters<typeof getContractAddress>[1]) => getContractAddress(chainId, n)
  const pocketGP = g('qgamePocketGP')
  const petNFT = g('qgamePetNFT')
  const bytes = g('qgameBytes')
  const petLens = g('qgamePetLens')
  const standings = g('qgameStandings')
  const dailyMaze = g('qgameDailyMaze')
  const cdt = g('qgameCdt')
  const usdc = g('qgameUsdc')
  const weth = g('qgameWeth')
  const router = g('qgameRouter')
  if (!pocketGP || !petNFT || !bytes || !petLens || !standings || !cdt) return null
  return {
    pocketGP,
    petNFT,
    bytes,
    petLens,
    standings,
    dailyMaze: dailyMaze ?? ('0x0000000000000000000000000000000000000000' as Address),
    cdt,
    usdc: usdc ?? ('0x0000000000000000000000000000000000000000' as Address),
    weth: weth ?? ('0x0000000000000000000000000000000000000000' as Address),
    router: router ?? ('0x0000000000000000000000000000000000000000' as Address),
  }
}

export function useQGameConfig() {
  const { address, isWalletConnected, chain, walletClient, publicClient } = useWallet()
  const chainId = chain.id
  const addresses = useMemo(() => resolveAddresses(chainId), [chainId])
  return { address, isWalletConnected, chainId, addresses, walletClient, publicClient }
}

// ---- read types ----

export type PetCard = {
  exists: boolean
  name: string
  paint: number
  paintsOwned: number
  fedTs: bigint
  satiation: bigint
  chainNow: bigint
  streak: number
  upgrades: readonly [number, number, number]
  trainRaces: number
  races: number
  wins: number
  moodLvl: number
  raceEpsPct: number
  trainEpsPct: number
}

export type PetWithId = { id: bigint; card: PetCard }

// ---- reads ----

/** Pets owned by the connected wallet, each with its PetLens card. */
export function useQGamePets() {
  const { addresses, address, publicClient, chainId } = useQGameConfig()
  return useQuery<PetWithId[]>({
    queryKey: ['qgame', 'pets', chainId, address],
    enabled: !!addresses && !!address && !!publicClient,
    staleTime: 15_000,
    queryFn: async () => {
      const pc = publicClient as PublicClient
      const a = addresses as QGameAddresses
      const total = (await pc.readContract({
        address: a.petNFT,
        abi: petNftAbi,
        functionName: 'totalMinted',
      })) as bigint
      if (total === 0n) return []

      const ids: bigint[] = []
      for (let i = 1n; i <= total; i++) ids.push(i)
      const owners = await Promise.all(
        ids.map((id) =>
          pc.readContract({ address: a.petNFT, abi: petNftAbi, functionName: 'ownerOf', args: [id] }),
        ),
      )
      const mine = ids.filter(
        (_, i) => (owners[i] as string).toLowerCase() === (address as string).toLowerCase(),
      )
      const cards = await Promise.all(
        mine.map((id) =>
          pc.readContract({ address: a.petLens, abi: petLensAbi, functionName: 'getPetCard', args: [id] }),
        ),
      )
      return mine.map((id, i) => ({ id, card: cards[i] as unknown as PetCard }))
    },
  })
}

/** BYTES (race winnings) balance of the connected wallet. Whole units (decimals 0). */
export function useQGameBytes() {
  const { addresses, address, publicClient, chainId } = useQGameConfig()
  return useQuery<bigint>({
    queryKey: ['qgame', 'bytes', chainId, address],
    enabled: !!addresses && !!address && !!publicClient,
    staleTime: 15_000,
    queryFn: async () => {
      const pc = publicClient as PublicClient
      const a = addresses as QGameAddresses
      return (await pc.readContract({
        address: a.bytes,
        abi: bytesAbi,
        functionName: 'balanceOf',
        args: [address as Address],
      })) as bigint
    },
  })
}

export type StandingsTier = { tier: number; entries: { who: Address; steps: number }[] }

/** All 5 tier leaderboards (protocol-scoped: live regardless of wallet). */
export function useQGameStandings() {
  const { addresses, publicClient, chainId } = useQGameConfig()
  return useQuery<StandingsTier[]>({
    queryKey: ['qgame', 'standings', chainId],
    enabled: !!addresses && !!publicClient,
    staleTime: 30_000,
    queryFn: async () => {
      const pc = publicClient as PublicClient
      const a = addresses as QGameAddresses
      const tiers = Array.from({ length: TIER_COUNT }, (_, t) => t)
      return Promise.all(
        tiers.map(async (tier) => {
          const [who, steps] = (await pc.readContract({
            address: a.standings,
            abi: standingsAbi,
            functionName: 'leaderboard',
            args: [tier],
          })) as [Address[], number[]]
          return { tier, entries: who.map((w, i) => ({ who: w, steps: Number(steps[i]) })) }
        }),
      )
    },
  })
}

export type DailyState = { day: number; claimed: boolean; trackId: number | null }

/** Daily-maze state for the connected wallet (claim state is keyed by owner address). */
export function useQGameDaily() {
  const { addresses, address, publicClient, chainId } = useQGameConfig()
  return useQuery<DailyState>({
    queryKey: ['qgame', 'daily', chainId, address],
    enabled: !!addresses && !!address && !!publicClient,
    staleTime: 30_000,
    queryFn: async () => {
      const pc = publicClient as PublicClient
      const a = addresses as QGameAddresses
      const day = (await pc.readContract({
        address: a.pocketGP,
        abi: pocketGPAbi,
        functionName: 'today',
      })) as number
      const [claimed, rawTrack] = await Promise.all([
        pc.readContract({
          address: a.pocketGP,
          abi: pocketGPAbi,
          functionName: 'dailyClaimed',
          args: [day, address as Address],
        }) as Promise<boolean>,
        pc.readContract({
          address: a.pocketGP,
          abi: pocketGPAbi,
          functionName: 'dailyTrackOf',
          args: [day],
        }) as Promise<bigint>,
      ])
      return { day: Number(day), claimed, trackId: rawTrack > 0n ? Number(rawTrack) - 1 : null }
    },
  })
}

export type SessionStatus = {
  session: SessionInfo
  burnerAddress: Address | null
  gasBalanceWei: bigint
  live: boolean
  feeCapWei: bigint
}

/** Play-session status: the on-chain grant, the burner key, and its dust-gas balance. */
export function useQGameSession() {
  const { addresses, address, publicClient, chainId } = useQGameConfig()
  return useQuery<SessionStatus>({
    queryKey: ['qgame', 'session', chainId, address],
    enabled: !!addresses && !!address && !!publicClient,
    staleTime: 10_000,
    queryFn: async () => {
      const pc = publicClient as PublicClient
      const a = addresses as QGameAddresses
      const session = await readSession(pc, a.pocketGP, address as Address)
      const burnerAddress = getBurnerAddress()
      const gasBalanceWei = burnerAddress ? await pc.getBalance({ address: burnerAddress }) : 0n
      return {
        session,
        burnerAddress,
        gasBalanceWei,
        live: isSessionLive(session, burnerAddress ?? undefined),
        feeCapWei: getFeeCapWei(),
      }
    },
  })
}

// ---- mutations ----

export type PayWith = 'CDT' | SellToken // 'CDT' | 'USDC' | 'ETH'

/**
 * createPet — OWNER-signed. Payment sequence by asset:
 *  - CDT:  approve(CDT→PocketGP, petPrice) → createPet(name)
 *  - USDC: approve(USDC→router, pullMax) → swapTokensForExactTokens(petPrice) → approve(CDT→PocketGP) → createPet
 *  - ETH:  swapETHForExactTokens(petPrice){value: pullMax} → approve(CDT→PocketGP) → createPet
 * pullMax comes from the RouterQuoteSource (getAmountsIn + slippage).
 */
export function useCreatePet() {
  const { addresses, address, walletClient, publicClient } = useQGameConfig()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ name, pay }: { name: string; pay: PayWith }) => {
      if (!addresses || !address || !walletClient || !publicClient) throw new Error('Connect your wallet first')
      const a = addresses
      const pc = publicClient as PublicClient
      const petPrice = (await pc.readContract({
        address: a.pocketGP,
        abi: pocketGPAbi,
        functionName: 'petPrice',
      })) as bigint
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
      const calls: EvmCall[] = []

      if (pay === 'CDT') {
        // Approve gated on the standing allowance (services/chain/allowance.ts).
        calls.push(
          ...(await buildApproveIfNeeded(pc, {
            token: a.cdt,
            owner: address as Address,
            spender: a.pocketGP,
            amount: petPrice,
          })),
        )
      } else {
        const quote = await new RouterQuoteSource({
          publicClient: pc,
          router: a.router,
          cdt: a.cdt,
          usdc: a.usdc,
          weth: a.weth,
        }).quote({ sellToken: pay, cdtOut: petPrice })
        if (pay === 'USDC') {
          calls.push(
            ...(await buildApproveIfNeeded(pc, {
              token: a.usdc,
              owner: address as Address,
              spender: a.router,
              amount: quote.pullMax,
            })),
          )
          calls.push({
            address: a.router,
            abi: routerAbi as unknown as Abi,
            functionName: 'swapTokensForExactTokens',
            args: [petPrice, quote.pullMax, [a.usdc, a.cdt], address, deadline],
          })
        } else {
          calls.push({
            address: a.router,
            abi: routerAbi as unknown as Abi,
            functionName: 'swapETHForExactTokens',
            args: [petPrice, [a.weth, a.cdt], address, deadline],
            value: quote.pullMax,
          })
        }
        calls.push(
          ...(await buildApproveIfNeeded(pc, {
            token: a.cdt,
            owner: address as Address,
            spender: a.pocketGP,
            amount: petPrice,
          })),
        )
      }

      calls.push({ address: a.pocketGP, abi: pocketGPAbi as unknown as Abi, functionName: 'createPet', args: [name] })
      return runEvmCalls({ msgs: calls, address, walletClient, publicClient: pc })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['qgame'] }),
  })
}

/**
 * startSession — OWNER-signed. grantSession(burner, +7d) then a small ETH top-up transfer
 * to the burner so it can pay for promptless gameplay gas.
 */
export function useStartSession() {
  const { addresses, address, walletClient, publicClient } = useQGameConfig()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ topupEth = DEFAULT_TOPUP_ETH }: { topupEth?: string } = {}) => {
      if (!addresses || !address || !walletClient || !publicClient) throw new Error('Connect your wallet first')
      const a = addresses
      const pc = publicClient as PublicClient
      const account = loadOrCreateBurner()
      const key = account.address
      const expiry = defaultSessionExpiry()

      // owner tx 1: grant the session
      await runEvmCalls({ msgs: [buildGrantSessionCall(a.pocketGP, key, expiry)], address, walletClient, publicClient: pc })
      // owner tx 2: fund the burner with dust gas
      const hash = await walletClient.sendTransaction({
        account: address,
        chain: walletClient.chain,
        to: key,
        value: parseEther(topupEth),
      })
      await pc.waitForTransactionReceipt({ hash })
      return { key, expiry }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['qgame'] }),
  })
}

/** endSession — OWNER-signed revoke, then burner-signed sweep of the dust back to owner. */
export function useEndSession() {
  const { addresses, address, walletClient, publicClient } = useQGameConfig()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      if (!addresses || !address || !walletClient || !publicClient) throw new Error('Connect your wallet first')
      const a = addresses
      const pc = publicClient as PublicClient
      await runEvmCalls({ msgs: [buildRevokeSessionCall(a.pocketGP)], address, walletClient, publicClient: pc })
      const sweepHash = await sweepBackTo(address, pc)
      clearBurner()
      return { sweepHash }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['qgame'] }),
  })
}

// ---- burner-signed gameplay ----

function useBurnerAction<TArgs>(build: (a: QGameAddresses, args: TArgs) => EvmCall) {
  const { addresses, publicClient } = useQGameConfig()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (args: TArgs) => {
      if (!addresses || !publicClient) throw new Error('Connect your wallet first')
      const account = getBurnerAccount()
      if (!account) throw new Error('No play session — start one first')
      const call = build(addresses, args)
      return sendBurnerCall({ call, account, publicClient: publicClient as PublicClient, capWei: getFeeCapWei() })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['qgame'] }),
  })
}

const gp = pocketGPAbi as unknown as Abi

export const useFeed = () =>
  useBurnerAction<{ id: bigint }>((a, { id }) => ({ address: a.pocketGP, abi: gp, functionName: 'feed', args: [id] }))

export const useTrain = () =>
  useBurnerAction<{ id: bigint; tierIdx: number }>((a, { id, tierIdx }) => ({
    address: a.pocketGP,
    abi: gp,
    functionName: 'train',
    args: [id, tierIdx],
  }))

export const useTrainBatch = () =>
  useBurnerAction<{ id: bigint; tierIdx: number; count: number }>((a, { id, tierIdx, count }) => ({
    address: a.pocketGP,
    abi: gp,
    functionName: 'trainBatch',
    args: [id, tierIdx, count],
  }))

export const useRace = () =>
  useBurnerAction<{ id: bigint; tierIdx: number; seed: number }>((a, { id, tierIdx, seed }) => ({
    address: a.pocketGP,
    abi: gp,
    functionName: 'race',
    args: [id, tierIdx, seed],
  }))

export const useRunDaily = () =>
  useBurnerAction<{ id: bigint }>((a, { id }) => ({ address: a.pocketGP, abi: gp, functionName: 'runDaily', args: [id] }))
