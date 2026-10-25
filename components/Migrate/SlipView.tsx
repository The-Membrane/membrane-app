import React, { useState } from 'react'
import {
  Box,
  Button,
  Collapse,
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
import type { MigrationPlan, PlanRow, RowTone } from '@/lib/migrate/types'

import type { Phase } from './useMigrateFlow'

/**
 * THE ORDER SLIP, presentational. Every state the sheet can be in renders from `phase` + `plan`;
 * no number is formatted here that the plan did not already carry.
 */
export interface SlipViewProps {
  kind: 'migrate' | 'deploy'
  isOpen?: boolean
  plan: MigrationPlan
  phase: Phase
  /** Where the rows come from: the replay, or a read on the connected chain. */
  sourceStamp: string
  promptIds: string[] | null
  addresses: { label: string; address: string }[]
  notes?: string[]
  explorerUrl?: (hash: string) => string | null
  onStart: () => void
  /** Optional revoke of the standing grants after a settled migration. */
  onRevoke?: () => void
  onClose: () => void
  /** Rendered inline (dev page) instead of in a portal modal. */
  inline?: boolean
}

const toneColor = (t: RowTone | undefined) =>
  t === 'danger' ? SEMANTIC_COLORS.danger : t === 'warn' ? SEMANTIC_COLORS.warning : t === 'muted' ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.textPrimary

const Label: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} textTransform="uppercase" letterSpacing="0.28em" color={color ?? SEMANTIC_COLORS.textSecondary}>
    {children}
  </Text>
)

const Row: React.FC<{ row: PlanRow }> = ({ row }) => (
  <Box py={SPACING.sm} borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} data-row={row.key}>
    <HStack justify="space-between" align="baseline" spacing={SPACING.md}>
      <Label>{row.label}</Label>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.body} fontWeight={TYPOGRAPHY.medium} color={toneColor(row.tone)} textAlign="right" whiteSpace="nowrap">
        {row.value}
      </Text>
    </HStack>
    {row.detail && (
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} mt={SPACING.xs}>
        {row.detail}
      </Text>
    )}
  </Box>
)

/** A callout for trim / blocked / chain states: hairline box, state colour on the text only. */
const Callout: React.FC<{ tone: 'danger' | 'warn' | 'info'; title: string; children: React.ReactNode }> = ({ tone, title, children }) => {
  const c = tone === 'danger' ? SEMANTIC_COLORS.danger : tone === 'warn' ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.info
  return (
    <Box w="100%" border="1px solid" borderColor={c} borderRadius={0} p={SPACING_PATTERNS.cardPadding} data-testid="slip-callout">
      <Label color={c}>{title}</Label>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary} mt={SPACING.xs}>
        {children}
      </Text>
    </Box>
  )
}

function statusLine(phase: Phase, kind: 'migrate' | 'deploy'): { text: string; color: string } | null {
  switch (phase.k) {
    case 'reading':
      return { text: 'Reading your position on the connected chain…', color: SEMANTIC_COLORS.textSecondary }
    case 'ready':
      return { text: 'Rows read on-chain · the exact transaction is simulated next, before anything is signed', color: SEMANTIC_COLORS.textSecondary }
    case 'simulating':
      return { text: 'Simulating the exact transaction (eth_simulateV1, nothing is signed)…', color: SEMANTIC_COLORS.textSecondary }
    case 'simulated':
      return { text: `Simulated OK · ${phase.gas.toLocaleString('en-US')} gas · nothing signed yet`, color: SEMANTIC_COLORS.success }
    case 'signing':
      return { text: `Prompt ${phase.index} of ${phase.total} — check your wallet`, color: SEMANTIC_COLORS.warning }
    case 'submitted':
      return { text: `Submitted · waiting for the block (${phase.hash.slice(0, 10)}…)`, color: SEMANTIC_COLORS.warning }
    case 'settled':
      return { text: kind === 'migrate' ? 'Settled · the position now lives on Membrane' : 'Settled · the Membrane position is open', color: SEMANTIC_COLORS.success }
    default:
      return null
  }
}

function primary(phase: Phase, kind: 'migrate' | 'deploy', prompts: number | null): { label: string; disabled: boolean; why: string | null } {
  const go = kind === 'migrate' ? 'Migrate' : 'Deploy'
  const n = prompts === null ? '' : ` · ${prompts} prompt${prompts === 1 ? '' : 's'}`
  switch (phase.k) {
    case 'simulated':
      return { label: `${go}${n}`, disabled: false, why: null }
    case 'wrong-chain':
      return { label: go, disabled: true, why: 'wrong chain' }
    case 'no-deployment':
      return { label: go, disabled: true, why: 'no Membrane deployment on this chain' }
    case 'blocked':
      return { label: go, disabled: true, why: 'this position cannot move in one transaction' }
    case 'trim':
      return { label: 'Trim first', disabled: true, why: 'over Membrane’s borrow LTV' }
    case 'sim-failed':
      return { label: go, disabled: true, why: 'the simulation reverted' }
    case 'ready':
      return { label: `Simulate${n}`, disabled: true, why: 'simulation runs first' }
    case 'reading':
    case 'simulating':
      return { label: 'Simulating…', disabled: true, why: null }
    case 'signing':
    case 'submitted':
      return { label: 'In progress…', disabled: true, why: null }
    case 'settled':
      return { label: 'Done', disabled: true, why: null }
    case 'failed':
      return { label: go, disabled: true, why: 'the run stopped' }
    default:
      return { label: go, disabled: true, why: null }
  }
}

