// The sandbox inputs. No wallet: every field is a hypothetical position, and every change
// re-runs the engine after a short debounce (RiskFrontier.tsx), so typing is never blocked.

import React, { useEffect, useState } from 'react'
import { Box, Button, HStack, Input, SimpleGrid, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { EXIT_CAPACITY_PRESETS, EXIT_CAPACITY_PRESET_ORDER } from '@/lib/position-sim/stressGrid'
import type { MembraneClass } from '@/lib/position-sim/membrane'

import { Eyebrow, Panel } from './atoms'
import {
  LOADOUTS,
  classView,
  clampLine,
  pct,
  usd,
  usdOrNone,
  type CapacityChoice,
  type SandboxInputs,
  type SandboxPosition,
} from './viewModel'

const RANGE_SX = {
  appearance: 'none',
  WebkitAppearance: 'none',
  width: '100%',
  height: '20px',
  background: 'transparent',
  cursor: 'pointer',
  '&::-webkit-slider-runnable-track': { height: '2px', background: SEMANTIC_COLORS.borderStrong },
  '&::-moz-range-track': { height: '2px', background: SEMANTIC_COLORS.borderStrong },
  '&::-webkit-slider-thumb': {
    WebkitAppearance: 'none',
    appearance: 'none',
    width: '12px',
    height: '12px',
    background: SEMANTIC_COLORS.success,
    marginTop: '-5px',
    border: 0,
    borderRadius: 0,
    transform: 'rotate(45deg)',
  },
  '&::-moz-range-thumb': {
    width: '12px',
    height: '12px',
    background: SEMANTIC_COLORS.success,
    border: 0,
    borderRadius: 0,
    transform: 'rotate(45deg)',
  },
  '&:focus-visible': { outline: `1px solid ${SEMANTIC_COLORS.success}`, outlineOffset: '2px' },
} as const

const Range: React.FC<{
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}> = ({ id, label, value, min, max, step, onChange }) => (
  <Box
    as="input"
    id={id}
    type="range"
    aria-label={label}
    min={min}
    max={max}
    step={step}
    value={Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min}
    onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(Number(e.target.value))}
    sx={RANGE_SX}
  />
)

/** A dollar field that keeps the raw text while typing; the number flows up on every change. */
const UsdField: React.FC<{
  id: string
  label: string
  value: number
  onChange: (v: number) => void
  note?: React.ReactNode
}> = ({ id, label, value, onChange, note }) => {
  const [text, setText] = useState(() => String(Math.round(value)))
  // Follow outside changes (sliders, loadouts) without fighting the keyboard.
  useEffect(() => {
    const parsed = Number(text.replace(/[,$\s]/g, ''))
    if (!Number.isFinite(parsed) || Math.round(parsed) !== Math.round(value))
      setText(String(Math.round(value)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <Box>
      <HStack justify="space-between" align="baseline">
        <Eyebrow>
          <label htmlFor={id}>{label}</label>
        </Eyebrow>
        {note}
      </HStack>
      <HStack
        mt={SPACING.xs}
        spacing={0}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        _focusWithin={{ borderColor: SEMANTIC_COLORS.success }}
        transition={TRANSITIONS.colors}
      >
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
          pl={SPACING.sm}
        >
          $
        </Text>
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            const n = Number(e.target.value.replace(/[,$\s]/g, ''))
            if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= 0) onChange(n)
          }}
          variant="unstyled"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          px={SPACING.sm}
          py={SPACING.sm}
          h="auto"
          borderRadius={0}
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        />
      </HStack>
    </Box>
  )
}

const Chip: React.FC<{
  active: boolean
  onClick: () => void
  children: React.ReactNode
  /** Accessible name: the chip's visible text is stacked blocks, so name it outright. */
  label: string
  title?: string
  tone?: string
}> = ({ active, onClick, children, label, title, tone }) => (
  <Button
    onClick={onClick}
    aria-pressed={active}
    aria-label={label}
    title={title}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.label}
    fontWeight={400}
    letterSpacing="0.04em"
    borderRadius={0}
    h="auto"
    minH="30px"
    py={SPACING.sm}
    px={SPACING.sm}
    whiteSpace="normal"
    bg={active ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
    color={active ? (tone ?? SEMANTIC_COLORS.success) : SEMANTIC_COLORS.textSecondary}
    border="1px solid"
    borderColor={active ? (tone ?? SEMANTIC_COLORS.success) : SEMANTIC_COLORS.borderSubtle}
    boxShadow={active ? `inset 0 -2px 0 ${tone ?? SEMANTIC_COLORS.success}` : 'none'}
    transition={TRANSITIONS.colors}
    _hover={{ color: SEMANTIC_COLORS.textPrimary, borderColor: SEMANTIC_COLORS.borderStrong }}
    _focusVisible={FOCUS_STYLES.ring}
  >
    {children}
  </Button>
)

const Group: React.FC<{ label: string; children: React.ReactNode; right?: React.ReactNode }> = ({
  label,
  children,
  right,
}) => (
  <Box pt={SPACING.md} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
    <HStack justify="space-between" align="baseline" mb={SPACING.sm}>
      <Eyebrow>{label}</Eyebrow>
      {right}
    </HStack>
    {children}
  </Box>
)

