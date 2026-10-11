import React, { useRef, useState } from 'react'
import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { calculateDiscoDecisionWindow } from '@/lib/carry/curatorScenario'
import type { DiscoDecisionSnapshot } from '@/lib/disco/decisionSnapshot'

const DEPOSIT_KEY_RE = /^0x[0-9a-fA-F]{64}$/

const parseDays = (value: string) => (/^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN)
const formatDays = (value: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)
const formatOffset = (days: number) => {
  const seconds = Math.abs(days) * 86_400
  const [value, unit]: [number, string] =
    seconds < 60
      ? [seconds, 'second']
      : seconds < 3_600
        ? [seconds / 60, 'minute']
        : seconds < 86_400
          ? [seconds / 3_600, 'hour']
          : [Math.abs(days), 'day']
  const formatted = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value)
  return `${formatted} ${unit}${Math.abs(value - 1) < 1e-9 ? '' : 's'}`
}
const relativeDay = (value: number) =>
  value === 0 ? 'today' : value > 0 ? `in ${formatOffset(value)}` : `${formatOffset(value)} ago`
const formatUtc = (seconds: number | string) => {
  const date = new Date(Number(seconds) * 1000)
  if (!Number.isFinite(date.getTime())) return 'invalid timestamp'
  return (
    date.toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }) + ' UTC'
  )
}

