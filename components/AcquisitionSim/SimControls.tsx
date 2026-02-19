import React, { useCallback } from 'react'
import {
  Box,
  VStack,
  HStack,
  Text,
  Button,
  NumberInput,
  NumberInputField,
  NumberInputStepper,
  NumberIncrementStepper,
  NumberDecrementStepper,
  Select,
  IconButton,
  Divider,
  Accordion,
  AccordionItem,
  AccordionButton,
  AccordionPanel,
  AccordionIcon,
  FormControl,
  FormLabel,
} from '@chakra-ui/react'
import { AddIcon, DeleteIcon } from '@chakra-ui/icons'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import type { SimConfig, SimEvent, UtilizationPoint } from './engine/types'
import { DEFAULT_CONFIG } from './engine/types'
import { PRESETS, type SimPreset } from './presets'

interface SimControlsProps {
  config: SimConfig
  events: SimEvent[]
  utilizationCurve: UtilizationPoint[]
  onConfigChange: (config: SimConfig) => void
  onEventsChange: (events: SimEvent[]) => void
  onUtilizationChange: (curve: UtilizationPoint[]) => void
}

export const SimControls: React.FC<SimControlsProps> = ({
  config,
  events,
  utilizationCurve,
  onConfigChange,
  onEventsChange,
  onUtilizationChange,
}) => {
  // ── Preset selection ──
  const handlePreset = useCallback(
    (presetId: string) => {
      const preset = PRESETS.find((p) => p.id === presetId)
      if (!preset) return
      onConfigChange({ ...DEFAULT_CONFIG, ...preset.config })
      onEventsChange([...preset.events])
      onUtilizationChange([...preset.utilizationCurve])
    },
    [onConfigChange, onEventsChange, onUtilizationChange]
  )

  // ── Config field update ──
  const updateConfig = useCallback(
    (key: keyof SimConfig, value: number) => {
      onConfigChange({ ...config, [key]: value })
    },
    [config, onConfigChange]
  )

  // ── Event management ──
  const addEvent = useCallback(() => {
    onEventsChange([
      ...events,
      { dayOffset: 1, type: 'deposit', amount: 100_000_000 },
    ])
  }, [events, onEventsChange])

  const removeEvent = useCallback(
    (index: number) => {
      onEventsChange(events.filter((_, i) => i !== index))
    },
    [events, onEventsChange]
  )

  const updateEvent = useCallback(
    (index: number, field: keyof SimEvent, value: any) => {
      const updated = events.map((e, i) =>
        i === index ? { ...e, [field]: value } : e
      )
      onEventsChange(updated)
    },
    [events, onEventsChange]
  )

  // ── Utilization point management ──
  const addUtilPoint = useCallback(() => {
    const lastDay =
      utilizationCurve.length > 0
        ? utilizationCurve[utilizationCurve.length - 1].dayOffset + 5
        : 0
    onUtilizationChange([
      ...utilizationCurve,
      { dayOffset: lastDay, utilization: 0.5 },
    ])
  }, [utilizationCurve, onUtilizationChange])

  const removeUtilPoint = useCallback(
    (index: number) => {
      onUtilizationChange(utilizationCurve.filter((_, i) => i !== index))
    },
    [utilizationCurve, onUtilizationChange]
  )

  const updateUtilPoint = useCallback(
    (index: number, field: keyof UtilizationPoint, value: number) => {
      const updated = utilizationCurve.map((p, i) =>
        i === index ? { ...p, [field]: value } : p
      )
      onUtilizationChange(updated)
    },
    [utilizationCurve, onUtilizationChange]
  )

  return (
    <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch">
      {/* ── Scenario Presets ── */}
      <Box>
        <Text
          fontSize={TYPOGRAPHY.label}
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textTertiary}
          mb={SPACING.sm}
        >
          Preset Scenarios
        </Text>
        <Select
          placeholder="Select a scenario..."
          onChange={(e) => handlePreset(e.target.value)}
          bg="rgba(255, 255, 255, 0.05)"
          borderColor="rgba(255, 255, 255, 0.2)"
          _hover={{ borderColor: 'rgba(255, 255, 255, 0.4)' }}
          _focus={FOCUS_STYLES.ring}
          fontSize={TYPOGRAPHY.small}
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id} style={{ background: '#1a1a2e' }}>
              {p.label}
            </option>
          ))}
        </Select>
      </Box>

      <Divider borderColor="rgba(255, 255, 255, 0.1)" />

      {/* ── Accordion for config sections ── */}
      <Accordion allowMultiple defaultIndex={[0, 1, 2]}>
        {/* ── Parameters ── */}
        <AccordionItem border="none">
          <AccordionButton
            px={0}
            _hover={{ bg: 'transparent' }}
          >
            <Text
              flex="1"
              textAlign="left"
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              color={SEMANTIC_COLORS.textTertiary}
            >
              Parameters
            </Text>
            <AccordionIcon color={SEMANTIC_COLORS.textTertiary} />
          </AccordionButton>
          <AccordionPanel px={0} pb={SPACING.base}>
            <VStack spacing={SPACING.sm} align="stretch">
              <ConfigField
                label="Base Rate (uMBRN/sec)"
                value={config.baseAcquisitionRate}
                onChange={(v) => updateConfig('baseAcquisitionRate', v)}
                step={50}
                min={0}
                max={5000}
                precision={3}
              />
              <ConfigField
                label="Max Emission (uMBRN)"
                value={config.maxMbrnEmission}
                onChange={(v) => updateConfig('maxMbrnEmission', v)}
                step={100_000_000}
                min={0}
              />
              <ConfigField
                label="Target Utilization"
                value={config.targetUtilization}
                onChange={(v) => updateConfig('targetUtilization', v)}
                step={0.05}
                min={0}
                max={1}
                precision={2}
              />
              <ConfigField
                label="Max Rate Change"
                value={config.maxRateChangePerMutation}
                onChange={(v) => updateConfig('maxRateChangePerMutation', v)}
                step={0.05}
                min={0}
                max={1}
                precision={2}
              />
              <ConfigField
                label="Bump Increment"
                value={config.bumpIncrement}
                onChange={(v) => updateConfig('bumpIncrement', v)}
                step={0.0005}
                min={0}
                max={0.1}
                precision={4}
              />
              <ConfigField
                label="Bump Interval (sec)"
                value={config.bumpIntervalSeconds}
                onChange={(v) => updateConfig('bumpIntervalSeconds', v)}
                step={1000}
                min={1000}
              />
              <ConfigField
                label="Decay Multiplier"
                value={config.reductionSpeedMultiplier}
                onChange={(v) => updateConfig('reductionSpeedMultiplier', v)}
                step={1}
                min={1}
                max={10}
              />
              <ConfigField
                label="Initial Bump Rate"
                value={config.initialBumpRate}
                onChange={(v) => updateConfig('initialBumpRate', v)}
                step={0.005}
                min={0}
                max={0.5}
                precision={3}
              />
              <ConfigField
                label="Max LTV (display)"
                value={config.maxLTV}
                onChange={(v) => updateConfig('maxLTV', v)}
                step={0.05}
                min={0}
                max={1}
                precision={2}
              />
              <ConfigField
                label="Deposit Period (days)"
                value={config.depositPeriodDays}
                onChange={(v) => updateConfig('depositPeriodDays', v)}
                step={1}
                min={1}
                max={60}
              />
              <ConfigField
                label="Withdrawal Period (days)"
                value={config.withdrawalPeriodDays}
                onChange={(v) => updateConfig('withdrawalPeriodDays', v)}
                step={1}
                min={1}
                max={30}
              />
              <ConfigField
                label="Cliff Period (days)"
                value={config.cliffPeriodDays}
                onChange={(v) => updateConfig('cliffPeriodDays', v)}
                step={1}
                min={0}
                max={180}
              />
            </VStack>
          </AccordionPanel>
        </AccordionItem>

        {/* ── Deposit/Withdrawal Events ── */}
        <AccordionItem border="none">
          <AccordionButton
            px={0}
            _hover={{ bg: 'transparent' }}
          >
            <Text
              flex="1"
              textAlign="left"
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              color={SEMANTIC_COLORS.textTertiary}
            >
              Events ({events.length})
            </Text>
            <AccordionIcon color={SEMANTIC_COLORS.textTertiary} />
          </AccordionButton>
          <AccordionPanel px={0} pb={SPACING.base}>
            <VStack spacing={SPACING.sm} align="stretch">
              {events.map((evt, i) => (
                <HStack key={i} spacing={SPACING.xs}>
                  <Select
                    value={evt.type}
                    onChange={(e) =>
                      updateEvent(i, 'type', e.target.value)
                    }
                    size="sm"
                    w="110px"
                    bg="rgba(255, 255, 255, 0.05)"
                    borderColor="rgba(255, 255, 255, 0.2)"
                    fontSize={TYPOGRAPHY.xs}
                  >
                    <option
                      value="deposit"
                      style={{ background: '#1a1a2e' }}
                    >
                      Deposit
                    </option>
                    <option
                      value="withdrawal"
                      style={{ background: '#1a1a2e' }}
                    >
                      Withdraw
                    </option>
                  </Select>
                  <NumberInput
                    value={evt.dayOffset}
                    onChange={(_, v) =>
                      updateEvent(i, 'dayOffset', isNaN(v) ? 0 : v)
                    }
                    size="sm"
                    min={0}
                    step={0.5}
                    precision={1}
                    w="70px"
                  >
                    <NumberInputField
                      bg="rgba(255, 255, 255, 0.05)"
                      borderColor="rgba(255, 255, 255, 0.2)"
                      fontSize={TYPOGRAPHY.xs}
                      px={SPACING.xs}
                    />
                  </NumberInput>
                  <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary} whiteSpace="nowrap">
                    d
                  </Text>
                  <NumberInput
                    value={evt.amount}
                    onChange={(_, v) =>
                      updateEvent(i, 'amount', isNaN(v) ? 0 : v)
                    }
                    size="sm"
                    min={0}
                    step={50_000_000}
                    flex={1}
                  >
                    <NumberInputField
                      bg="rgba(255, 255, 255, 0.05)"
                      borderColor="rgba(255, 255, 255, 0.2)"
                      fontSize={TYPOGRAPHY.xs}
                      px={SPACING.xs}
                    />
                  </NumberInput>
                  <IconButton
                    aria-label="Remove event"
                    icon={<DeleteIcon />}
                    size="xs"
                    variant="ghost"
                    colorScheme="red"
                    onClick={() => removeEvent(i)}
                  />
                </HStack>
              ))}
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<AddIcon />}
                onClick={addEvent}
                fontSize={TYPOGRAPHY.xs}
              >
                Add Event
              </Button>
            </VStack>
          </AccordionPanel>
        </AccordionItem>

        {/* ── Utilization Curve ── */}
        <AccordionItem border="none">
          <AccordionButton
            px={0}
            _hover={{ bg: 'transparent' }}
          >
            <Text
              flex="1"
              textAlign="left"
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              color={SEMANTIC_COLORS.textTertiary}
            >
              Utilization Curve ({utilizationCurve.length} pts)
            </Text>
            <AccordionIcon color={SEMANTIC_COLORS.textTertiary} />
          </AccordionButton>
          <AccordionPanel px={0} pb={SPACING.base}>
            <VStack spacing={SPACING.sm} align="stretch">
              {utilizationCurve.map((pt, i) => (
                <HStack key={i} spacing={SPACING.xs}>
                  <Text
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                    w="30px"
                  >
                    Day
                  </Text>
                  <NumberInput
                    value={pt.dayOffset}
                    onChange={(_, v) =>
                      updateUtilPoint(i, 'dayOffset', isNaN(v) ? 0 : v)
                    }
                    size="sm"
                    min={0}
                    step={1}
                    precision={1}
                    w="70px"
                  >
                    <NumberInputField
                      bg="rgba(255, 255, 255, 0.05)"
                      borderColor="rgba(255, 255, 255, 0.2)"
                      fontSize={TYPOGRAPHY.xs}
                      px={SPACING.xs}
                    />
                  </NumberInput>
                  <Text
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                    w="30px"
                  >
                    Util
                  </Text>
                  <NumberInput
                    value={pt.utilization}
                    onChange={(_, v) =>
                      updateUtilPoint(i, 'utilization', isNaN(v) ? 0 : v)
                    }
                    size="sm"
                    min={0}
                    max={1}
                    step={0.05}
                    precision={2}
                    flex={1}
                  >
                    <NumberInputField
                      bg="rgba(255, 255, 255, 0.05)"
                      borderColor="rgba(255, 255, 255, 0.2)"
                      fontSize={TYPOGRAPHY.xs}
                      px={SPACING.xs}
                    />
                  </NumberInput>
                  <IconButton
                    aria-label="Remove point"
                    icon={<DeleteIcon />}
                    size="xs"
                    variant="ghost"
                    colorScheme="red"
                    onClick={() => removeUtilPoint(i)}
                  />
                </HStack>
              ))}
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<AddIcon />}
                onClick={addUtilPoint}
                fontSize={TYPOGRAPHY.xs}
              >
                Add Point
              </Button>
            </VStack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </VStack>
  )
}

