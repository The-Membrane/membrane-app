// THE ORDER SLIP (owner ruling T31: signing surfaces are a ledger slip on the same paper,
// with a counterfoil). A lever row opens it in place: a centred modal on a desktop, a
// bottom sheet on a phone. It never sends the reader to the venue's app ("think Bloomberg").
//
//   head        ORDER SLIP · AAVE V3                                         [ STAMP ]
//               If you repay  760 USDT          words in Redaction, the figure in Mono
//   ledger      brought forward → carried forward: price, distance, chance †, balance
//   authorised  the exact approval and its spender, when the batch approves (solid box)
//   steps       every call the wallet will show: contract, function, exact units; gas
//   checks      venue, balance, wallet, owner, chain, simulation — each named, with a glyph
//   counterfoil after the first signature, behind a perforation: the stamp's story, the
//               transaction, "still waiting", what stands after a partial run
//   commit      one button in a dashed frame (a dashed edge leads to a signature); a
//               button that acts (sign, connect, switch, retry) is raised: CTA fill and
//               the hard print shadow NEWS.shadowRaised, label centred
//
// Every figure is JetBrains Mono (T31, CLAUDE.md rule 3); Redaction sets only the headline
// words. Colour carries a glyph (DESIGN_RULES §2): red only for a failure that cost gas or
// did not happen, always with ✖. `LeverSlip` is presentational (the design-states page
// renders it from fixtures); `LeverSheet` wires it to useLeverExec.

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
import type { Check, SheetView } from '@/lib/position-exec/sheet'
import type { SimResult } from '@/lib/position-exec/simulate'
import { fmtAmount, fmtInt, fmtUtc } from '@/lib/position/format'

import { PROTOCOL_SHORT } from './viewModel'
import { Kicker, Mono, Small, StaleTag } from './primitives'
import { slipRows, stepsOf, type LeverIntent, type Prepared, type PreparedLever } from './leverExec'
import { CAPS, TYPE } from './typeScale'
import { useLeverExec } from './useLeverExec'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const GLYPH = (ok: boolean | null) => (ok === null ? '○' : ok ? '●' : '✖')
const RULE = `1px solid ${NEWS.rule}`

/** Stamps that report a loss or a non-event: red, and always with ✖. */
const isRedStamp = (stamp: string) => stamp.startsWith('FAILED') || stamp === 'REPLACED'

// ------------------------------------------------------------------ pieces

const Stamp: React.FC<{ stamp: string }> = ({ stamp }) => {
  const red = isRedStamp(stamp)
  return (
    <Box
      as="span"
      data-testid="lever-stamp"
      aria-live="polite"
      display="inline-block"
      border={`1px solid ${red ? NEWS.danger : NEWS.ink}`}
      px={SPACING.xs}
      fontFamily={NEWS_FONT.mono}
      fontSize={TYPE.label}
      fontWeight={700}
      lineHeight={1.6}
      color={red ? NEWS.danger : NEWS.ink}
      whiteSpace="nowrap"
      {...CAPS}
    >
      {red ? `✖ ${stamp}` : stamp}
    </Box>
  )
}

/** "If you repay" in Redaction, "760 USDT" in Mono, one headline. */
const Headline: React.FC<{ kind: 'repay' | 'add'; amount: string; symbol: string }> = ({
  kind,
  amount,
  symbol,
}) => (
  <Box
    as="span"
    display="block"
    fontSize={TYPE.head}
    lineHeight={1.25}
    color={NEWS.ink}
    mt={SPACING.sm}
  >
    <Box as="span" fontFamily={NEWS_FONT.display} fontWeight={700}>
      If you {kind}{' '}
    </Box>
    <Box
      as="span"
      fontFamily={NEWS_FONT.mono}
      fontWeight={700}
      whiteSpace="nowrap"
      sx={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {amount} {symbol}
    </Box>
  </Box>
)

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <Box minW={0}>
    <Kicker tone="muted" pb={SPACING.xs} borderBottom={`1px solid ${NEWS.ruleStrong}`}>
      {title}
    </Kicker>
    {children}
  </Box>
)

