// MintSheet — the Living Typeface confirm sheet for minting a Q-Racing pet + BYTE (Phase 4).
//
// V20 intent-preserving connect: with no wallet the sheet stays fully populated and the primary
// button becomes "Connect wallet"; after connecting, the SAME sheet re-renders ready to sign.
// Sharp corners, hairline borders, mono numbers — no legacy Press-Start-2P / glass styling.

import React, { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Divider,
  Flex,
  HStack,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useAccount, usePublicClient, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatUnits } from 'viem'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DEFAULT_EVM_CHAIN } from '@/config/evm/chains'
import { getContractAddress } from '@/config/evm/contracts'
import { GAME_STATE_KEY } from '@/hooks/useOffchainRacing'
import { mintClaimAbi } from '@/lib/mint/abi'
import { RouterQuoteSource, DEFAULT_SLIPPAGE_BPS, type SellToken } from '@/lib/mint/quotes'
import useMintClaim, { type MintKind, type PaymentAsset, type MintPhase } from './hooks/useMintClaim'

const BYTE_DECIMALS = 6
const CDT_DECIMALS = 18

type MintSheetProps = {
  isOpen: boolean
  onClose: () => void
  kind: MintKind
  /** Pet name for pet_and_byte; ignored for byte_only. */
  petName?: string | null
  /** Raw pet attributes (CarTraits) for a short summary line; optional. */
  petAttributes?: unknown
  /** Claimable BYTE preview, in 6-dp base units (from game state). */
  byteAmountBase: string
}

const label = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}
const mono = { fontFamily: TYPOGRAPHY.fontMono, color: SEMANTIC_COLORS.textPrimary }

function formatByte(base: string | null | undefined): string {
  if (!base) return '0'
  try {
    const v = BigInt(base)
    const whole = v / 10n ** BigInt(BYTE_DECIMALS)
    const frac = (v % 10n ** BigInt(BYTE_DECIMALS)).toString().padStart(BYTE_DECIMALS, '0')
    const trimmed = frac.replace(/0+$/, '')
    return trimmed ? `${whole}.${trimmed}` : `${whole}`
  } catch {
    return '0'
  }
}

function attrSummary(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== 'object') return null
  const a = attributes as Record<string, unknown>
  const parts = [a.base_color, a.paint_finish, a.rim_style].filter(
    (x): x is string => typeof x === 'string',
  )
  return parts.length ? parts.join(' · ') : null
}