// ─── Reusable config field ────────────────────────────────────────────────

interface ConfigFieldProps {
  label: string
  value: number
  onChange: (value: number) => void
  step?: number
  min?: number
  max?: number
  precision?: number
}

const ConfigField: React.FC<ConfigFieldProps> = ({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  precision = 0,
}) => (
  <FormControl>
    <FormLabel
      fontSize={TYPOGRAPHY.xs}
      color={SEMANTIC_COLORS.textSecondary}
      mb={0}
    >
      {label}
    </FormLabel>
    <NumberInput
      value={precision > 0 ? value.toFixed(precision) : value}
      onChange={(_, v) => onChange(isNaN(v) ? 0 : v)}
      size="sm"
      step={step}
      min={min}
      max={max}
      precision={precision}
    >
      <NumberInputField
        bg="rgba(255, 255, 255, 0.05)"
        borderColor="rgba(255, 255, 255, 0.2)"
        fontSize={TYPOGRAPHY.xs}
        _focus={FOCUS_STYLES.ring}
      />
      <NumberInputStepper>
        <NumberIncrementStepper borderColor="rgba(255, 255, 255, 0.1)" />
        <NumberDecrementStepper borderColor="rgba(255, 255, 255, 0.1)" />
      </NumberInputStepper>
    </NumberInput>
  </FormControl>
)