/** One ledger line: label, now, after. A three-column table from 480px; stacked below it. */
const LedgerLine: React.FC<{ label: string; before: string | null; after: string }> = ({
  label,
  before,
  after,
}) => (
  <Box
    display="grid"
    gridTemplateColumns={{ base: '1fr', sm: 'minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr)' }}
    columnGap={SPACING.sm}
    py={SPACING.xs}
    borderBottom={RULE}
    minW={0}
  >
    <Small color={NEWS.ink2}>{label}</Small>
    <Mono
      color={NEWS.ink2}
      textAlign={{ base: 'left', sm: 'right' }}
      display={{ base: 'none', sm: 'block' }}
    >
      {before ?? '—'}
    </Mono>
    <Mono textAlign={{ base: 'left', sm: 'right' }} fontWeight={700} overflowWrap="anywhere">
      <Box as="span" display={{ base: 'inline', sm: 'none' }} fontWeight={400} color={NEWS.ink2}>
        {before ? `${before} → ` : ''}
      </Box>
      {after}
    </Mono>
  </Box>
)

const LedgerHead: React.FC = () => (
  <Box
    display={{ base: 'none', sm: 'grid' }}
    gridTemplateColumns="minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr)"
    columnGap={SPACING.sm}
    pt={SPACING.xs}
  >
    <span />
    <Small textAlign="right" {...CAPS}>
      Now
    </Small>
    <Small textAlign="right" {...CAPS}>
      After
    </Small>
  </Box>
)

function gasLine(sim: SimResult | null): string | null {
  if (!sim || !sim.ok) return null
  // An estimate at today's fee, not a ceiling: the wallet sets the fee when it signs.
  const fee =
    sim.maxFeePerGas !== null
      ? ` · about ${Number(formatEther(sim.bufferedGas * sim.maxFeePerGas)).toPrecision(2)} ETH`
      : ''
  const waits = sim.gas.some((g) => g === null)
    ? ' · + the action, estimated once the approve lands'
    : ''
  return `${fmtInt(Number(sim.bufferedGas))} gas${fee}${waits}`
}

/** The approval the batch asks for, if any: exact amount and spender (Q11 "authorised up to"). */
function authorised(p: PreparedLever, venue: string): { amount: string; spender: string } | null {
  const approve = [...p.calls]
    .reverse()
    .find((c) => c.functionName === 'approve' && (c.args?.[1] as bigint) > 0n)
  if (!approve) return null
  const [spender, units] = approve.args as readonly [string, bigint]
  const name =
    p.calls.at(-1)!.address.toLowerCase() === spender.toLowerCase() ? venue : short(spender)
  return {
    amount: `${fmtUnits(units, p.read.decimals, Math.max(2, p.row.amountDecimals))} ${p.leg.symbol}`,
    spender: `${name} ${short(spender)}`,
  }
}

interface LedgerParts {
  rows: React.ReactNode
  auth: React.ReactNode
  steps: React.ReactNode
}