function hhmm(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const PHASE_LABEL: Record<MintPhase, string> = {
  idle: '',
  voucher: 'Requesting voucher…',
  swapping: 'Swapping to CDT…',
  approving: 'Approving…',
  claiming: 'Minting…',
  confirming: 'Confirming…',
  done: 'Done',
  error: '',
}

const ERROR_COPY: Record<string, string> = {
  no_verified_wallet: 'Link a wallet to this player before minting.',
  no_byte_to_claim: 'No BYTE available to claim yet.',
  no_offchain_pet: 'No offchain pet to mint.',
  no_minted_pet: 'Mint your pet first, then claim BYTE.',
  mint_not_configured: 'Mint bridge is not configured on this network.',
  missing_quote: 'Waiting for a swap quote — try again in a moment.',
  wallet_not_connected: 'Connect your wallet to mint.',
}

const PAYMENTS: PaymentAsset[] = ['CDT', 'USDC', 'ETH']

const MintSheet: React.FC<MintSheetProps> = ({
  isOpen,
  onClose,
  kind,
  petName,
  petAttributes,
  byteAmountBase,
}) => {
  const { isConnected, chainId } = useAccount()
  const { openConnectModal } = useConnectModal()
  const publicClient = usePublicClient()
  const queryClient = useQueryClient()

  const [payment, setPayment] = useState<PaymentAsset>('CDT')
  const { phase, error, result, run, reset } = useMintClaim()

  const cid = chainId ?? DEFAULT_EVM_CHAIN.id
  const mintClaimAddr = getContractAddress(cid, 'qracingMintClaim')
  const router = getContractAddress(cid, 'qracingRouter')
  const cdt = getContractAddress(cid, 'qracingCdt')
  const usdc = getContractAddress(cid, 'qracingUsdc')
  const weth = getContractAddress(cid, 'qracingWeth')
  const configured = !!mintClaimAddr && !/^0x0{40}$/i.test(mintClaimAddr)

  // On close, reset the flow + payment selector so a reopen is clean.
  useEffect(() => {
    if (!isOpen) {
      reset()
      setPayment('CDT')
    }
  }, [isOpen, reset])

  // On success, refresh the offchain game state (balance, pet status).
  useEffect(() => {
    if (phase === 'done') {
      queryClient.invalidateQueries({ queryKey: GAME_STATE_KEY })
    }
  }, [phase, queryClient])

  // On-chain mint fee (CDT base units).
  const { data: mintFeeData } = useReadContract({
    address: mintClaimAddr,
    abi: mintClaimAbi,
    functionName: 'mintFee',
    query: { enabled: isOpen && configured },
  })
  const cdtFee = (mintFeeData as bigint | undefined) ?? 0n

  // Live swap quote for non-CDT payment; refetch every 15s while the sheet is open.
  const quote = useQuery({
    queryKey: ['mint-quote', payment, cdtFee.toString(), cid],
    queryFn: async () => {
      const src = new RouterQuoteSource({
        publicClient: publicClient!,
        router: router!,
        cdt: cdt!,
        usdc: usdc!,
        weth: weth!,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      })
      return src.quote({ sellToken: payment as SellToken, cdtOut: cdtFee })
    },
    enabled:
      isOpen &&
      payment !== 'CDT' &&
      !!publicClient &&
      !!router &&
      !!cdt &&
      !!usdc &&
      !!weth &&
      cdtFee > 0n,
    refetchInterval: 15_000,
    staleTime: 15_000,
  })
  const pullMax = quote.data?.pullMax

  const pullDecimals = payment === 'USDC' ? 6 : 18
  const pullLabel = useMemo(() => {
    if (payment === 'CDT') return null
    if (quote.isLoading || pullMax === undefined) return 'quoting…'
    return `${formatUnits(pullMax, pullDecimals)} ${payment}`
  }, [payment, quote.isLoading, pullMax, pullDecimals])

  const busy =
    phase === 'voucher' ||
    phase === 'swapping' ||
    phase === 'approving' ||
    phase === 'claiming' ||
    phase === 'confirming'

  const handlePrimary = () => {
    if (!isConnected) {
      openConnectModal?.()
      return
    }
    run({ kind, payment, cdtFee, pullMax })
  }

  const errCopy = error ? ERROR_COPY[error] ?? error : null
  const canMint = configured && (payment === 'CDT' || pullMax !== undefined) && !busy

  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered>
      <ModalOverlay />
      <ModalContent
        bg={SEMANTIC_COLORS.bgSecondary}
        borderRadius={0}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
      >
        <ModalHeader fontFamily={TYPOGRAPHY.fontDisplay} color={SEMANTIC_COLORS.textPrimary}>
          Make it permanent
        </ModalHeader>
        <ModalCloseButton _focus={FOCUS_STYLES.ring} />

        <ModalBody pb={SPACING_PATTERNS.modalPadding}>
          {phase === 'done' && result ? (
            <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
              <Text {...mono} color={SEMANTIC_COLORS.primary}>
                Minted.
              </Text>
              {result.tokenId !== null && (
                <Flex justify="space-between">
                  <Text {...label}>Token ID</Text>
                  <Text {...mono}>#{result.tokenId}</Text>
                </Flex>
              )}
              <Flex justify="space-between">
                <Text {...label}>Byte minted</Text>
                <Text {...mono} color={SEMANTIC_COLORS.primary}>
                  {formatByte(result.byteMinted)}
                </Text>
              </Flex>
              <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary} noOfLines={1}>
                tx {result.mintTx}
              </Text>
            </VStack>
          ) : (
            <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
              {/* What is being minted */}
              <Flex justify="space-between" align="start" gap={SPACING.md}>
                <Text {...label}>{kind === 'byte_only' ? 'Claim' : 'Pet'}</Text>
                <Box textAlign="right">
                  <Text {...mono}>{kind === 'byte_only' ? 'BYTE only' : petName || 'Racer'}</Text>
                  {kind !== 'byte_only' && attrSummary(petAttributes) && (
                    <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                      {attrSummary(petAttributes)}
                    </Text>
                  )}
                </Box>
              </Flex>

              <Flex justify="space-between">
                <Text {...label}>Byte</Text>
                <Text {...mono} color={SEMANTIC_COLORS.primary}>
                  {formatByte(byteAmountBase)}
                </Text>
              </Flex>

              <Flex justify="space-between">
                <Text {...label}>Fee</Text>
                <Text {...mono}>{formatUnits(cdtFee, CDT_DECIMALS)} CDT</Text>
              </Flex>

              <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

              {/* Payment selector */}
              <Text {...label}>Pay with</Text>
              <HStack spacing={SPACING.sm}>
                {PAYMENTS.map((p) => (
                  <Button
                    key={p}
                    size="sm"
                    flex="1"
                    variant={payment === p ? 'solid' : 'outline'}
                    colorScheme={payment === p ? 'phosphor' : undefined}
                    borderRadius={0}
                    fontFamily={TYPOGRAPHY.fontMono}
                    isDisabled={busy}
                    transition={TRANSITIONS.colors}
                    _hover={HOVER_EFFECTS.borderHighlight}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ring}
                    onClick={() => setPayment(p)}
                  >
                    {p}
                  </Button>
                ))}
              </HStack>

              {/* Non-CDT quote: pull ≤ X + source · fetched HH:MM + slippage note */}
              {payment !== 'CDT' && (
                <Box
                  border="1px solid"
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  px={SPACING.md}
                  py={SPACING.sm}
                >
                  <Flex justify="space-between">
                    <Text {...label}>Pull ≤</Text>
                    <Text {...mono}>{pullLabel}</Text>
                  </Flex>
                  {quote.data && (
                    <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
                      {quote.data.source} · fetched {hhmm(quote.data.fetchedAt)} ·{' '}
                      {(DEFAULT_SLIPPAGE_BPS / 100).toFixed(0)}% max slippage
                    </Text>
                  )}
                  {quote.isError && (
                    <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.danger}>
                      Quote unavailable — pool may be unreachable.
                    </Text>
                  )}
                </Box>
              )}

              {!configured && (
                <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.warning}>
                  Mint bridge is not deployed on this network yet.
                </Text>
              )}

              {busy && (
                <Text {...mono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
                  {PHASE_LABEL[phase]}
                </Text>
              )}

              {errCopy && (
                <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.danger}>
                  {errCopy}
                </Text>
              )}
            </VStack>
          )}
        </ModalBody>

        <ModalFooter pt={SPACING_PATTERNS.modalPadding} gap={SPACING_PATTERNS.buttonGroupGap}>
          {phase === 'done' ? (
            <Button
              colorScheme="phosphor"
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              transition={TRANSITIONS.colors}
              _focus={FOCUS_STYLES.ring}
              onClick={onClose}
            >
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                borderRadius={0}
                fontFamily={TYPOGRAPHY.fontMono}
                isDisabled={busy}
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
                _focus={FOCUS_STYLES.ring}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                colorScheme="phosphor"
                borderRadius={0}
                fontFamily={TYPOGRAPHY.fontMono}
                isLoading={busy}
                loadingText={PHASE_LABEL[phase] || 'Working…'}
                isDisabled={!isConnected ? false : !canMint}
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
                _active={ACTIVE_EFFECTS.dim}
                _focus={FOCUS_STYLES.ring}
                onClick={handlePrimary}
              >
                {!isConnected ? 'Connect wallet' : phase === 'error' ? 'Retry mint' : 'Confirm & mint'}
              </Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default MintSheet