const Readout: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.label}
    color={color ?? SEMANTIC_COLORS.textSecondary}
    sx={{ fontVariantNumeric: 'tabular-nums' }}
  >
    {children}
  </Text>
)

export const LoadoutPanel: React.FC<{
  inputs: SandboxInputs
  sandbox: SandboxPosition
  onChange: (next: SandboxInputs) => void
}> = ({ inputs, sandbox, onChange }) => {
  const set = <K extends keyof SandboxInputs>(k: K, v: SandboxInputs[K]) =>
    onChange({ ...inputs, [k]: v })
  const cv = classView(inputs.membraneClass)
  const carry = inputs.tradeShape === 'carry'
  const ltv = sandbox.startLtv
  const ltvColor =
    !Number.isFinite(ltv) || ltv >= sandbox.line
      ? SEMANTIC_COLORS.danger
      : ltv > sandbox.recallTarget
        ? SEMANTIC_COLORS.warning
        : SEMANTIC_COLORS.textPrimary
  const activeLoadout = LOADOUTS.find(
    (l) => JSON.stringify(l.inputs) === JSON.stringify(inputs),
  )?.id
  const cap = inputs.capacity
  const setCap = (c: CapacityChoice) => set('capacity', c)
  const setClass = (cls: MembraneClass) =>
    onChange({ ...inputs, membraneClass: cls, line: clampLine(inputs.line, cls) })

  return (
    <Panel p={SPACING.base} display="grid" gap={SPACING.md}>
      <Box>
        <Eyebrow color={SEMANTIC_COLORS.success}>Loadout</Eyebrow>
        <SimpleGrid columns={{ base: 2, sm: 3, lg: 2 }} spacing={SPACING.sm} mt={SPACING.sm}>
          {LOADOUTS.map((l) => (
            <Chip
              key={l.id}
              active={activeLoadout === l.id}
              onClick={() => onChange(l.inputs)}
              label={`Loadout ${l.name}: ${l.sub}`}
            >
              <Box textAlign="left" w="100%">
                <Text fontSize={TYPOGRAPHY.label}>{l.name}</Text>
                <Text
                  fontSize={TYPOGRAPHY.label}
                  color={SEMANTIC_COLORS.textTertiary}
                  mt={SPACING.none}
                >
                  {l.sub}
                </Text>
              </Box>
            </Chip>
          ))}
        </SimpleGrid>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textTertiary}
          mt={SPACING.sm}
        >
          Sandbox positions. No wallet, nothing signed.
        </Text>
      </Box>

      <Group label="Position">
        <SimpleGrid columns={2} spacing={SPACING.sm}>
          <UsdField
            id="rf-coll"
            label="Collateral"
            value={inputs.collateralUsd}
            onChange={(v) => set('collateralUsd', v)}
          />
          <UsdField
            id="rf-debt"
            label="Debt"
            value={inputs.debtUsd}
            onChange={(v) => set('debtUsd', v)}
          />
        </SimpleGrid>
        <HStack justify="space-between" mt={SPACING.sm} align="baseline">
          <Eyebrow>Start LTV</Eyebrow>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.h3}
            color={ltvColor}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {Number.isFinite(ltv) ? pct(ltv) : '—'}
          </Text>
        </HStack>
        <Range
          id="rf-ltv"
          label="Start LTV (moves the debt)"
          value={ltv}
          min={0.05}
          max={Math.max(0.06, cv.ceiling)}
          step={0.001}
          onChange={(v) => set('debtUsd', Math.round(v * inputs.collateralUsd))}
        />
      </Group>

      <Group label="Collateral class">
        <SimpleGrid columns={2} spacing={SPACING.sm}>
          {(['delayed', 'no-delay'] as MembraneClass[]).map((cls) => {
            const v = classView(cls)
            return (
              <Chip
                key={cls}
                active={inputs.membraneClass === cls}
                onClick={() => setClass(cls)}
                label={`${cls === 'delayed' ? 'Delayed' : 'No-delay'} class: ${v.ceilingText}, ${v.bandText}, ${v.windowText}`}
              >
                <Box textAlign="left" w="100%">
                  <Text fontSize={TYPOGRAPHY.label}>
                    {cls === 'delayed' ? 'Delayed' : 'No-delay'}
                  </Text>
                  <Text
                    fontSize={TYPOGRAPHY.label}
                    color={SEMANTIC_COLORS.textTertiary}
                    mt={SPACING.none}
                  >
                    {v.ceilingText} · {v.bandText}
                  </Text>
                  <Text fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textTertiary}>
                    {v.windowText}
                  </Text>
                </Box>
              </Chip>
            )
          })}
        </SimpleGrid>
        <HStack justify="space-between" mt={SPACING.md} align="baseline">
          <Eyebrow>Line</Eyebrow>
          <Readout color={SEMANTIC_COLORS.textPrimary}>
            {pct(sandbox.line)} · break {pct(sandbox.breakLine)}
          </Readout>
        </HStack>
        <Range
          id="rf-line"
          label={`Liquidation line, up to ${pct(cv.ceiling, 0)}`}
          value={inputs.line}
          min={0.4}
          max={cv.ceiling}
          step={0.005}
          onChange={(v) => set('line', clampLine(v, inputs.membraneClass))}
        />
        <Readout>
          recall target {pct(sandbox.recallTarget)} · clamped to {cv.ceilingText}
        </Readout>
      </Group>

      <Group label="Trade shape">
        <SimpleGrid columns={2} spacing={SPACING.sm}>
          <Chip
            active={carry}
            onClick={() => set('tradeShape', 'carry')}
            label="Carry: debt deployed, recall first"
          >
            <Box textAlign="left" w="100%">
              <Text fontSize={TYPOGRAPHY.label}>Carry</Text>
              <Text
                fontSize={TYPOGRAPHY.label}
                color={SEMANTIC_COLORS.textTertiary}
                mt={SPACING.none}
              >
                debt deployed · recall first
              </Text>
            </Box>
          </Chip>
          <Chip
            active={!carry}
            onClick={() => set('tradeShape', 'levered_long')}
            label="Levered long: no recall"
          >
            <Box textAlign="left" w="100%">
              <Text fontSize={TYPOGRAPHY.label}>Levered long</Text>
              <Text
                fontSize={TYPOGRAPHY.label}
                color={SEMANTIC_COLORS.textTertiary}
                mt={SPACING.none}
              >
                no recall rows
              </Text>
            </Box>
          </Chip>
        </SimpleGrid>
      </Group>

      {carry && (
        <Group label="Venue">
          <UsdField
            id="rf-deployed"
            label="Deployed"
            value={inputs.deployedUsd}
            onChange={(v) => set('deployedUsd', v)}
            note={
              sandbox.deployedClamped ? (
                <Readout color={SEMANTIC_COLORS.warning}>capped at the debt</Readout>
              ) : undefined
            }
          />
          <Range
            id="rf-deployed-range"
            label="Deployed share of the debt"
            value={inputs.debtUsd > 0 ? Math.min(1, inputs.deployedUsd / inputs.debtUsd) : 0}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set('deployedUsd', Math.round(v * inputs.debtUsd))}
          />
          <HStack justify="space-between" mt={SPACING.sm} align="baseline">
            <Eyebrow>Exit capacity</Eyebrow>
            <Readout color={SEMANTIC_COLORS.textPrimary}>
              {usdOrNone(sandbox.exitCapacityUsd)} · ×{sandbox.capacityMult?.toFixed(2)}
            </Readout>
          </HStack>
          <SimpleGrid columns={{ base: 3, sm: 5, lg: 3 }} spacing={SPACING.sm} mt={SPACING.sm}>
            {EXIT_CAPACITY_PRESET_ORDER.map((id) => (
              <Chip
                key={id}
                active={cap.kind === 'preset' && cap.preset === id}
                onClick={() => setCap({ kind: 'preset', preset: id })}
                label={`Exit capacity ${id}, ×${EXIT_CAPACITY_PRESETS[id].mult}`}
                title={EXIT_CAPACITY_PRESETS[id].provenance}
              >
                <Box textAlign="left" w="100%">
                  <Text fontSize={TYPOGRAPHY.label}>{id}</Text>
                  <Text fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textTertiary}>
                    ×{EXIT_CAPACITY_PRESETS[id].mult}
                  </Text>
                </Box>
              </Chip>
            ))}
            <Chip
              active={cap.kind === 'custom'}
              onClick={() => setCap({ kind: 'custom', mult: sandbox.capacityMult ?? 0.5 })}
              label="Exit capacity custom multiplier"
            >
              <Box textAlign="left" w="100%">
                <Text fontSize={TYPOGRAPHY.label}>custom</Text>
                <Text fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textTertiary}>
                  ×{cap.kind === 'custom' ? cap.mult.toFixed(2) : '…'}
                </Text>
              </Box>
            </Chip>
          </SimpleGrid>
          {cap.kind === 'custom' && (
            <Box mt={SPACING.sm}>
              <Range
                id="rf-cap-mult"
                label="Custom exit-capacity multiplier"
                value={cap.mult}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setCap({ kind: 'custom', mult: v })}
              />
              <Readout>
                exit = deployed × {cap.mult.toFixed(2)}, scaled with the deployed amount like a
                preset
              </Readout>
            </Box>
          )}
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={SEMANTIC_COLORS.textTertiary}
            mt={SPACING.sm}
            lineHeight={1.5}
          >
            {cap.kind === 'preset'
              ? EXIT_CAPACITY_PRESETS[cap.preset].provenance
              : 'A custom level you chose. Not a measured exit share.'}
          </Text>
        </Group>
      )}

      <Group label="Debt floor">
        <UsdField
          id="rf-dmin"
          label="Debt floor"
          value={inputs.debtMinimumUsd}
          onChange={(v) => set('debtMinimumUsd', v)}
        />
        <Readout>
          a liquidation never leaves debt under this; it repays all (a short recall sells the rest)
        </Readout>
      </Group>
    </Panel>
  )
}
