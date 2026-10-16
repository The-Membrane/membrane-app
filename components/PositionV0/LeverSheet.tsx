// THE ORDER SLIP (owner ruling T31: signing surfaces are a ledger slip on the same paper).
// A lever row opens it in place: a centred modal on a desktop, a bottom sheet on a phone.
// It never sends the reader to the venue's app (owner, 2026-10-16: "think Bloomberg").
//
//   kicker   ORDER SLIP · AAVE V3                                   stamp (DRAFT → SETTLED)
//   head     If you repay 460 USDC          (re-solved now; "was 480 USDC" when it moved)
//   rows     brought forward → carried forward: liquidation price, distance, chance †
//   balance  the owner's balance of the token
//   steps    every call the wallet will show: contract, function, exact units
//   gas      the simulation's gas with the pipeline's 5% buffer, and its fee ceiling
//   checks   venue, balance, wallet, owner, chain, simulation — each named
//   credit   the re-read's block and time, its source, the simulation method
//   commit   one button in a dashed frame (a dashed edge leads to a signature)
//
// Numbers are JetBrains Mono (T31); only the headline is Redaction. Until the re-read lands
// the slip shows only the clicked row's own words; every figure after that comes from the
// re-read (useLeverExec), none from the page's earlier read.

import React from 'react'
import {
  Box,
  Button,
  Link,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
} from '@chakra-ui/react'
import { formatEther } from 'viem'
import { mainnet } from 'viem/chains'

import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { getTxExplorerUrl } from '@/helpers/explorer'
import { fmtUnits } from '@/lib/position-exec/amount'
import type { Check } from '@/lib/position-exec/sheet'
import type { SimResult } from '@/lib/position-exec/simulate'
import { fmtAmount, fmtInt, fmtUtc } from '@/lib/position/format'

import { PROTOCOL_SHORT } from './viewModel'
import { Kicker, Mono, Rule, Small, StaleTag } from './primitives'
import { slipRows, stepsOf, type LeverIntent, type PreparedLever } from './leverExec'
import { CAPS, TYPE } from './typeScale'
import { useLeverExec } from './useLeverExec'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const GLYPH = (ok: boolean | null) => (ok === null ? '○' : ok ? '●' : '✖')

/** label · before → after, one line; the after column never wraps under the label on a phone. */
const Line: React.FC<{ label: string; before?: string | null; after: string }> = ({
  label,
  before,
  after,
}) => (
  <Box
    display="grid"
    gridTemplateColumns={{ base: '1fr', sm: 'minmax(0, 1fr) auto' }}
    columnGap={SPACING.sm}
    py={SPACING.xs}
    borderBottom={`1px solid ${NEWS.rule}`}
    minW={0}
  >
    <Small color={NEWS.ink2}>{label}</Small>
    <Mono textAlign={{ base: 'left', sm: 'right' }} overflowWrap="anywhere">
      {before ? `${before} → ` : ''}
      <b>{after}</b>
    </Mono>
  </Box>
)

function gasLine(sim: SimResult | null): string | null {
  if (!sim || !sim.ok) return null
  const fee =
    sim.maxFeePerGas !== null
      ? ` · ≤ ${Number(formatEther(sim.bufferedGas * sim.maxFeePerGas)).toPrecision(3)} ETH`
      : ''
  const waits = sim.gas.some((g) => g === null)
    ? ' · + the action, estimated once the approve lands'
    : ''
  return `${fmtInt(Number(sim.bufferedGas))} gas${fee}${waits}`
}

