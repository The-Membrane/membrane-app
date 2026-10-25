import React, { useState } from 'react'
import {
  Box,
  Button,
  Collapse,
  Grid,
  HStack,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Stack,
  Text,
  VStack,
} from '@chakra-ui/react'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES, HOVER_EFFECTS, TRANSITIONS } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import { DemoBanner } from '@/components/demo/DemoBanner'
import { DemoAwareCta } from '@/components/demo/DemoAwareCta'

import { ACCRUAL_BUFFER_BPS, FLASH_SOURCE, LTV_MARGIN, revokeSteps } from '@/lib/migrate/plan'
import type { MigrationPlan, PlanRow, RowTone, SignatureStep } from '@/lib/migrate/types'

import type { Phase } from './useMigrateFlow'

/**
 * THE ORDER TICKET, presentational (copy-budget skill: ≤ 60 visible words with Details closed).
 * Visible: title + one stamp, label/value rows, one line per signing step, a ≤ 12-word callout when
 * something blocks, the buttons with a ≤ 6-word disabled reason. Every explanation lives behind ONE
 * closed Details disclosure. No number is formatted here that the plan did not already carry.
 */
export interface SlipViewProps {
  kind: 'migrate' | 'deploy'
  isOpen?: boolean
  plan: MigrationPlan
  phase: Phase
  /** ≤ 8 words, e.g. `Anvil · block 68`. */
  stamp: string
  /** The full provenance sentence (Details). */
  provenance: string
  promptIds: string[] | null
  addresses: { label: string; address: string }[]
  /** Extra Details lines (e.g. the deposit capped at the wallet). */
  notes?: string[]
  onStart: () => void
  /** Optional revoke of the standing grants after a settled migration. */
  onRevoke?: () => void
  onClose: () => void
  /** Rendered inline (dev page) instead of in a portal modal. */
  inline?: boolean
}

const TITLE = { migrate: 'Migrate position', deploy: 'Deploy fresh' }
const KIND = { tx: 'Send', 'typed-data': 'Sign' } as const
const BLOCKING = new Set<Phase['k']>(['wrong-chain', 'no-deployment', 'blocked', 'trim', 'sim-failed'])

const mono = { fontFamily: TYPOGRAPHY.fontMono } as const

const toneColor = (t: RowTone | undefined) =>
  t === 'danger' ? SEMANTIC_COLORS.danger : t === 'warn' ? SEMANTIC_COLORS.warning : t === 'muted' ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.textPrimary

