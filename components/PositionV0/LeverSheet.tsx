// THE ORDER SLIP (owner ruling T31: signing surfaces are a ledger slip on the same paper,
// with a counterfoil). A lever row opens it in place: a centred modal on a desktop, a
// bottom sheet on a phone. It never sends the reader to the venue's app ("think Bloomberg").
//
//   head        ORDER SLIP · AAVE V3                                 DRAFT | [ STAMP ]
//               If you repay  760 USDT          words in Redaction, the figure in Mono
//               (DRAFT is the word alone, a quiet mono label; a stamp is boxed once
//               something has been handed to the wallet)
//   ledger      brought forward → carried forward: price, distance, chance †, balance
//   authorised  the exact approval and its spender, when the batch approves (solid box)
//   steps       every call the wallet will show: contract, function, exact units; gas
//   amount      the reader's own amount, held under what the wallet holds, the debt or the
//               cap room, with its limit and a Max chip (owner, Q27 round 5)
//   checks      venue, balance, wallet, owner, chain, simulation — each named, with a glyph;
//               a failing check is red, ✖ and its words, so it is found at a glance
//   counterfoil after the first signature, behind a perforation: the stamp's story, the
//               transaction, "still waiting", what stands after a partial run
//   commit      one button in a dashed frame (a dashed edge leads to a signature); a
//               button that signs, connects or retries is raised: CTA fill and the hard
//               print shadow NEWS.shadowRaised, label centred. Switching the wallet or the
//               network is a quiet outline whose colour changes on hover (round 5)
//   settled     the slip closes; a toast says what happened (SettledToast.tsx)
//
// Every figure is JetBrains Mono (T31, CLAUDE.md rule 3); Redaction sets only the headline
// words. Colour carries a glyph (DESIGN_RULES §2): red only for a failure that cost gas or
// did not happen, always with ✖. `SlipFrame` is the paper every intent shares (the
// collect-dust slip, DustSlip.tsx, fills it too). `LeverSlip` is presentational (the
// design-states page renders it from fixtures); `LeverSheet` wires it to useLeverExec.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  Input,
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
import { checkAmount, maxText } from '@/lib/position-exec/amountInput'
import { rereadLine } from '@/lib/position-exec/refocus'
import type { Check, SheetView } from '@/lib/position-exec/sheet'
import type { SimResult } from '@/lib/position-exec/simulate'
import { fmtAmount, fmtInt, fmtUtc } from '@/lib/position/format'

import { PROTOCOL_SHORT } from './viewModel'
import { Kicker, Mono, Small, StaleTag } from './primitives'
import {
  capSuggestion,
  limitOf,
  settledToast,
  slipRows,
  stepsOf,
  type LeverIntent,
  type Prepared,
  type PreparedLever,
  type SettledToastData,
} from './leverExec'
import { CAPS, TYPE } from './typeScale'
import { useLeverExec } from './useLeverExec'

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const GLYPH = (ok: boolean | null) => (ok === null ? '○' : ok ? '●' : '✖')
const RULE = `1px solid ${NEWS.rule}`

/** Stamps that report a loss or a non-event: red, and always with ✖. */
const isRedStamp = (stamp: string) => stamp.startsWith('FAILED') || stamp === 'REPLACED'

// ------------------------------------------------------------------ pieces

export const Stamp: React.FC<{ stamp: string }> = ({ stamp }) => {
  const red = isRedStamp(stamp)
  // A draft is not a stamp yet: the word alone, a quiet mono label, no box (owner, round 4).
  const draft = stamp === 'DRAFT'
  return (
    <Box
      as="span"
      data-testid="lever-stamp"
      aria-live="polite"
      display="inline-block"
      border={draft ? 'none' : `1px solid ${red ? NEWS.danger : NEWS.ink}`}
      px={draft ? 0 : SPACING.xs}
      fontFamily={NEWS_FONT.mono}
      fontSize={TYPE.label}
      fontWeight={draft ? 400 : 700}
      lineHeight={1.6}
      color={red ? NEWS.danger : draft ? NEWS.muted : NEWS.ink}
      whiteSpace="nowrap"
      {...CAPS}
    >
      {red ? `✖ ${stamp}` : stamp}
    </Box>
  )
}