/** The slip's three ledger blocks, built once so each layout can order them. */
function ledgerParts(p: PreparedLever, intent: LeverIntent, sim: SimResult | null): LedgerParts {
  const venue = PROTOCOL_SHORT[intent.protocol]
  const shown = fmtAmount(p.row.amount, p.row.amountDecimals)
  const steps = stepsOf(p.calls, {
    protocol: intent.protocol,
    kind: p.row.kind,
    symbol: p.leg.symbol,
    shown,
  })
  const gas = gasLine(sim)
  const auth = authorised(
    p,
    intent.protocol === 'compound-v3'
      ? 'Comet'
      : intent.protocol === 'morpho-blue'
        ? 'Morpho Blue'
        : `${venue} Pool`,
  )
  return {
    rows: (
      <Section title="Brought forward → carried forward">
        <LedgerHead />
        {slipRows(p.view, p.row, intent.horizon, intent.stale).map((r) => (
          <LedgerLine key={r.label} label={r.label} before={r.before} after={r.after} />
        ))}
        <LedgerLine
          label={`${p.leg.symbol} in ${short(intent.owner)}`}
          before={fmtUnits(p.read.balance, p.read.decimals, Math.max(2, p.row.amountDecimals))}
          after={fmtUnits(
            p.read.balance >= p.amount ? p.read.balance - p.amount : 0n,
            p.read.decimals,
            Math.max(2, p.row.amountDecimals),
          )}
        />
        {intent.stale && (
          <Small pt={SPACING.xs}>
            <StaleTag /> · chances withheld
          </Small>
        )}
      </Section>
    ),
    auth: auth && (
      <Box border={`1px solid ${NEWS.ink}`} px={SPACING.sm} py={SPACING.xs} minW={0}>
        <Small {...CAPS} color={NEWS.ink2}>
          Authorised up to
        </Small>
        <Mono fontWeight={700}>{auth.amount}</Mono>
        <Small overflowWrap="anywhere">to {auth.spender} · exactly this, never unlimited</Small>
      </Box>
    ),
    steps: (
      <Section title={`Steps · ${steps.length} · each shows in your wallet`}>
        {steps.map((s, i) => (
          <Box
            key={i}
            display="grid"
            gridTemplateColumns="2em minmax(0, 1fr)"
            py={SPACING.xs}
            borderBottom={RULE}
          >
            <Mono color={NEWS.ink2}>{i + 1}</Mono>
            <Box minW={0}>
              <Mono>{s.title}</Mono>
              <Small overflowWrap="anywhere">{s.detail}</Small>
            </Box>
          </Box>
        ))}
        {gas && (
          <Box
            display="grid"
            gridTemplateColumns="2em minmax(0, 1fr)"
            py={SPACING.xs}
            borderBottom={RULE}
          >
            <Mono color={NEWS.ink2}>≈</Mono>
            <Mono overflowWrap="anywhere">Gas, est. {gas}</Mono>
          </Box>
        )}
      </Section>
    ),
  }
}