const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`

/** The ticket rows: two aligned columns, label left, value right. */
const Rows: React.FC<{ rows: PlanRow[] }> = ({ rows }) => (
  <Grid templateColumns="1fr auto" columnGap={0} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
    {rows.map((r) => (
      <React.Fragment key={r.key}>
        <Text
          {...mono}
          fontSize={TYPOGRAPHY.label}
          textTransform="uppercase"
          letterSpacing="0.28em"
          color={SEMANTIC_COLORS.textSecondary}
          py={SPACING.sm}
          borderBottom="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          alignSelf="stretch"
          display="flex"
          alignItems="center"
        >
          {r.label}
        </Text>
        <Text
          {...mono}
          data-row={r.key}
          fontSize={TYPOGRAPHY.small}
          fontWeight={TYPOGRAPHY.medium}
          color={toneColor(r.tone)}
          textAlign="right"
          whiteSpace="nowrap"
          sx={{ fontVariantNumeric: 'tabular-nums' }}
          py={SPACING.sm}
          pl={SPACING.md}
          borderBottom="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          {r.value}
        </Text>
      </React.Fragment>
    ))}
  </Grid>
)

type StepState = 'todo' | 'skipped' | 'active' | 'done'

function stepState(s: SignatureStep, phase: Phase, promptIds: string[] | null): StepState {
  if (promptIds && !promptIds.includes(s.id)) return 'skipped'
  if (phase.k === 'settled') return 'done'
  if ((phase.k === 'signing' || phase.k === 'submitted') && promptIds) {
    const cur = promptIds.indexOf(phase.id)
    const me = promptIds.indexOf(s.id)
    if (me < cur) return 'done'
    if (me === cur) return phase.k === 'submitted' ? 'done' : 'active'
  }
  return 'todo'
}

/** One line per step: `01 Sign aToken permit`. Done and skipped are struck through. */
const Steps: React.FC<{ steps: SignatureStep[]; phase: Phase; promptIds: string[] | null }> = ({ steps, phase, promptIds }) => (
  <VStack as="ol" listStyleType="none" spacing={SPACING.xs} align="stretch">
    {steps.map((s, i) => {
      const st = stepState(s, phase, promptIds)
      const color =
        st === 'active' ? SEMANTIC_COLORS.warning : st === 'done' ? SEMANTIC_COLORS.success : st === 'skipped' ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.textPrimary
      return (
        <HStack as="li" key={s.id} spacing={SPACING.sm} data-step={s.id} data-state={st} {...mono} fontSize={TYPOGRAPHY.small} color={color}>
          <Text as="span" color={SEMANTIC_COLORS.textTertiary} sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {String(i + 1).padStart(2, '0')}
          </Text>
          <Text as="span" textDecoration={st === 'done' || st === 'skipped' ? 'line-through' : undefined}>
            {KIND[s.kind]} {s.short}
          </Text>
        </HStack>
      )
    })}
  </VStack>
)

function callout(phase: Phase): { text: string; color: string } | null {
  switch (phase.k) {
    case 'wrong-chain':
      return { text: phase.reason, color: SEMANTIC_COLORS.warning }
    case 'blocked':
    case 'trim':
    case 'sim-failed':
    case 'failed':
      return { text: phase.reason, color: SEMANTIC_COLORS.danger }
    case 'settled':
      return phase.note ? { text: phase.note, color: SEMANTIC_COLORS.warning } : null
    default:
      return null
  }
}

/** The primary button and its ≤ 6-word disabled reason. */
function primary(phase: Phase, kind: 'migrate' | 'deploy', prompts: number | null): { label: string; disabled: boolean; why: string | null } {
  const go = kind === 'migrate' ? 'Migrate' : 'Deploy'
  const n = prompts === null ? '' : ` · ${prompts} prompt${prompts === 1 ? '' : 's'}`
  switch (phase.k) {
    case 'simulated':
      return { label: `${go}${n}`, disabled: false, why: null }
    case 'wrong-chain':
      return { label: go, disabled: true, why: 'Wrong network' }
    case 'no-deployment':
      return { label: go, disabled: true, why: phase.reason }
    case 'blocked':
      return { label: go, disabled: true, why: null }
    case 'trim':
      return { label: 'Trim first', disabled: true, why: 'Over the LTV cap' }
    case 'sim-failed':
      return { label: go, disabled: true, why: 'Simulation reverted' }
    case 'ready':
    case 'reading':
    case 'simulating':
      return { label: 'Simulating…', disabled: true, why: null }
    case 'signing':
      return { label: `Prompt ${phase.index}/${phase.total}`, disabled: true, why: null }
    case 'submitted':
      return { label: 'Pending…', disabled: true, why: null }
    case 'settled':
      return { label: 'Settled', disabled: true, why: null }
    case 'failed':
      return { label: go, disabled: true, why: 'Run stopped' }
    default:
      return { label: go, disabled: true, why: null }
  }
}

/** Everything explanatory, one line each, behind ONE closed disclosure. */
function detailLines(p: SlipViewProps): string[] {
  const { plan, phase } = p
  const lines: string[] = [p.provenance]
  if (phase.k === 'demo') lines.push('Demo: these rows are a replayed wallet, not yours. Connect to read your own position; the same sheet then simulates and asks for the real prompts.')
  if ('detail' in phase && phase.detail) lines.push(phase.detail)
  if (plan.blocked && phase.k !== 'blocked') lines.push(plan.blocked)
  for (const r of plan.rows) if (r.detail) lines.push(r.detail)
  plan.signatures.forEach((s, i) => {
    const skip = p.promptIds && !p.promptIds.includes(s.id) ? ` Skipped: ${s.skippedWhen}.` : ''
    lines.push(`${String(i + 1).padStart(2, '0')} ${s.label}: ${s.why}${skip}`)
  })
  if (p.kind === 'migrate') {
    lines.push(`Flash loan: ${FLASH_SOURCE}; borrowed and repaid inside one transaction, so no extra capital is needed.`)
    lines.push(`Accrual buffer: ${ACCRUAL_BUFFER_BPS} bps over the debt read. It is borrowed; what the venue did not need comes back to you.`)
    lines.push(`LTV margin: ${(LTV_MARGIN * 100).toFixed(1)}pp under the borrow LTV. The adapter re-checks the LTV on-chain at Membrane’s price; above it the whole transaction reverts.`)
    lines.push(
      p.promptIds?.includes('batch')
        ? 'Batch: exact approvals replace the permits; the batch ends by restoring your earlier allowances to GA1 and the adapter.'
        : 'Permits are for exact amounts and are used up in the transaction; nothing stays approved.',
    )
    lines.push('Simulation: the exact transaction runs through eth_simulateV1 before any prompt; the operator grant is sent only after the signed bundle simulates.')
    if (plan.venue) for (const r of revokeSteps(plan.venue)) lines.push(`Optional after settling: ${r.label}. ${r.why}`)
  } else {
    lines.push('Simulation: the deposit and borrow run through eth_simulateV1 before any prompt.')
  }
  if (p.notes) lines.push(...p.notes)
  for (const a of p.addresses) lines.push(`${a.label}: ${a.address}`)
  if ((phase.k === 'settled' || phase.k === 'submitted' || phase.k === 'failed') && phase.hash) lines.push(`Transaction: ${phase.hash}`)
  return lines
}

const Body: React.FC<SlipViewProps & { details: boolean }> = (p) => {
  const { plan, phase } = p
  const c = callout(phase)
  const showSteps = plan.signatures.length > 0 && !BLOCKING.has(phase.k)
  return (
    <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch" w="100%">
      {phase.k === 'demo' && <DemoBanner note={p.kind === 'migrate' ? 'connect to migrate' : 'connect to deploy'} />}
      {c && (
        <Text {...mono} fontSize={TYPOGRAPHY.small} color={c.color} border="1px solid" borderColor={c.color} borderRadius={0} px={SPACING.md} py={SPACING.sm} data-testid="slip-callout">
          {c.text}
        </Text>
      )}
      <Rows rows={plan.rows} />
      {showSteps && <Steps steps={plan.signatures} phase={phase} promptIds={p.promptIds} />}
      {(phase.k === 'submitted' || phase.k === 'settled') && (
        <Text {...mono} fontSize={TYPOGRAPHY.small} color={phase.k === 'settled' ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning} data-testid="slip-status">
          {phase.k === 'settled' ? 'Settled' : 'Pending'} {shortHash(phase.hash)}
        </Text>
      )}
      {(phase.k === 'settled' || phase.k === 'failed') && phase.leftovers && phase.revoke !== 'done' && (
        <Text {...mono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.warning} data-testid="slip-leftovers">
          Left standing: {phase.leftovers.join(', ')}
        </Text>
      )}
      <Collapse in={p.details} animateOpacity>
        <VStack spacing={SPACING.xs} align="stretch" pt={SPACING.sm} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} data-testid="slip-details">
          {detailLines(p).map((l) => (
            <Text key={l} {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} wordBreak="break-word">
              {l}
            </Text>
          ))}
        </VStack>
      </Collapse>
    </VStack>
  )
}

const Footer: React.FC<SlipViewProps & { details: boolean; toggle: () => void }> = (p) => {
  const prompts = p.promptIds?.length ?? null
  const btn = primary(p.phase, p.kind, prompts)
  const common = {
    borderRadius: 0,
    minH: '44px',
    transition: TRANSITIONS.colors,
    _active: ACTIVE_EFFECTS.dim,
    _focus: FOCUS_STYLES.ring,
    ...mono,
  }
  const revokable = (p.phase.k === 'settled' || p.phase.k === 'failed') && p.phase.revoke !== undefined
  const revokeLabel =
    p.phase.k === 'settled' || p.phase.k === 'failed'
      ? { idle: p.phase.k === 'failed' ? 'Revoke leftovers' : 'Revoke adapter', running: 'Revoking…', done: 'Revoked', failed: 'Revoke failed' }[p.phase.revoke ?? 'idle']
      : ''
  return (
    <VStack align="stretch" spacing={SPACING.xs} w="100%">
      <Stack direction={{ base: 'column-reverse', sm: 'row' }} spacing={SPACING_PATTERNS.buttonGroupGap} align={{ base: 'stretch', sm: 'center' }} w="100%">
        <Button
          variant="link"
          onClick={p.toggle}
          aria-expanded={p.details}
          aria-controls="migrate-slip-details"
          {...mono}
          fontSize={TYPOGRAPHY.label}
          textTransform="uppercase"
          letterSpacing="0.28em"
          color={SEMANTIC_COLORS.textSecondary}
          transition={TRANSITIONS.colors}
          _focus={FOCUS_STYLES.ring}
          alignSelf={{ base: 'flex-start', sm: 'center' }}
          mr={{ sm: 'auto' }}
          data-testid="slip-details-toggle"
        >
          Details
        </Button>
        <Button variant="ghost" onClick={p.onClose} _hover={HOVER_EFFECTS.borderHighlight} w={{ base: '100%', sm: 'auto' }} {...common}>
          Close
        </Button>
        {p.phase.k === 'demo' ? (
          <DemoAwareCta onAction={() => undefined} minH="44px" w={{ base: '100%', sm: 'auto' }} fontFamily={TYPOGRAPHY.fontMono} data-testid="slip-primary">
            {p.kind === 'migrate' ? 'Migrate' : 'Deploy'}
          </DemoAwareCta>
        ) : revokable ? (
          <Button variant="outline" onClick={p.onRevoke} isDisabled={(p.phase.k === 'settled' || p.phase.k === 'failed') && p.phase.revoke !== 'idle'} w={{ base: '100%', sm: 'auto' }} data-testid="slip-revoke-button" {...common}>
            {revokeLabel}
          </Button>
        ) : (
          <Button onClick={p.onStart} isDisabled={btn.disabled} data-testid="slip-primary" w={{ base: '100%', sm: 'auto' }} {...common}>
            {btn.label}
          </Button>
        )}
      </Stack>
      {btn.why && p.phase.k !== 'demo' && (
        <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} textAlign="right" data-testid="slip-disabled-why">
          {btn.why}
        </Text>
      )}
    </VStack>
  )
}

export const SlipView: React.FC<SlipViewProps> = (p) => {
  const [details, setDetails] = useState(false)
  const toggle = () => setDetails((v) => !v)
  const header = (
    <HStack justify="space-between" align="baseline" spacing={SPACING.md}>
      <Text id="migrate-slip-title" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h3} fontWeight={TYPOGRAPHY.semibold} color={SEMANTIC_COLORS.textPrimary}>
        {TITLE[p.kind]}
      </Text>
      <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary} whiteSpace="nowrap" data-testid="slip-source">
        {p.stamp}
      </Text>
    </HStack>
  )
  const testid = p.kind === 'migrate' ? 'migrate-sheet' : 'deploy-sheet'
  if (p.inline) {
    return (
      <Box
        role="dialog"
        aria-labelledby="migrate-slip-title"
        data-testid={testid}
        data-phase={p.phase.k}
        bg={SEMANTIC_COLORS.bgSecondary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        borderRadius={0}
        w="100%"
        maxW="480px"
        mx="auto"
        px={SPACING.lg}
        py={SPACING.lg}
      >
        <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch">
          {header}
          <Box id="migrate-slip-details">
            <Body {...p} details={details} />
          </Box>
          <Box pt={SPACING.sm}>
            <Footer {...p} details={details} toggle={toggle} />
          </Box>
        </VStack>
      </Box>
    )
  }
  return (
    <Modal isOpen={p.isOpen ?? true} onClose={p.onClose} size={{ base: 'full', md: 'md' }} scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent
        aria-labelledby="migrate-slip-title"
        data-testid={testid}
        data-phase={p.phase.k}
        bg={SEMANTIC_COLORS.bgSecondary}
        borderRadius={0}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
      >
        <ModalHeader pr={SPACING['2xl']}>{header}</ModalHeader>
        <ModalCloseButton _focus={FOCUS_STYLES.ring} aria-label="Close" />
        <ModalBody pb={SPACING_PATTERNS.modalPadding} id="migrate-slip-details">
          <Body {...p} details={details} />
        </ModalBody>
        <ModalFooter pt={SPACING_PATTERNS.modalPadding}>
          <Footer {...p} details={details} toggle={toggle} />
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default SlipView
