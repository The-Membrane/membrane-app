import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Flex, Input, Text } from '@chakra-ui/react'
import NextLink from 'next/link'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import {
  calculateRateWorksheet,
  MAX_WORKSHEET_SIZE_GHO,
  vaultSideRedeemCeiling,
} from '@/lib/carry/decisionWorksheet'
import {
  formatWalletGho,
  isWalletExitReading,
  sizeWithinWalletExitLimit,
  type WalletExitReading,
} from '@/lib/carry/sghoExitPublic'

type RateReading = {
  borrowApy: number
  yieldApy: number
  observedAt: string
}

type DecisionWorksheetProps = {
  chainName: string
  reading: RateReading | null
  readingLabel: string | null
  cashReading?: {
    vaultCashGho: number
    totalAssetsGho: number
    withdrawalsPaused: boolean
    observedAt: string
  } | null
  cashLabel?: string | null
}

type WalletExitState =
  | { status: 'idle' | 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; reading: WalletExitReading; address: string }

const formatGhoFull = (value: number) => {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  const magnitude = Math.abs(value)
  const number =
    magnitude > 0 && magnitude < 0.01
      ? magnitude.toPrecision(2)
      : magnitude.toLocaleString('en-US', {
          maximumFractionDigits: 2,
          minimumFractionDigits: 2,
        })
  return `${sign}${number} GHO`
}

export const formatGho = (value: number) =>
  Math.abs(value) < 1_000_000
    ? formatGhoFull(value)
    : `≈${value > 0 ? '+' : value < 0 ? '−' : ''}${new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 2,
      }).format(Math.abs(value))} GHO`