const Checks: React.FC<{ checks: Check[]; title?: string }> = ({ checks, title = 'Checks' }) => (
  <Section title={title}>
    <Box as="ul" listStyleType="none" m={0} p={0} pt={SPACING.xs}>
      {checks.map((c) => (
        <Box as="li" key={c.id} display="grid" gridTemplateColumns="2em minmax(0, 1fr)">
          <Mono aria-hidden color={c.ok === false ? NEWS.ink : NEWS.ink2}>
            {GLYPH(c.ok)}
          </Mono>
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
  </Section>
)

/** What the stamp means, one line, for the counterfoil. */
function stampStory(stamp: string): string {
  if (stamp === 'SUBMITTED')
    return 'Handed to your wallet. Nothing is sent until you confirm there.'
  if (stamp.endsWith('STILL WAITING')) return 'Sent. The chain has not confirmed it yet.'
  if (stamp.startsWith('PENDING')) return 'Sent. Waiting for the chain to confirm.'
  if (stamp === 'SETTLED') return 'Confirmed on Ethereum. The page is reading the position again.'
  if (stamp === 'REPLACED') return 'Your wallet replaced it. It did not happen.'
  if (stamp === 'FAILED · GAS SPENT') return 'It did not complete. Gas was spent on what was mined.'
  if (stamp === 'FAILED') return 'Stopped before anything was mined. No gas spent.'
  return ''
}

const TxLink: React.FC<{ hash: string | null; owner: string; onOpen: () => void }> = ({
  hash,
  owner,
  onOpen,
}) => {
  const href = hash
    ? getTxExplorerUrl(mainnet, hash)
    : `${mainnet.blockExplorers.default.url}/address/${owner}`
  return (
    <Link
      href={href}
      isExternal
      onClick={onOpen}
      display="inline-flex"
      alignItems="center"
      minH="44px"
      fontFamily={NEWS_FONT.mono}
      fontSize={TYPE.body}
      color={NEWS.accent}
      textDecoration="underline"
      _focusVisible={FOCUS_STYLES.ring}
    >
      {hash ? `${short(hash)} on Etherscan ↗` : `${short(owner)}'s activity on Etherscan ↗`}
    </Link>
  )
}

/**
 * The kinds that act: they take the CTA fill and the raised hard shadow (NEWS.shadowRaised,
 * owner ruling 2026-10-17). A waiting or closing button stays a flat outline.
 */
export const PRIMARY_KINDS: ReadonlySet<SheetView['button']['kind']> = new Set([
  'sign',
  'connect',
  'switch',
  'retry',
])

const BUTTON = {
  borderRadius: 0,
  justifyContent: 'center',
  textAlign: 'center',
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

// ------------------------------------------------------------------ the slip

export interface LeverSlipProps {
  intent: LeverIntent
  prepared: Prepared | null
  sim: SimResult | null
  sheet: SheetView
  txHash: `0x${string}` | null
  busy: boolean
  onButton: () => void
  onClose: () => void
  /** The reader opened the explorer (lets a still-waiting slip be dismissed). */
  onExplorer: () => void
  /**
   * The body's order. 'rows' (the default): what changes, then the approval and the
   * steps, then the checks. 'steps' (design candidate B, /dev/slip-states?layout=b): the
   * approval and the steps first, in the order the wallet shows them, then what changes,
   * then the checks, last before the button they gate.
   */
  layout?: 'rows' | 'steps'
  /** Design harness only (/dev/slip-states walkthrough): a bar above the slip's head. */
  harness?: React.ReactNode
}

export const LeverSlip: React.FC<LeverSlipProps> = ({
  intent,
  prepared,
  sim,
  sheet,
  txHash,
  busy,
  onButton,
  onClose,
  onExplorer,
  layout = 'rows',
  harness,
}) => {
  const ready = prepared?.kind === 'ready' ? prepared : null
  const parts = ready ? ledgerParts(ready, intent, sim) : null
  const stepsFirst = layout === 'steps'
  const primary = sheet.button.enabled && PRIMARY_KINDS.has(sheet.button.kind)
  const showChecks = sheet.checks.length > 0 && prepared?.kind !== 'gone'
  const venue = PROTOCOL_SHORT[intent.protocol]
  const row = ready ? ready.row : intent.row
  const symbol = ready ? ready.leg.symbol : intent.row.symbol
  const commit = sheet.button.kind === 'sign'
  const sent = sheet.stamp !== 'DRAFT'
  const red = isRedStamp(sheet.stamp)
  const waiting = sheet.stamp.endsWith('STILL WAITING')

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
        maxW={{ base: '100%', md: '560px' }}
        my={{ base: 0, md: SPACING.base }}
        mx={{ base: 0, md: SPACING.base }}
        maxH={{ base: '92vh', md: '88vh' }}
      >
        {harness}
        <ModalHeader
          px={SPACING.base}
          pt={SPACING.base}
          pb={SPACING.sm}
          pr={SPACING['2xl']}
          fontWeight={400}
        >
          <Box
            display="flex"
            flexWrap="wrap"
            alignItems="center"
            justifyContent="space-between"
            gap={SPACING.sm}
          >
            <Kicker>Order slip · {venue}</Kicker>
            <Stamp stamp={sheet.stamp} />
          </Box>
          <Headline
            kind={row.kind}
            amount={fmtAmount(row.amount, row.amountDecimals)}
            symbol={symbol}
          />
          <Small as="span" display="block" fontWeight={400} mt={SPACING.xs}>
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

        <ModalBody
          px={SPACING.base}
          py={0}
          display="grid"
          gap={SPACING.base}
          minW={0}
          borderTop={`2px solid ${NEWS.ink}`}
          pt={SPACING.base}
        >
          {parts ? (
            <Box display="grid" gap={SPACING.base} minW={0}>
              {stepsFirst ? (
                <>
                  {parts.auth}
                  {parts.steps}
                  {parts.rows}
                </>
              ) : (
                <>
                  {parts.rows}
                  {parts.auth}
                  {parts.steps}
                </>
              )}
            </Box>
          ) : (
            !sheet.notice && (
              <Mono color={NEWS.ink2}>Reading {venue} at one block for every figure…</Mono>
            )
          )}
          {showChecks && (
            <Checks checks={sheet.checks} title={stepsFirst ? 'Checks · before you sign' : 'Checks'} />
          )}

          {sent && (
            // THE COUNTERFOIL: torn off along the perforation once something was handed to the wallet.
            <Box
              borderTop={`2px dashed ${NEWS.ink}`}
              pt={SPACING.sm}
              minW={0}
              data-testid="lever-counterfoil"
            >
              <Box
                display="flex"
                flexWrap="wrap"
                alignItems="center"
                justifyContent="space-between"
                gap={SPACING.sm}
              >
                <Kicker tone="muted">Counterfoil</Kicker>
                <Stamp stamp={sheet.stamp} />
              </Box>
              <Mono pt={SPACING.xs}>{stampStory(sheet.stamp)}</Mono>
              {(txHash || waiting) && (
                <TxLink hash={txHash} owner={intent.owner} onOpen={onExplorer} />
              )}
            </Box>
          )}

          {ready && (
            <Small textAlign="right" overflowWrap="anywhere" pb={SPACING.xs}>
              Read at block {ready.block !== null ? fmtInt(ready.block) : '—'} ·{' '}
              {fmtUtc(ready.blockTime ?? ready.at)} · {ready.source}
              {sim ? ` · simulated with ${sim.method}` : ''}
              {ready.view.forecast && !intent.stale ? ` · ${ready.view.forecast.footer}` : ''}
            </Small>
          )}
        </ModalBody>

        <ModalFooter
          px={SPACING.base}
          pt={SPACING.sm}
          pb={SPACING.lg}
          display="grid"
          gap={SPACING.sm}
          justifyContent="stretch"
          borderTop={RULE}
        >
          {sheet.notice && (
            <Box display="grid" gridTemplateColumns="2em minmax(0, 1fr)" role="status" minW={0}>
              <Mono fontWeight={700} color={red ? NEWS.danger : NEWS.ink} aria-hidden>
                {waiting ? '○' : '✖'}
              </Mono>
              <Mono fontWeight={700} color={red ? NEWS.danger : NEWS.ink} overflowWrap="anywhere">
                {sheet.notice}
              </Mono>
            </Box>
          )}
          {/* A dashed edge leads to a signature (T31). */}
          <Box
            border={`1px dashed ${commit ? NEWS.ink : NEWS.ruleStrong}`}
            p={SPACING.xs}
            // Room for the raised shadow inside the frame.
            pr={SPACING.sm}
            pb={SPACING.sm}
          >
            <Button
              {...BUTTON}
              w="100%"
              onClick={onButton}
              isDisabled={!sheet.button.enabled}
              data-testid="lever-button"
              bg={primary ? NEWS.cta : 'transparent'}
              color={primary ? NEWS.onCta : NEWS.ink}
              border={`1px solid ${NEWS.ink}`}
              boxShadow={primary ? NEWS.shadowRaised : 'none'}
              _hover={{ bg: primary ? NEWS.cta : NEWS.raised }}
              // Pressed: the print shadow goes, the button sits on the paper. No movement.
              _active={{ boxShadow: 'none' }}
              _disabled={{
                opacity: 1,
                cursor: 'not-allowed',
                color: NEWS.muted,
                borderColor: NEWS.rule,
                bg: 'transparent',
                boxShadow: 'none',
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

// ------------------------------------------------------------------ wired

export const LeverSheet: React.FC<{
  intent: LeverIntent
  onClose: () => void
  /** Connect, keeping this intent: the page re-opens this slip once the wallet connects. */
  onConnect: () => void
  /** The page's position read, refreshed after a settled transaction. */
  onSettled: (owner: `0x${string}`) => void
}> = ({ intent, onClose, onConnect, onSettled }) => {
  const exec = useLeverExec(intent, onSettled)
  const onButton = () => {
    switch (exec.sheet.button.kind) {
      case 'connect':
        return onConnect()
      case 'switch':
        return exec.switchChain()
      case 'sign':
        return exec.sign()
      case 'retry':
        return exec.retry()
      case 'dismiss':
      case 'close':
        return onClose()
    }
  }
  return (
    <LeverSlip
      intent={intent}
      prepared={exec.prepared}
      sim={exec.sim}
      sheet={exec.sheet}
      txHash={exec.txHash}
      busy={exec.busy}
      onButton={onButton}
      onClose={onClose}
      onExplorer={exec.checked}
    />
  )
}