/** Deliberately user-assumed until a deployed Disco config and position can be read. */
export default function CuratorScenarioDisco() {
  const [depositKey, setDepositKey] = useState('')
  const [snapshot, setSnapshot] = useState<DiscoDecisionSnapshot | null>(null)
  const [snapshotStatus, setSnapshotStatus] = useState(
    'Local Anvil deposit only. Mainnet Disco is unavailable until its deployment is verified.',
  )
  const [loading, setLoading] = useState(false)
  const request = useRef<AbortController | null>(null)
  const [horizonInput, setHorizonInput] = useState('')
  const [waitInput, setWaitInput] = useState('')
  const [windowInput, setWindowInput] = useState('')
  const horizon = parseDays(horizonInput)
  const wait = parseDays(waitInput)
  const window = parseDays(windowInput)
  const result = calculateDiscoDecisionWindow({
    daysUntilNeeded: horizon,
    configuredWaitDays: wait,
    executionWindowDays: window,
  })
  const liveRequestBy =
    snapshot && Number.isFinite(horizon) && horizon >= 0 && horizon <= 3650
      ? Number(snapshot.blockTimestamp) +
        horizon * 86_400 -
        Number(snapshot.ltvSwitchingPeriodSeconds)
      : null

  const readDeposit = async () => {
    if (!DEPOSIT_KEY_RE.test(depositKey.trim())) {
      setSnapshotStatus('Enter a 0x-prefixed, 32-byte deposit ID.')
      return
    }
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setSnapshot(null)
    setSnapshotStatus('Reading a finalized local-chain block…')
    try {
      const response = await fetch('/api/disco/decision-snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId: 31337, depositKey: depositKey.trim() }),
        signal: controller.signal,
      })
      if (!response.ok) {
        setSnapshotStatus(
          response.status === 404
            ? 'No deposit exists at that ID on the finalized local-chain block.'
            : 'A local-chain snapshot is unavailable. No live countdown is shown.',
        )
        return
      }
      const data = (await response.json()) as DiscoDecisionSnapshot
      if (
        data.chainId !== 31337 ||
        data.depositKey.toLowerCase() !== depositKey.trim().toLowerCase()
      )
        throw new Error('Unexpected snapshot')
      setSnapshot(data)
      setSnapshotStatus('ABI-readable local-chain deposit snapshot; contract identity not attested')
    } catch (error) {
      if (controller.signal.aborted) return
      setSnapshotStatus('A local-chain snapshot is unavailable. No live countdown is shown.')
    } finally {
      if (request.current === controller) setLoading(false)
    }
  }

  return (
    <Box
      as="details"
      mt={SPACING.lg}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      p={SPACING.base}
    >
      <Box
        as="summary"
        cursor="pointer"
        minH="44px"
        display="flex"
        alignItems="center"
        color={SEMANTIC_COLORS.textPrimary}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        _focusVisible={{ boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.textPrimary}` }}
      >
        Inspect local Disco intent timing
      </Box>
      <Box
        mt={SPACING.md}
        p={SPACING.md}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
      >
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          color={SEMANTIC_COLORS.textPrimary}
        >
          Local deposit state · chain 31337
        </Text>
        <Text
          mt={SPACING.sm}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
        >
          Paste a local deposit ID to read the configured address’s wait and linked intent at one
          finalized block. This is not deployment or wallet ownership proof, or a transaction.
        </Text>
        <Flex mt={SPACING.md} gap={SPACING.sm} flexWrap="wrap">
          <Input
            aria-label="Disco deposit ID"
            value={depositKey}
            onChange={(event) => {
              request.current?.abort()
              setDepositKey(event.target.value)
              setSnapshot(null)
              setSnapshotStatus('Enter a local-chain deposit ID to check its state.')
            }}
            placeholder="0x… 32-byte deposit ID"
            fontSize="16px"
            fontFamily={TYPOGRAPHY.fontMono}
            color={SEMANTIC_COLORS.textPrimary}
            bg={SEMANTIC_COLORS.bgTertiary}
            borderColor={SEMANTIC_COLORS.borderStrong}
            borderRadius={0}
            flex="1 1 240px"
            _focusVisible={{ boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.textPrimary}` }}
          />
          <Button
            onClick={readDeposit}
            isDisabled={loading || !DEPOSIT_KEY_RE.test(depositKey.trim())}
            borderRadius={0}
            color={SEMANTIC_COLORS.textPrimary}
            bg={SEMANTIC_COLORS.bgTertiary}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            _hover={{ boxShadow: '0 7px 16px rgba(0,0,0,.24)', transform: 'translateY(-2px)' }}
            _active={{ transform: 'translateY(0)', boxShadow: 'none' }}
            _focus={{ borderColor: SEMANTIC_COLORS.borderStrong }}
            _focusVisible={{ boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.textPrimary}` }}
          >
            {loading ? 'Reading…' : 'Read deposit'}
          </Button>
        </Flex>
        <Text
          role="status"
          mt={SPACING.sm}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
        >
          {snapshotStatus}
        </Text>
        {snapshot && (
          <Box
            mt={SPACING.md}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textPrimary}
          >
            <Text>
              Reported lower-LTV wait:{' '}
              {formatDays(Number(snapshot.ltvSwitchingPeriodSeconds) / 86_400)} days · execution
              window: {formatDays(Number(snapshot.executionWindowSeconds) / 86_400)} days.
            </Text>
            <Text mt={SPACING.sm} color={SEMANTIC_COLORS.textSecondary}>
              Current config applies to new requests. An existing linked intent keeps its recorded
              unlock and expiry. The contract can replace this deposit’s intent pointer; this view
              cannot enumerate older active intents.
            </Text>
            <Text mt={SPACING.sm}>Deposit owner: {snapshot.depositOwner}</Text>
            {snapshot.intent ? (
              <Text mt={SPACING.sm}>
                Linked intent #{snapshot.intent.id}:{' '}
                {snapshot.intent.phase === 'waiting'
                  ? 'pending until'
                  : snapshot.intent.phase === 'executable'
                    ? 'execution window open until'
                    : 'window expired at'}{' '}
                {formatUtc(
                  snapshot.intent.phase === 'waiting'
                    ? snapshot.intent.unlockTime
                    : snapshot.intent.expireTime,
                )}
                . Unlock {formatUtc(snapshot.intent.unlockTime)} · expiry{' '}
                {formatUtc(snapshot.intent.expireTime)}.
              </Text>
            ) : (
              <Text mt={SPACING.sm}>
                No intent at this deposit’s current pointer at this block. Older active requests
                cannot be ruled out here.
              </Text>
            )}
            {liveRequestBy !== null && !snapshot.intent && (
              <Text mt={SPACING.sm}>
                With your assumed need in {formatDays(horizon)} days, illustrative request-by{' '}
                {formatUtc(liveRequestBy)} to reach the configured wait. This date is planning
                arithmetic, not an active intent or a promise of execution.
              </Text>
            )}
            <Text mt={SPACING.sm} color={SEMANTIC_COLORS.textSecondary}>
              On this local contract, executing a lower-LTV intent records an event but does not
              update an on-chain deposit slot or its totals. Do not treat its window as a completed
              allocation change.
            </Text>
            <Text mt={SPACING.sm} color={SEMANTIC_COLORS.textSecondary}>
              Source: configured local address {snapshot.discoAddress} · finalized block{' '}
              {snapshot.blockNumber} ({snapshot.blockHash.slice(0, 10)}…) ·{' '}
              {formatUtc(snapshot.blockTimestamp)}. State can change after this block. Code was
              present and ABI-readable, but its deployment identity was not independently attested.
            </Text>
          </Box>
        )}
      </Box>
      <Text
        mt={SPACING.md}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
        maxW="75ch"
      >
        Calendar-only hypothetical planner: enter a need horizon, assumed wait and execution-window
        length. These assumptions remain separate from the Anvil-only finalized-block snapshot
        above.
      </Text>
      <Flex gap={SPACING.md} flexWrap="wrap" mt={SPACING.md}>
        <Box flex="1 1 200px">
          <Text
            as="label"
            htmlFor="disco-horizon-days"
            display="block"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mb={SPACING.sm}
          >
            Days until lower LTV might be needed
          </Text>
          <Input
            id="disco-horizon-days"
            type="text"
            inputMode="decimal"
            value={horizonInput}
            onChange={(event) => setHorizonInput(event.target.value)}
            placeholder="Your assumption"
            fontSize="16px"
            fontFamily={TYPOGRAPHY.fontMono}
            color={SEMANTIC_COLORS.textPrimary}
            bg={SEMANTIC_COLORS.bgTertiary}
            borderColor={SEMANTIC_COLORS.borderStrong}
            borderRadius={0}
            _focus={{ borderColor: SEMANTIC_COLORS.borderStrong, boxShadow: 'none' }}
            _focusVisible={{ boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.textPrimary}` }}
          />
        </Box>
        <Box flex="1 1 200px">
          <Text
            as="label"
            htmlFor="disco-config-wait-days"
            display="block"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mb={SPACING.sm}
          >
            Assumed lower-LTV wait, in days
          </Text>
          <Input
            id="disco-config-wait-days"
            type="text"
            inputMode="decimal"
            value={waitInput}
            onChange={(event) => setWaitInput(event.target.value)}
            placeholder="Verify onchain"
            fontSize="16px"
            fontFamily={TYPOGRAPHY.fontMono}
            color={SEMANTIC_COLORS.textPrimary}
            bg={SEMANTIC_COLORS.bgTertiary}
            borderColor={SEMANTIC_COLORS.borderStrong}
            borderRadius={0}
            _focus={{ borderColor: SEMANTIC_COLORS.borderStrong, boxShadow: 'none' }}
            _focusVisible={{ boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.textPrimary}` }}
          />
        </Box>
        <Box flex="1 1 200px">
          <Text
            as="label"
            htmlFor="disco-execution-window-days"
            display="block"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mb={SPACING.sm}
          >
            Assumed execution window, in days
          </Text>
          <Input
            id="disco-execution-window-days"
            type="text"
            inputMode="decimal"
            value={windowInput}
            onChange={(event) => setWindowInput(event.target.value)}
            placeholder="Verify onchain"
            fontSize="16px"
            fontFamily={TYPOGRAPHY.fontMono}
            color={SEMANTIC_COLORS.textPrimary}
            bg={SEMANTIC_COLORS.bgTertiary}
            borderColor={SEMANTIC_COLORS.borderStrong}
            borderRadius={0}
            _focus={{ borderColor: SEMANTIC_COLORS.borderStrong, boxShadow: 'none' }}
            _focusVisible={{ boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.textPrimary}` }}
          />
        </Box>
      </Flex>
      {result ? (
        <Box
          role="status"
          mt={SPACING.md}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          color={SEMANTIC_COLORS.textPrimary}
        >
          <Text>
            Earliest useful request: {relativeDay(result.earliestUsefulRequestInDays)} · latest
            request: {relativeDay(result.latestRequestInDays)}.
          </Text>
          <Text mt={SPACING.sm}>
            {result.todayStatus === 'early'
              ? 'Today is too early: a request now would expire before your target date.'
              : result.todayStatus === 'too-late'
                ? 'Today is too late: a request now would not unlock by your target date.'
                : 'Today is inside the hypothetical request interval.'}
          </Text>
          <Text mt={SPACING.sm} color={SEMANTIC_COLORS.textSecondary}>
            If requested today, the assumed eligibility window is{' '}
            {relativeDay(result.eligibilityStartsInDays)} through{' '}
            {relativeDay(result.eligibilityEndsInDays)}. A zero-length window is one exact instant;
            exact endpoints leave no buffer for execution.
          </Text>
        </Box>
      ) : (
        <Text
          role="status"
          mt={SPACING.md}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
        >
          Enter all three valid values to calculate a hypothetical request interval.
        </Text>
      )}
      <Text
        mt={SPACING.sm}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
        maxW="90ch"
      >
        This is calendar arithmetic for a lower-LTV request, not a verified effective slot or totals
        move, asset-change timing, or an executable quote. It omits unstaking, pending intents and
        future config changes. No transaction is queued by this tool.
      </Text>
    </Box>
  )
}