const Ready: React.FC<{ p: PreparedLever; intent: LeverIntent; sim: SimResult | null }> = ({
  p,
  intent,
  sim,
}) => {
  const shown = fmtAmount(p.row.amount, p.row.amountDecimals)
  const steps = stepsOf(p.calls, {
    protocol: intent.protocol,
    kind: p.row.kind,
    symbol: p.leg.symbol,
    shown,
  })
  const gas = gasLine(sim)
  return (
    <Box display="grid" gap={SPACING.sm} minW={0}>
      <Box minW={0}>
        {slipRows(p.view, p.row, intent.horizon, intent.stale).map((r) => (
          <Line key={r.label} label={r.label} before={r.before} after={r.after} />
        ))}
        <Line
          label={`${p.leg.symbol} balance · ${short(intent.owner)}`}
          after={fmtUnits(p.read.balance, p.read.decimals, Math.max(2, p.row.amountDecimals))}
        />
        {intent.stale && (
          <Small pt={SPACING.xs}>
            <StaleTag /> · chances withheld
          </Small>
        )}
      </Box>

      <Box minW={0}>
        <Kicker tone="muted">Steps · {steps.length}</Kicker>
        {steps.map((s, i) => (
          <Box
            key={i}
            display="grid"
            gridTemplateColumns="1.5em minmax(0, 1fr)"
            py={SPACING.xs}
            borderBottom={`1px solid ${NEWS.rule}`}
          >
            <Mono>{i + 1}</Mono>
            <Box minW={0}>
              <Mono>{s.title}</Mono>
              <Small overflowWrap="anywhere">{s.detail}</Small>
            </Box>
          </Box>
        ))}
        {gas && <Line label="Gas, est." after={gas} />}
      </Box>
    </Box>
  )
}

const Checks: React.FC<{ checks: Check[] }> = ({ checks }) => (
  <Box minW={0}>
    <Kicker tone="muted">Checks</Kicker>
    <Box as="ul" listStyleType="none" m={0} p={0}>
      {checks.map((c) => (
        <Box as="li" key={c.id} display="grid" gridTemplateColumns="1.5em minmax(0, 1fr)">
          <Mono aria-hidden>{GLYPH(c.ok)}</Mono>
          <Mono
            fontWeight={c.ok === false ? 700 : 400}
            color={c.ok === false ? NEWS.ink : NEWS.ink2}
            overflowWrap="anywhere"
          >
            <Box as="span" srOnly>
              {c.ok === null ? 'pending: ' : c.ok ? 'passes: ' : 'blocked: '}
            </Box>
            {c.text}
          </Mono>
        </Box>
      ))}
    </Box>
  </Box>
)

const BUTTON = {
  borderRadius: 0,
  minH: '44px',
  h: 'auto',
  py: SPACING.sm,
  px: SPACING.base,
  fontFamily: NEWS_FONT.mono,
  fontSize: TYPE.body,
  fontWeight: 700,
  whiteSpace: 'normal',
  transition: TRANSITIONS.colors,
  _focusVisible: FOCUS_STYLES.ring,
  ...CAPS,
} as const

