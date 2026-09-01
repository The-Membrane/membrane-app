// Orchestrates the on-chain mint-claim flow for a Q-Racing pet + BYTE (Phase 4).
//
// Sequence (per docs/OFFCHAIN_QRACING_PLAN.md §Phase 4, task item 7):
//   1. POST /api/mint/voucher  → server-signed EIP-712 voucher (byteAmount is server-decided)
//   2. [pay in USDC/ETH] swap input → EXACTLY mintFee CDT (approve input first for USDC)
//   3. approve CDT → MintClaim (if allowance < mintFee)
//   4. claim(voucher, sig)     → one tx mints the pet (unless BYTE-only) + BYTE to msg.sender
//   5. POST /api/mint/confirm   → server verifies the receipt + Claimed event, settles the DB
//
// Uses wagmi useWriteContract (writeContractAsync) for each write and the wagmi publicClient's
// waitForTransactionReceipt to sequence them — the same walletClient/publicClient pattern the
// repo's services/chain/txRunner.ts establishes, just driven step-by-step for a multi-tx flow.

import { useCallback, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { maxUint256 } from 'viem'

import { getContractAddress } from '@/config/evm/contracts'
import { erc20Abi, mintClaimAbi, routerAbi } from '@/lib/mint/abi'

export type PaymentAsset = 'CDT' | 'USDC' | 'ETH'
export type MintKind = 'pet_and_byte' | 'byte_only'

export type MintPhase =
  | 'idle'
  | 'voucher'
  | 'swapping'
  | 'approving'
  | 'claiming'
  | 'confirming'
  | 'done'
  | 'error'

export type MintResult = {
  tokenId: string | null
  byteMinted: string
  mintTx: `0x${string}`
}

type PublicVoucher = {
  to: `0x${string}`
  petAttrsHash: `0x${string}`
  byteAmount: string
  nonce: string
  deadline: string
}

type RunParams = {
  kind: MintKind
  payment: PaymentAsset
  cdtFee: bigint
  /** Max input asset to spend on the swap (amountInMax), required when payment !== 'CDT'. */
  pullMax?: bigint
}

const SWAP_DEADLINE_SECS = 20 * 60

async function jsonPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    throw new Error((data as { error?: string } | null)?.error || `request_failed_${res.status}`)
  }
  return data as T
}

export function useMintClaim() {
  const { address, chainId } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [phase, setPhase] = useState<MintPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MintResult | null>(null)

  const reset = useCallback(() => {
    setPhase('idle')
    setError(null)
    setResult(null)
  }, [])

  const run = useCallback(
    async ({ kind, payment, cdtFee, pullMax }: RunParams) => {
      setError(null)
      setResult(null)
      try {
        if (!address || !chainId || !publicClient) {
          throw new Error('wallet_not_connected')
        }

        const cid = chainId
        const mintClaim = getContractAddress(cid, 'qracingMintClaim')
        const cdt = getContractAddress(cid, 'qracingCdt')
        if (!mintClaim || !cdt) throw new Error('mint_not_configured')

        // 1) Ask the server for a signed voucher (it decides byteAmount, binds voucher.to).
        setPhase('voucher')
        const { claimId, voucher, signature } = await jsonPost<{
          claimId: string
          voucher: PublicVoucher
          signature: `0x${string}`
        }>('/api/mint/voucher', { kind })

        const swapDeadline = BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECS)

        // 2) Pay in a non-CDT asset → swap to EXACTLY cdtFee CDT.
        if (payment !== 'CDT') {
          if (pullMax === undefined) throw new Error('missing_quote')
          const router = getContractAddress(cid, 'qracingRouter')
          if (!router) throw new Error('router_not_configured')

          if (payment === 'USDC') {
            const usdc = getContractAddress(cid, 'qracingUsdc')
            if (!usdc) throw new Error('usdc_not_configured')
            const allowance = await publicClient.readContract({
              address: usdc,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [address, router],
            })
            if (allowance < pullMax) {
              setPhase('approving')
              const approveHash = await writeContractAsync({
                address: usdc,
                abi: erc20Abi,
                functionName: 'approve',
                args: [router, maxUint256],
              })
              await publicClient.waitForTransactionReceipt({ hash: approveHash })
            }
            setPhase('swapping')
            const swapHash = await writeContractAsync({
              address: router,
              abi: routerAbi,
              functionName: 'swapTokensForExactTokens',
              args: [cdtFee, pullMax, [usdc, cdt], address, swapDeadline],
            })
            await publicClient.waitForTransactionReceipt({ hash: swapHash })
          } else {
            const weth = getContractAddress(cid, 'qracingWeth')
            if (!weth) throw new Error('weth_not_configured')
            setPhase('swapping')
            const swapHash = await writeContractAsync({
              address: router,
              abi: routerAbi,
              functionName: 'swapETHForExactTokens',
              args: [cdtFee, [weth, cdt], address, swapDeadline],
              value: pullMax,
            })
            await publicClient.waitForTransactionReceipt({ hash: swapHash })
          }
        }

        // 3) Approve CDT → MintClaim if needed (fee is pulled as an ERC-20).
        if (cdtFee > 0n) {
          const cdtAllowance = await publicClient.readContract({
            address: cdt,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address, mintClaim],
          })
          if (cdtAllowance < cdtFee) {
            setPhase('approving')
            const approveHash = await writeContractAsync({
              address: cdt,
              abi: erc20Abi,
              functionName: 'approve',
              args: [mintClaim, cdtFee],
            })
            await publicClient.waitForTransactionReceipt({ hash: approveHash })
          }
        }

        // 4) claim() — non-payable; mints pet (unless BYTE-only) + BYTE to the caller.
        setPhase('claiming')
        const claimHash = await writeContractAsync({
          address: mintClaim,
          abi: mintClaimAbi,
          functionName: 'claim',
          args: [
            {
              to: voucher.to,
              petAttrsHash: voucher.petAttrsHash,
              byteAmount: BigInt(voucher.byteAmount),
              nonce: BigInt(voucher.nonce),
              deadline: BigInt(voucher.deadline),
            },
            signature,
          ],
        })
        await publicClient.waitForTransactionReceipt({ hash: claimHash })

        // 5) Server verifies the receipt + Claimed event, then settles the DB.
        setPhase('confirming')
        const confirmed = await jsonPost<{
          tokenId: string | null
          byteMinted: string
          mintTx: `0x${string}`
        }>('/api/mint/confirm', { claimId, txHash: claimHash })

        setResult({
          tokenId: confirmed.tokenId,
          byteMinted: confirmed.byteMinted,
          mintTx: confirmed.mintTx,
        })
        setPhase('done')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'mint_failed')
        setPhase('error')
      }
    },
    [address, chainId, publicClient, writeContractAsync],
  )

  return { phase, error, result, run, reset }
}

export default useMintClaim