/** "If you repay" in Redaction, "760 USDT" in Mono, one headline. */
export const Headline: React.FC<{ kind: string; amount: string; symbol: string }> = ({
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

export const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <Box minW={0}>
    <Kicker tone="muted" pb={SPACING.xs} borderBottom={`1px solid ${NEWS.ruleStrong}`}>
      {title}
    </Kicker>
    {children}
  </Box>
)

/** One ledger line: label, now, after. A three-column table from 480px; stacked below it. */
export const LedgerLine: React.FC<{ label: string; before: string | null; after: string }> = ({
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

export const LedgerHead: React.FC<{ before?: string; after?: string }> = ({
  before = 'Now',
  after = 'After',
}) => (
  <Box
    display={{ base: 'none', sm: 'grid' }}
    gridTemplateColumns="minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr)"
    columnGap={SPACING.sm}
    pt={SPACING.xs}
  >
    <span />
    <Small textAlign="right" {...CAPS}>
      {before}
    </Small>
    <Small textAlign="right" {...CAPS}>
      {after}
    </Small>
  </Box>
)

export function gasLine(sim: SimResult | null): string | null {
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

export const Checks: React.FC<{ checks: Check[]; title?: string }> = ({ checks, title = 'Checks' }) => (
  <Section title={title}>
    <Box as="ul" listStyleType="none" m={0} p={0} pt={SPACING.xs}>
      {checks.map((c) => (
        <Box as="li" key={c.id} display="grid" gridTemplateColumns="2em minmax(0, 1fr)">
          {/* A failing check is red, glyph and words, so it is found at a glance (round 5). */}
          <Mono aria-hidden fontWeight={700} color={c.ok === false ? NEWS.danger : NEWS.ink2}>
            {GLYPH(c.ok)}
          </Mono>
          <Mono
            fontWeight={c.ok === false ? 700 : 400}
            color={c.ok === false ? NEWS.danger : NEWS.ink2}
            overflowWrap="anywhere"
            data-testid={c.ok === false ? 'check-failed' : undefined}
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
  if (stamp === 'REPLACED')
    return 'Your wallet sent a different transaction in its place (sped up or cancelled). Check your wallet for the one that went through.'
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
  'retry',
])

/**
 * Switching the wallet or the network fixes the reader's setup, not the order: a quiet
 * outline, never the CTA fill, whose colour changes on hover (owner, Q27 round 5).
 */
export const QUIET_KINDS: ReadonlySet<SheetView['button']['kind']> = new Set(['wallet', 'switch'])

/** The quiet outline's hover and press: the edge and the words take the accent. */
export const QUIET_HOVER = { color: NEWS.accent, borderColor: NEWS.accent, bg: NEWS.raised } as const

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

/** A button label in caps, with any address kept as written: "SWITCH WALLET TO 0x895d…95cc". */
const ButtonLabel: React.FC<{ label: string }> = ({ label }) => (
  <>
    {label.split(/(0x[0-9a-fA-F]{2,}…?[0-9a-fA-F]*)/).map((part, i) =>
      i % 2 === 1 ? (
        <Box as="span" key={i} textTransform="none" letterSpacing="normal" whiteSpace="nowrap">
          {part}
        </Box>
      ) : (
        part
      ),
    )}
  </>
)

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
  /** Re-read the slip at the reader's own amount (the field, or "use the room left"). */
  onAmount?: (value: number, decimals: number) => void
  /** When the slip read again on its own because the page had focus again (ms). */
  rereadAt?: number | null
}

export interface SlipFrameProps {
  /** "Order slip · Aave V3" */
  kicker: string
  /** The headline: words in Redaction, the figure in Mono. */
  headline: React.ReactNode
  /** One line under the headline. */
  subtitle: React.ReactNode
  /** The ledger blocks, in the order the slip reads them. */
  body: React.ReactNode
  /** Shown while there is no ledger yet (and no notice). */
  reading: string
  checksTitle?: string
  showChecks: boolean
  /** The read's provenance line, at the foot of the body. */
  footnote: React.ReactNode
  sheet: SheetView
  txHash: `0x${string}` | null
  owner: string
  busy: boolean
  onButton: () => void
  onClose: () => void
  onExplorer: () => void
  harness?: React.ReactNode
  testId?: string
  /** One action beside the notice: "Use 0.24 (the room left)". */
  noticeAction?: React.ReactNode
  /** When the slip read again by itself because the page had focus again (ms). */
  rereadAt?: number | null
}

/**
 * THE SLIP'S PAPER: head, stamp, body, checks, counterfoil and the one button, the same
 * for every intent (a lever's repay or add, collecting dust). Each intent fills the body.
 */
export const SlipFrame: React.FC<SlipFrameProps> = ({
  kicker,
  headline,
  subtitle,
  body,
  reading,
  checksTitle = 'Checks',
  showChecks,
  footnote,
  sheet,
  txHash,
  owner,
  busy,
  onButton,
  onClose,
  onExplorer,
  harness,
  testId = 'lever-sheet',
  noticeAction,
  rereadAt = null,
}) => {
  const primary = sheet.button.enabled && PRIMARY_KINDS.has(sheet.button.kind)
  const quiet = sheet.button.enabled && QUIET_KINDS.has(sheet.button.kind)
  const replaced = sheet.stamp === 'REPLACED'
  // A notice that names a failing check is red like the check (round 5).
  const failing = sheet.checks.some((c) => c.ok === false && c.text === sheet.notice)
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
        data-testid={testId}
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
            <Kicker>{kicker}</Kicker>
            <Stamp stamp={sheet.stamp} />
          </Box>
          {headline}
          <Small as="span" display="block" fontWeight={400} mt={SPACING.xs}>
            {subtitle}
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
          {body ?? (!sheet.notice && <Mono color={NEWS.ink2}>{reading}</Mono>)}
          {rereadAt !== null && (
            <Small role="status" aria-live="polite" data-testid="reread-line">
              ↻ {rereadLine(rereadAt)} · the page had focus again, so the slip read the chain again
            </Small>
          )}
          {showChecks && <Checks checks={sheet.checks} title={checksTitle} />}

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
              {replaced ? (
                // Round 5: a plain headline and line; what the wallet reported folds away.
                <Box display="grid" gap={SPACING.xs} pt={SPACING.xs} data-testid="replaced">
                  <Box as="span" fontFamily={NEWS_FONT.display} fontWeight={700} fontSize={TYPE.head} lineHeight={1.25}>
                    Tx replaced
                  </Box>
                  <Mono>{stampStory(sheet.stamp)}</Mono>
                  <Box
                    as="details"
                    sx={{ '& > summary': { cursor: 'pointer', minHeight: '44px', display: 'flex', alignItems: 'center' } }}
                  >
                    <Box as="summary" fontFamily={NEWS_FONT.mono} fontSize={TYPE.body} color={NEWS.ink2} _focusVisible={FOCUS_STYLES.ring}>
                      Details
                    </Box>
                    {sheet.notice && <Small overflowWrap="anywhere">{sheet.notice}</Small>}
                    {txHash && <TxLink hash={txHash} owner={owner} onOpen={onExplorer} />}
                  </Box>
                </Box>
              ) : (
                <>
                  <Mono pt={SPACING.xs}>{stampStory(sheet.stamp)}</Mono>
                  {(txHash || waiting) && <TxLink hash={txHash} owner={owner} onOpen={onExplorer} />}
                </>
              )}
            </Box>
          )}

          {footnote && (
            <Small textAlign="right" overflowWrap="anywhere" pb={SPACING.xs}>
              {footnote}
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
          {sheet.notice && !replaced && (
            <Box display="grid" gridTemplateColumns="2em minmax(0, 1fr)" role="status" minW={0}>
              <Mono fontWeight={700} color={red || failing ? NEWS.danger : NEWS.ink} aria-hidden>
                {waiting ? '○' : '✖'}
              </Mono>
              <Mono fontWeight={700} color={red || failing ? NEWS.danger : NEWS.ink} overflowWrap="anywhere">
                {sheet.notice}
              </Mono>
            </Box>
          )}
          {noticeAction}
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
              data-kind={sheet.button.kind}
              _hover={quiet ? QUIET_HOVER : { bg: primary ? NEWS.cta : NEWS.raised }}
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
              <ButtonLabel label={sheet.button.label} />
            </Button>
          </Box>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

/**
 * THE AMOUNT FIELD (owner, Q27 round 5: "prevent errors before pay"). The reader lowers or
 * raises the amount here; it cannot go past what the wallet holds, the debt a repay can pay
 * or the room under a cap (gates.ts amountLimit), which it prints with a Max chip. A
 * valid amount re-reads the slip at it. The gates stay as the backstop.
 */
export const AmountField: React.FC<{
  p: PreparedLever
  onAmount?: (value: number, decimals: number) => void
}> = ({ p, onAmount }) => {
  const shownNow = fmtAmount(p.row.amount, p.row.amountDecimals).replace(/,/g, '')
  const [text, setText] = useState(shownNow)
  // A new read (a new amount, a re-read) puts its own amount in the field.
  useEffect(() => setText(shownNow), [shownNow])
  const limit = limitOf(p)
  const decimals = p.read.decimals
  const check = checkAmount(text, decimals, limit)
  const max = maxText(limit, decimals, Math.min(decimals, 6))
  const same = check.kind === 'ok' && check.units === p.amount
  const canApply = check.kind === 'ok' && !same && !!onAmount
  const apply = () => {
    if (check.kind === 'ok' && canApply) onAmount!(check.amount, check.amountDecimals)
  }
  const verb = p.row.kind === 'repay' ? 'repay' : 'add'
  const errId = `amount-msg-${p.leg.symbol}`
  const error = check.kind === 'error' ? check.message : null
  return (
    <Section title={`Amount to ${verb}`}>
      <Box
        as="form"
        onSubmit={(e: React.FormEvent) => {
          e.preventDefault()
          apply()
        }}
        display="grid"
        gridTemplateColumns={{ base: 'minmax(0, 1fr) auto', sm: 'minmax(0, 1fr) auto auto' }}
        gap={SPACING.xs}
        pt={SPACING.sm}
        alignItems="stretch"
        minW={0}
      >
        <Box position="relative" minW={0} gridColumn={{ base: '1 / -1', sm: 'auto' }}>
          <Input
            aria-label={`Amount of ${p.leg.symbol} to ${verb}`}
            aria-invalid={error !== null}
            aria-describedby={errId}
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="amount-input"
            h="44px"
            pr="5.5em"
            borderRadius={0}
            border={`1px solid ${error ? NEWS.danger : NEWS.ink}`}
            bg={NEWS.paper}
            color={NEWS.ink}
            fontFamily={NEWS_FONT.mono}
            fontSize={TYPE.body}
            fontWeight={700}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
            transition={TRANSITIONS.colors}
            _hover={{ borderColor: error ? NEWS.danger : NEWS.accent }}
            _focusVisible={FOCUS_STYLES.ring}
          />
          <Mono
            position="absolute"
            right={SPACING.sm}
            top="50%"
            transform="translateY(-50%)"
            color={NEWS.ink2}
            pointerEvents="none"
          >
            {p.leg.symbol}
          </Mono>
        </Box>
        <Button
          {...BUTTON}
          type="button"
          onClick={() => max && setText(max)}
          isDisabled={!max}
          aria-label={max ? `Max: ${max} ${p.leg.symbol}, ${limit.text}` : 'Max: nothing available'}
          data-testid="amount-max"
          bg="transparent"
          color={NEWS.ink}
          border={`1px solid ${NEWS.ink}`}
          _hover={QUIET_HOVER}
          _disabled={{ opacity: 1, color: NEWS.muted, borderColor: NEWS.rule, cursor: 'not-allowed' }}
        >
          Max
        </Button>
        <Button
          {...BUTTON}
          type="submit"
          isDisabled={!canApply}
          data-testid="amount-apply"
          bg="transparent"
          color={NEWS.ink}
          border={`1px solid ${NEWS.ink}`}
          _hover={QUIET_HOVER}
          _disabled={{ opacity: 1, color: NEWS.muted, borderColor: NEWS.rule, cursor: 'not-allowed' }}
        >
          Read at this amount
        </Button>
      </Box>
      <Small
        id={errId}
        pt={SPACING.xs}
        color={error ? NEWS.danger : NEWS.ink2}
        fontWeight={error ? 700 : 400}
        overflowWrap="anywhere"
        aria-live="polite"
        data-testid="amount-limit"
      >
        {error ? `✖ ${error}` : `Limit · ${limit.text}`}
        {p.custom
          ? ` · your amount; the lever solved ${fmtAmount(p.solved.amount, p.solved.amountDecimals)} ${p.leg.symbol}`
          : ''}
      </Small>
    </Section>
  )
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
  onAmount,
  rereadAt = null,
}) => {
  const ready = prepared?.kind === 'ready' ? prepared : null
  const parts = ready ? ledgerParts(ready, intent, sim) : null
  const stepsFirst = layout === 'steps'
  const venue = PROTOCOL_SHORT[intent.protocol]
  const row = ready ? ready.row : intent.row
  const symbol = ready ? ready.leg.symbol : intent.row.symbol
  // The field edits a draft only: once something is with the wallet the amount is fixed.
  const draft = sheet.stamp === 'DRAFT'
  const suggest = ready && draft ? capSuggestion(ready) : null

  return (
    <SlipFrame
      kicker={`Order slip · ${venue}`}
      headline={
        <Headline kind={row.kind} amount={fmtAmount(row.amount, row.amountDecimals)} symbol={symbol} />
      }
      subtitle={
        <>
          {intent.title}
          {ready?.changed
            ? ` · re-solved now, was ${fmtAmount(intent.row.amount, intent.row.amountDecimals)} ${intent.row.symbol}`
            : ''}
        </>
      }
      body={
        parts ? (
          <Box display="grid" gap={SPACING.base} minW={0}>
            {draft && <AmountField p={ready!} onAmount={onAmount} />}
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
        ) : null
      }
      reading={`Reading ${venue} at one block for every figure…`}
      showChecks={sheet.checks.length > 0 && prepared?.kind !== 'gone'}
      checksTitle={stepsFirst ? 'Checks · before you sign' : 'Checks'}
      footnote={
        ready && (
          <>
            Read at block {ready.block !== null ? fmtInt(ready.block) : '—'} ·{' '}
            {fmtUtc(ready.blockTime ?? ready.at)} · {ready.source}
            {sim ? ` · simulated with ${sim.method}` : ''}
            {ready.view.forecast && !intent.stale ? ` · ${ready.view.forecast.footer}` : ''}
          </>
        )
      }
      noticeAction={
        suggest && (
          <Button
            {...BUTTON}
            w="100%"
            onClick={() => onAmount?.(suggest.amount, suggest.amountDecimals)}
            isDisabled={!onAmount}
            data-testid="cap-suggest"
            bg="transparent"
            color={NEWS.ink}
            border={`1px solid ${NEWS.ink}`}
            _hover={QUIET_HOVER}
          >
            {suggest.text}
          </Button>
        )
      }
      rereadAt={rereadAt}
      sheet={sheet}
      txHash={txHash}
      owner={intent.owner}
      busy={busy}
      onButton={onButton}
      onClose={onClose}
      onExplorer={onExplorer}
      harness={harness}
    />
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
  /** Settled: the slip closes and the page shows this toast (round 5). */
  onToast: (toast: SettledToastData) => void
}> = ({ intent, onClose, onConnect, onSettled, onToast }) => {
  const [amount, setAmount] = useState<LeverIntent['amount']>(null)
  const exec = useLeverExec(intent, onSettled, amount, onConnect)
  const onButton = () => {
    switch (exec.sheet.button.kind) {
      case 'connect':
        return onConnect()
      case 'wallet':
        return exec.switchWallet()
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
  // Settled: hand the page its toast and close; the slip is not kept open (round 5).
  const told = useRef(false)
  const ready = exec.prepared?.kind === 'ready' ? exec.prepared : null
  useEffect(() => {
    if (told.current || exec.sheet.stamp !== 'SETTLED' || !exec.txHash || !ready) return
    told.current = true
    onToast(settledToast(ready, intent.horizon, exec.txHash))
    onClose()
  }, [exec.sheet.stamp, exec.txHash, ready, intent.horizon, onToast, onClose])
  const onAmount = useCallback((value: number, decimals: number) => setAmount({ value, decimals }), [])
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
      onAmount={onAmount}
      rereadAt={exec.rereadAt}
    />
  )
}