const formatApy = (value: number) => `${(value * 100).toFixed(2)}%`
const formatCeiling = (value: number) =>
  value > 0 && value < 0.01
    ? `${value.toPrecision(2)} GHO`
    : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} GHO`

/** Rate-only illustration for one exact route. No exit or route-attribution claim. */
export const DecisionWorksheet: React.FC<DecisionWorksheetProps> = ({
  chainName,
  reading,
  readingLabel,
  cashReading = null,
  cashLabel = null,
}) => {
  const [sizeInput, setSizeInput] = useState('10000')
  const [borrowShockPp, setBorrowShockPp] = useState<0 | 1 | 2>(0)
  const [walletInput, setWalletInput] = useState('')
  const [walletExit, setWalletExit] = useState<WalletExitState>({ status: 'idle' })
  const walletExitRequest = useRef<AbortController | null>(null)
  useEffect(() => () => walletExitRequest.current?.abort(), [])

  const checkWalletExit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    walletExitRequest.current?.abort()
    const address = walletInput.trim()
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      setWalletExit({ status: 'error', message: 'Enter a complete Ethereum address.' })
      return
    }

    const controller = new AbortController()
    walletExitRequest.current = controller
    setWalletExit({ status: 'loading' })
    try {
      const response = await fetch('/api/carry/sgho-exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
        signal: controller.signal,
      })
      const data: unknown = await response.json()
      if (!response.ok || !isWalletExitReading(data)) {
        throw new Error('The wallet exit check is unavailable. Try again later.')
      }
      if (!controller.signal.aborted && walletExitRequest.current === controller) {
        setWalletExit({ status: 'ready', reading: data, address })
      }
    } catch {
      if (!controller.signal.aborted) {
        setWalletExit({
          status: 'error',
          message: 'The wallet exit check is unavailable. Try again later.',
        })
      }
    }
  }
  const sizeGho = Number(sizeInput.replaceAll(',', ''))
  const sizeValid = Number.isFinite(sizeGho) && sizeGho > 0 && sizeGho <= MAX_WORKSHEET_SIZE_GHO
  const normalizedSize = sizeInput.replaceAll(',', '').trim()
  const walletSizeWithinLimit =
    walletExit.status === 'ready' && sizeValid
      ? sizeWithinWalletExitLimit(normalizedSize, walletExit.reading.position.effectiveExitGhoRaw)
      : null
  const vaultRedeemCeilingGho = cashReading ? vaultSideRedeemCeiling(cashReading) : null
  const result = useMemo(
    () =>
      reading
        ? calculateRateWorksheet({
            sizeGho,
            borrowApy: reading.borrowApy,
            yieldApy: reading.yieldApy,
            borrowShockPp,
          })
        : null,
    [reading, sizeGho, borrowShockPp],
  )
  const barMaximum = reading
    ? Math.max(Math.abs(reading.borrowApy), Math.abs(reading.yieldApy), 0.01)
    : 1

  return (
    <Box
      as="section"
      aria-labelledby="gho-decision-title"
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      pt={SPACING.lg}
      mb={SPACING.lg}
    >
      <Flex justify="space-between" align="start" gap={SPACING.lg} flexWrap="wrap">
        <Box maxW="640px">
          <Text
            id="gho-decision-title"
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h3}
            color={SEMANTIC_COLORS.textPrimary}
          >
            Test a GHO carry size
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mt={SPACING.xs}
          >
            Aave GHO borrowing into sGHO. See what the rate gap means at your size before comparing
            exit evidence.
          </Text>
        </Box>
        {readingLabel && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
          >
            {readingLabel}
          </Text>
        )}
      </Flex>

      <Flex mt={SPACING.lg} gap={SPACING.xl} align="stretch" flexWrap="wrap">
        <Box minW="220px" flex="1 1 220px">
          <Text
            as="label"
            htmlFor="gho-decision-size"
            display="block"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
          >
            GHO principal to test
          </Text>
          <Flex align="center" gap={SPACING.sm} mt={SPACING.sm}>
            <Input
              id="gho-decision-size"
              value={sizeInput}
              onChange={(event) => setSizeInput(event.target.value)}
              aria-invalid={!sizeValid}
              aria-describedby={!sizeValid ? 'gho-decision-size-error' : undefined}
              inputMode="decimal"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="18px"
              color={SEMANTIC_COLORS.textPrimary}
              bg={SEMANTIC_COLORS.bgTertiary}
              borderColor={SEMANTIC_COLORS.borderStrong}
              borderRadius={0}
              maxW="170px"
              _focusVisible={{ boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.success}` }}
            />
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              GHO
            </Text>
          </Flex>
          {!sizeValid && (
            <Text
              id="gho-decision-size-error"
              role="status"
              mt={SPACING.sm}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.danger}
            >
              Enter a valid GHO amount to see the rate illustration.
            </Text>
          )}
          {sizeValid && reading && !result && (
            <Text
              role="status"
              mt={SPACING.sm}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.danger}
            >
              This rate reading cannot be used for an illustration.
            </Text>
          )}
          <Text
            mt={SPACING.md}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
          >
            If borrowing costs rise:
          </Text>
          <Flex
            role="group"
            aria-label="Borrow-rate stress"
            mt={SPACING.sm}
            gap={SPACING.sm}
            flexWrap="wrap"
          >
            {([0, 1, 2] as const).map((shock) => (
              <Box
                key={shock}
                as="button"
                type="button"
                aria-pressed={borrowShockPp === shock}
                onClick={() => setBorrowShockPp(shock)}
                px={SPACING.md}
                py={SPACING.sm}
                minH="44px"
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderStrong}
                borderRadius={0}
                bg={
                  borrowShockPp === shock ? SEMANTIC_COLORS.bgTertiary : SEMANTIC_COLORS.bgSecondary
                }
                color={SEMANTIC_COLORS.textPrimary}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                cursor="pointer"
                transition="box-shadow 0.15s ease-out, background-color 0.15s ease-out"
                _hover={{ boxShadow: '0 4px 6px hsla(0,0%,0%,.2)' }}
                _active={{ boxShadow: `inset 0 0 0 1px ${SEMANTIC_COLORS.success}` }}
                _focusVisible={{ boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.success}` }}
              >
                {shock === 0 ? 'Current' : `+${shock} pp`}
              </Box>
            ))}
          </Flex>
        </Box>

        <Box flex="2 1 300px" minW={0}>
          <Flex justify="space-between" gap={SPACING.md}>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              sGHO trailing 7-day yield
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textPrimary}
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {reading ? formatApy(reading.yieldApy) : 'Not measured'}
            </Text>
          </Flex>
          <Box h="6px" bg={SEMANTIC_COLORS.bgTertiary} mt={SPACING.xs}>
            {reading && (
              <Box
                h="full"
                w={`${(Math.abs(reading.yieldApy) / barMaximum) * 100}%`}
                bg={reading.yieldApy >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}
              />
            )}
          </Box>
          <Flex justify="space-between" gap={SPACING.md} mt={SPACING.md}>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              Current Aave GHO borrow cost
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textPrimary}
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {reading ? formatApy(reading.borrowApy) : 'Not measured'}
            </Text>
          </Flex>
          <Box h="6px" bg={SEMANTIC_COLORS.bgTertiary} mt={SPACING.xs}>
            {reading && (
              <Box
                h="full"
                w={`${Math.max(0, reading.borrowApy / barMaximum) * 100}%`}
                bg={SEMANTIC_COLORS.textPrimary}
              />
            )}
          </Box>
          <Flex
            mt={SPACING.lg}
            justify="space-between"
            align="baseline"
            gap={SPACING.md}
            flexWrap="wrap"
          >
            <Box>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                {borrowShockPp === 0
                  ? 'Annualized rate gap at this size'
                  : `If borrow cost rises ${borrowShockPp} pp`}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.h3}
                color={
                  result && result.shockedAnnualNetGho >= 0
                    ? SEMANTIC_COLORS.success
                    : SEMANTIC_COLORS.danger
                }
                title={result ? formatGhoFull(result.shockedAnnualNetGho) : undefined}
                aria-label={
                  result
                    ? `Rate-only annual gap ${formatGhoFull(result.shockedAnnualNetGho)}`
                    : undefined
                }
                sx={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {result
                  ? formatGho(result.shockedAnnualNetGho)
                  : reading
                    ? 'No valid illustration'
                    : 'No rate reading'}
              </Text>
            </Box>
            {result && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
                sx={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {borrowShockPp > 0
                  ? `Stressed rate gap ${result.shockedSpreadPp >= 0 ? '+' : ''}${result.shockedSpreadPp.toFixed(2)} pp`
                  : result.breakEvenHeadroomPp >= 0
                    ? `${result.breakEvenHeadroomPp.toFixed(2)} pp of borrow-rate headroom`
                    : `Rate gap already ${Math.abs(result.breakEvenHeadroomPp).toFixed(2)} pp below break-even`}
              </Text>
            )}
          </Flex>
        </Box>
      </Flex>

      <Box
        borderTop="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        pt={SPACING.base}
        mt={SPACING.lg}
      >
        <Flex justify="space-between" align="baseline" gap={SPACING.md} flexWrap="wrap">
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
          >
            Vault-side sGHO redemption ceiling · last reading
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.body}
            color={SEMANTIC_COLORS.textPrimary}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {vaultRedeemCeilingGho === null ? 'Not measured' : formatCeiling(vaultRedeemCeilingGho)}
          </Text>
        </Flex>
        <Text
          mt={SPACING.xs}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={
            cashReading?.withdrawalsPaused ||
            (sizeValid && vaultRedeemCeilingGho !== null && sizeGho > vaultRedeemCeilingGho)
              ? SEMANTIC_COLORS.warning
              : SEMANTIC_COLORS.textSecondary
          }
        >
          {vaultRedeemCeilingGho === null
            ? 'No complete cash-and-pause redemption reading yet.'
            : cashReading?.withdrawalsPaused
              ? 'Vault withdrawals were paused at the last measurement.'
              : !sizeValid
                ? 'Enter a GHO size to compare with the measured ceiling.'
                : sizeGho > vaultRedeemCeilingGho
                  ? 'Your tested size exceeds the measured vault-side redemption ceiling.'
                  : 'Your tested size is below the measured vault-side redemption ceiling.'}
        </Text>
        <Text
          mt={SPACING.xs}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          {cashLabel ? `${cashLabel} · ` : ''}Zero while paused; otherwise the lower of GHO cash and
          totalAssets. sGHO redeems directly to GHO; this is not your maxRedeem or a guaranteed
          withdrawal. Cash and pause status can change before the next reading.
        </Text>
      </Box>

      <Box
        borderTop="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        pt={SPACING.base}
        mt={SPACING.lg}
      >
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h4}
          color={SEMANTIC_COLORS.textPrimary}
        >
          Check a wallet’s sGHO exit
        </Text>
        <Text
          mt={SPACING.xs}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
        >
          Enter a wallet to check its redemption limit at one finalized Ethereum block. No wallet
          connection is needed. This does not establish how the wallet acquired its sGHO.
        </Text>
        <Flex
          as="form"
          onSubmit={checkWalletExit}
          mt={SPACING.md}
          gap={SPACING.sm}
          align="end"
          flexWrap="wrap"
        >
          <Box flex="1 1 300px" minW={0}>
            <Text
              as="label"
              htmlFor="sgho-exit-wallet"
              display="block"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              Ethereum wallet address
            </Text>
            <Input
              id="sgho-exit-wallet"
              value={walletInput}
              onChange={(event) => {
                walletExitRequest.current?.abort()
                setWalletInput(event.target.value)
                setWalletExit({ status: 'idle' })
              }}
              mt={SPACING.xs}
              maxW="520px"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textPrimary}
              bg={SEMANTIC_COLORS.bgTertiary}
              borderColor={SEMANTIC_COLORS.borderStrong}
              borderRadius={0}
              _focusVisible={{ boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.success}` }}
            />
          </Box>
          <Box
            as="button"
            type="submit"
            disabled={walletExit.status === 'loading'}
            px={SPACING.md}
            py={SPACING.sm}
            minH="44px"
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            borderRadius={0}
            bg={SEMANTIC_COLORS.bgSecondary}
            color={SEMANTIC_COLORS.textPrimary}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            cursor="pointer"
            transition="box-shadow 0.15s ease-out"
            _hover={{ boxShadow: '0 4px 6px hsla(0,0%,0%,.2)' }}
            _active={{ boxShadow: `inset 0 0 0 1px ${SEMANTIC_COLORS.success}` }}
            _focus={{ outline: 'none' }}
            _focusVisible={{ boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.success}` }}
            _disabled={{ opacity: 0.5, cursor: 'wait' }}
          >
            {walletExit.status === 'loading' ? 'Checking…' : 'Check wallet exit'}
          </Box>
        </Flex>
        {walletExit.status === 'error' && (
          <Text
            role="alert"
            mt={SPACING.sm}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.danger}
          >
            {walletExit.message}
          </Text>
        )}
        {walletExit.status === 'ready' && (
          <Box role="status" mt={SPACING.md}>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
              overflowWrap="anywhere"
            >
              Wallet checked: {walletExit.address}
            </Text>
            <Flex justify="space-between" align="baseline" gap={SPACING.md} flexWrap="wrap">
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                Wallet withdrawal limit at measured block
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.body}
                color={
                  walletExit.reading.vault.withdrawalsPaused
                    ? SEMANTIC_COLORS.warning
                    : SEMANTIC_COLORS.textPrimary
                }
                sx={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {walletExit.reading.vault.withdrawalsPaused
                  ? '0 GHO'
                  : formatWalletGho(walletExit.reading.position.effectiveExitGho)}
              </Text>
            </Flex>
            <Text
              mt={SPACING.xs}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {walletExit.reading.vault.withdrawalsPaused
                ? 'Vault withdrawals were paused at this block.'
                : walletSizeWithinLimit !== null
                  ? walletSizeWithinLimit
                    ? 'Your tested GHO size was within this wallet’s measured withdrawal limit.'
                    : 'Your tested GHO size exceeded this wallet’s measured withdrawal limit.'
                  : 'Enter a GHO size above to compare it with this wallet’s limit.'}
            </Text>
            <Text
              mt={SPACING.xs}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textTertiary}
            >
              {formatWalletGho(walletExit.reading.position.previewRedeemGho)} preview from
              redeemable shares · block{' '}
              {walletExit.reading.source.blockNumber.toLocaleString('en-US')} at{' '}
              {new Date(walletExit.reading.source.blockTime).toLocaleString()} ·{' '}
              {Math.ceil(walletExit.reading.source.ageSeconds / 60)} minutes old when checked. This
              is an indicative read, not a guaranteed withdrawal.
            </Text>
          </Box>
        )}
      </Box>

      <Flex
        borderTop="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        pt={SPACING.base}
        mt={SPACING.lg}
        justify="space-between"
        align="start"
        gap={SPACING.lg}
        flexWrap="wrap"
      >
        <Text
          maxW="620px"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
        >
          Rate-only arithmetic if today’s borrow APY and trailing yield persisted for one year. It
          excludes fees and GHO price changes. The vault-side ceiling is a size checkpoint, not a
          user-specific executable redemption quote.
        </Text>
        <NextLink href={`/${chainName}/radar`}>
          <Text
            as="span"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textPrimary}
            textDecoration="underline"
            textUnderlineOffset="3px"
          >
            Scan a wallet’s tracked venues ↗
          </Text>
        </NextLink>
      </Flex>
    </Box>
  )
}

export default DecisionWorksheet