const KIND_TAG: Record<'tx' | 'typed-data', string> = { tx: 'TX', 'typed-data': 'SIG' }

const SlipBody: React.FC<SlipViewProps> = (p) => {
  const [advanced, setAdvanced] = useState(false)
  const { plan, phase } = p
  const status = statusLine(phase, p.kind)
  const steps = plan.signatures
  return (
    <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch" w="100%">
      {phase.k === 'demo' && <DemoBanner note={p.kind === 'migrate' ? 'connect to migrate your own position' : 'connect to deploy your own'} />}
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary} data-testid="slip-source">
        {p.sourceStamp}
      </Text>

      {phase.k === 'wrong-chain' && <Callout tone="warn" title="Wrong chain">{phase.reason}</Callout>}
      {phase.k === 'no-deployment' && <Callout tone="warn" title="No Membrane deployment">{phase.reason}</Callout>}
      {phase.k === 'blocked' && <Callout tone="danger" title="Cannot migrate in one transaction">{phase.reason}</Callout>}
      {phase.k === 'trim' && <Callout tone="danger" title="Trim before migrating">{phase.reason}</Callout>}
      {phase.k === 'sim-failed' && <Callout tone="danger" title="Simulation reverted — nothing was signed">{phase.reason}</Callout>}
      {phase.k === 'failed' && <Callout tone="danger" title="Stopped">{phase.reason}</Callout>}

      <Box>
        {plan.rows.map((r) => (
          <Row key={r.key} row={r} />
        ))}
      </Box>

      {p.notes?.map((n) => (
        <Text key={n} fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.warning}>
          {n}
        </Text>
      ))}

      {steps.length > 0 && (
        <Box>
          <Label>What you sign</Label>
          <VStack spacing={SPACING.xs} align="stretch" mt={SPACING.sm} as="ol" listStyleType="none">
            {steps.map((s, i) => {
              const skipped = p.promptIds !== null && !p.promptIds.includes(s.id)
              const active = phase.k === 'signing' && phase.id === s.id
              return (
                <HStack as="li" key={s.id} spacing={SPACING.sm} align="baseline" opacity={skipped ? 0.45 : 1} data-step={s.id}>
                  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={active ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textTertiary} minW="5ch">
                    {String(i + 1).padStart(2, '0')} {KIND_TAG[s.kind]}
                  </Text>
                  <Box>
                    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={active ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textPrimary} textDecoration={skipped ? 'line-through' : undefined}>
                      {s.label}
                    </Text>
                    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                      {skipped ? `skipped — ${s.skippedWhen}` : s.why}
                    </Text>
                  </Box>
                </HStack>
              )
            })}
          </VStack>
        </Box>
      )}

      {status && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={status.color} data-testid="slip-status">
          {status.text}
        </Text>
      )}
      {(phase.k === 'settled' || phase.k === 'submitted' || (phase.k === 'failed' && phase.hash)) && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} wordBreak="break-all">
          tx {'hash' in phase ? phase.hash : ''}
          {'hash' in phase && phase.hash && p.explorerUrl?.(phase.hash) ? ` · ${p.explorerUrl(phase.hash)}` : ''}
        </Text>
      )}

      {phase.k === 'settled' && phase.note && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} data-testid="slip-settled-note">
          {phase.note}
        </Text>
      )}
      {phase.k === 'settled' && phase.revoke && plan.venue && (
        <Box border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} borderRadius={0} p={SPACING_PATTERNS.cardPadding} data-testid="slip-revoke">
          <Label>Optional · revoke the standing grants</Label>
          {revokeSteps(plan.venue).map((r) => (
            <Text key={r.id} fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} mt={SPACING.xs}>
              {KIND_TAG[r.kind]} {r.label} — {r.why}
            </Text>
          ))}
          <Button
            variant="outline"
            mt={SPACING.sm}
            minH="44px"
            borderRadius={0}
            fontFamily={TYPOGRAPHY.fontMono}
            transition={TRANSITIONS.colors}
            _focus={FOCUS_STYLES.ring}
            isDisabled={phase.revoke !== 'idle'}
            onClick={p.onRevoke}
            data-testid="slip-revoke-button"
          >
            {phase.revoke === 'idle' ? 'Revoke the adapter' : phase.revoke === 'running' ? 'Revoking…' : phase.revoke === 'done' ? 'Revoked' : 'Revoke failed'}
          </Button>
        </Box>
      )}

      <Box>
        <Button
          variant="link"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          textTransform="uppercase"
          letterSpacing="0.28em"
          color={SEMANTIC_COLORS.textSecondary}
          transition={TRANSITIONS.colors}
          _focus={FOCUS_STYLES.ring}
        >
          {advanced ? '− Advanced' : '+ Advanced'}
        </Button>
        <Collapse in={advanced} animateOpacity>
          <VStack spacing={SPACING.xs} align="stretch" mt={SPACING.sm}>
            {p.kind === 'migrate' && (
              <>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                  flash source · {FLASH_SOURCE}
                </Text>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                  accrual buffer · {ACCRUAL_BUFFER_BPS} bps over the debt read; borrowed, and the part the venue did not need comes back to you
                </Text>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                  LTV margin · {(LTV_MARGIN * 100).toFixed(1)}pp under the borrow LTV; the adapter re-checks the LTV on-chain at Membrane’s price and the whole transaction reverts above it
                </Text>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                  permits · exact amounts, used up in the transaction; nothing is left approved
                </Text>
              </>
            )}
            {p.addresses.map((a) => (
              <Text key={a.label} fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary} wordBreak="break-all">
                {a.label} · {a.address}
              </Text>
            ))}
          </VStack>
        </Collapse>
      </Box>
    </VStack>
  )
}

