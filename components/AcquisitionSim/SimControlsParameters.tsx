import React, { useCallback } from 'react'
import {
  Text,
  VStack,
  NumberInput,
  NumberInputField,
  NumberInputStepper,
  NumberIncrementStepper,
  NumberDecrementStepper,
  AccordionItem,
  AccordionButton,
  AccordionPanel,
  AccordionIcon,
  FormControl,
  FormLabel,
} from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { FOCUS_STYLES } from '@/config/transitions'
import type { SimConfig } from './engine/types'

interface SimControlsParametersProps {
  config: SimConfig
  onConfigChange: (config: SimConfig) => void
}

export const SimControlsParameters: React.FC<SimControlsParametersProps> = ({
  config,
  onConfigChange,
}) => {
  // ── Config field update ──
  const updateConfig = useCallback(
    (key: keyof SimConfig, value: number) => {
      onConfigChange({ ...config, [key]: value })
    },
    [config, onConfigChange]
  )

  return (
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
        bg={SEMANTIC_COLORS.borderSubtle}
        borderColor={SEMANTIC_COLORS.borderSubtle}
        fontSize={TYPOGRAPHY.xs}
        _focus={FOCUS_STYLES.ring}
      />
      <NumberInputStepper>
        <NumberIncrementStepper borderColor={SEMANTIC_COLORS.borderSubtle} />
        <NumberDecrementStepper borderColor={SEMANTIC_COLORS.borderSubtle} />
      </NumberInputStepper>
    </NumberInput>
  </FormControl>
)