export const LeverSheet: React.FC<{
  intent: LeverIntent
  onClose: () => void
  /** Connect, keeping this intent: the page re-opens this slip once the wallet connects. */
  onConnect: () => void
  /** The page's position read, refreshed after a settled transaction. */
  onSettled: () => void
}> = ({ intent, onClose, onConnect, onSettled }) => {
  const exec = useLeverExec(intent, onSettled)
  const { sheet, prepared } = exec
  const ready = prepared?.kind === 'ready' ? prepared : null
  const venue = PROTOCOL_SHORT[intent.protocol]
  const busy = exec.busy
  const head = ready ? ready.row.action : intent.row.action
  const hash = exec.txHash
  const commit = sheet.button.kind === 'sign'

  const onButton = () => {
    switch (sheet.button.kind) {
      case 'connect':
        return onConnect()
      case 'switch':
        return exec.switchChain()
      case 'sign':
        return exec.sign()
      case 'retry':
        return exec.retry()
      case 'close':
        return onClose()
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      closeOnOverlayClick={!busy}
      closeOnEsc={!busy}
      motionPreset="slideInBottom"
      scrollBehavior="inside"
    >
      <ModalOverlay bg="var(--m-overlay)" />
      <ModalContent
        containerProps={{ alignItems: { base: 'flex-end', md: 'center' } }}
        data-testid="lever-sheet"
        bg={NEWS.card}
        color={NEWS.ink}
        border={`2px solid ${NEWS.ink}`}
        borderRadius={0}
        boxShadow="none"
        w="100%"
        maxW={{ base: '100%', md: '520px' }}
        my={{ base: 0, md: SPACING.base }}
        mx={{ base: 0, md: SPACING.base }}
        maxH={{ base: '92vh', md: '88vh' }}
      >
        <ModalHeader
          px={SPACING.base}
          pt={SPACING.base}
          pb={SPACING.sm}
          pr={SPACING['2xl']}
          fontWeight={400}
        >
          <Box display="flex" flexWrap="wrap" justifyContent="space-between" columnGap={SPACING.sm}>
            <Kicker>Order slip · {venue}</Kicker>
            <Kicker as="span" color={NEWS.ink} aria-live="polite" data-testid="lever-stamp">
              {sheet.stamp}
            </Kicker>
          </Box>
          <Box
            as="span"
            display="block"
            fontFamily={NEWS_FONT.display}
            fontWeight={700}
            fontSize={TYPE.head}
            lineHeight={1.2}
            color={NEWS.ink}
            mt={SPACING.xs}
          >
            {head}
          </Box>
          <Small as="span" display="block" fontWeight={400}>
            {intent.title}
            {ready?.changed
              ? ` · re-solved now, was ${fmtAmount(intent.row.amount, intent.row.amountDecimals)} ${intent.row.symbol}`
              : ''}
          </Small>
        </ModalHeader>
        <ModalCloseButton
          aria-label="Close the order slip"
          isDisabled={busy}
          w="44px"
          h="44px"
          top={SPACING.xs}
          right={SPACING.xs}
          borderRadius={0}
          color={NEWS.ink}
          _focusVisible={FOCUS_STYLES.ring}
        />

        <ModalBody px={SPACING.base} py={0} display="grid" gap={SPACING.base} minW={0}>
          <Rule strong />
          {ready ? (
            <Ready p={ready} intent={intent} sim={exec.sim} />
          ) : (
            !sheet.notice && <Mono color={NEWS.ink2}>Reading {venue} at the latest block…</Mono>
          )}
          {sheet.checks.length > 0 && prepared?.kind !== 'gone' && <Checks checks={sheet.checks} />}
          {ready && (
            <Small textAlign="right" overflowWrap="anywhere">
              Read {ready.block !== null ? `block ${fmtInt(ready.block)} · ` : ''}
              {fmtUtc(ready.at)} · {ready.source}
              {exec.sim ? ` · simulated with ${exec.sim.method}` : ''}
              {ready.view.forecast && !intent.stale ? ` · ${ready.view.forecast.footer}` : ''}
            </Small>
          )}
        </ModalBody>

        <ModalFooter
          px={SPACING.base}
          pt={SPACING.base}
          pb={SPACING.lg}
          display="grid"
          gap={SPACING.sm}
          justifyContent="stretch"
        >
          {sheet.notice && (
            <Mono fontWeight={700} role="status" overflowWrap="anywhere">
              ✖ {sheet.notice}
            </Mono>
          )}
          {hash && (
            <Mono overflowWrap="anywhere">
              Transaction {short(hash)} ·{' '}
              <Link
                href={getTxExplorerUrl(mainnet, hash)}
                isExternal
                color={NEWS.accent}
                _focusVisible={FOCUS_STYLES.ring}
              >
                Etherscan ↗
              </Link>
            </Mono>
          )}
          {sheet.stamp === 'SETTLED' && <Small>Position read again from the chain.</Small>}
          {/* A dashed edge leads to a signature (T31). */}
          <Box border={`1px dashed ${commit ? NEWS.ink : NEWS.ruleStrong}`} p={SPACING.xs}>
            <Button
              {...BUTTON}
              w="100%"
              onClick={onButton}
              isDisabled={!sheet.button.enabled}
              data-testid="lever-button"
              bg={commit ? NEWS.cta : 'transparent'}
              color={commit ? NEWS.onCta : NEWS.ink}
              border={commit ? 'none' : `1px solid ${NEWS.ink}`}
              _hover={{ bg: commit ? NEWS.cta : NEWS.raised }}
              _disabled={{
                opacity: 1,
                cursor: 'not-allowed',
                color: NEWS.muted,
                borderColor: NEWS.rule,
                bg: 'transparent',
              }}
            >
              {sheet.button.label}
            </Button>
          </Box>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