const Footer: React.FC<SlipViewProps> = (p) => {
  const prompts = p.promptIds?.length ?? null
  const btn = primary(p.phase, p.kind, prompts)
  const common = {
    borderRadius: 0,
    minH: '44px',
    transition: TRANSITIONS.colors,
    _active: ACTIVE_EFFECTS.dim,
    _focus: FOCUS_STYLES.ring,
    fontFamily: TYPOGRAPHY.fontMono,
  }
  return (
    <VStack align="stretch" spacing={SPACING.xs} w="100%">
      <Stack direction={{ base: 'column-reverse', sm: 'row' }} spacing={SPACING_PATTERNS.buttonGroupGap} justify="flex-end" w="100%">
        <Button variant="ghost" onClick={p.onClose} _hover={HOVER_EFFECTS.borderHighlight} w={{ base: '100%', sm: 'auto' }} {...common}>
          Close
        </Button>
        {p.phase.k === 'demo' ? (
          <DemoAwareCta onAction={() => undefined} minH="44px" w={{ base: '100%', sm: 'auto' }} fontFamily={TYPOGRAPHY.fontMono} data-testid="slip-primary">
            {p.kind === 'migrate' ? 'Migrate' : 'Deploy'}
          </DemoAwareCta>
        ) : (
          <Button onClick={p.onStart} isDisabled={btn.disabled} data-testid="slip-primary" w={{ base: '100%', sm: 'auto' }} {...common}>
            {btn.label}
          </Button>
        )}
      </Stack>
      {btn.why && p.phase.k !== 'demo' && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} textAlign="right" data-testid="slip-disabled-why">
          disabled · {btn.why}
        </Text>
      )}
    </VStack>
  )
}

const TITLE = { migrate: 'Migrate this position', deploy: 'Deploy fresh on Membrane' }

export const SlipView: React.FC<SlipViewProps> = (p) => {
  const eyebrow =
    p.kind === 'migrate'
      ? `Migrate · ${p.plan.sourceLabel.split(' · ')[0]} → Membrane`
      : 'Deploy fresh · prefilled from the replay'
  const header = (
    <Box>
      <Label>{eyebrow}</Label>
      <Text id="migrate-slip-title" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2} fontWeight={TYPOGRAPHY.semibold} color={SEMANTIC_COLORS.textPrimary} mt={SPACING.xs}>
        {TITLE[p.kind]}
      </Text>
    </Box>
  )
  if (p.inline) {
    return (
      <Box
        role="dialog"
        aria-labelledby="migrate-slip-title"
        data-testid={p.kind === 'migrate' ? 'migrate-sheet' : 'deploy-sheet'}
        data-phase={p.phase.k}
        bg={SEMANTIC_COLORS.bgSecondary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        borderRadius={0}
        w="100%"
        maxW="560px"
        mx="auto"
      >
        <Box px={SPACING.lg} pt={SPACING.lg} pb={SPACING.base}>{header}</Box>
        <Box px={SPACING.lg} pb={SPACING_PATTERNS.modalPadding}>
          <SlipBody {...p} />
        </Box>
        <Box px={SPACING.lg} pb={SPACING.lg} pt={SPACING.sm}>
          <Footer {...p} />
        </Box>
      </Box>
    )
  }
  return (
    <Modal isOpen={p.isOpen ?? true} onClose={p.onClose} size={{ base: 'full', md: 'lg' }} scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent
        aria-labelledby="migrate-slip-title"
        data-testid={p.kind === 'migrate' ? 'migrate-sheet' : 'deploy-sheet'}
        data-phase={p.phase.k}
        bg={SEMANTIC_COLORS.bgSecondary}
        borderRadius={0}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
      >
        <ModalHeader>{header}</ModalHeader>
        <ModalCloseButton _focus={FOCUS_STYLES.ring} aria-label="Close" />
        <ModalBody pb={SPACING_PATTERNS.modalPadding}>
          <SlipBody {...p} />
        </ModalBody>
        <ModalFooter pt={SPACING_PATTERNS.modalPadding}>
          <Footer {...p} />
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default SlipView
