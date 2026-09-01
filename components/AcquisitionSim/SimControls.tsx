import React from 'react'
import { VStack, Divider, Accordion } from '@chakra-ui/react'
import { SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import type { SimConfig, SimEvent, UtilizationPoint } from './engine/types'
import { SimControlsPresets } from './SimControlsPresets'
import { SimControlsParameters } from './SimControlsParameters'
import { SimControlsEvents } from './SimControlsEvents'
import { SimControlsUtilization } from './SimControlsUtilization'

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
  return (
    <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch">
      {/* ── Scenario Presets ── */}
      <SimControlsPresets
        onConfigChange={onConfigChange}
        onEventsChange={onEventsChange}
        onUtilizationChange={onUtilizationChange}
      />

      <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

      {/* ── Accordion for config sections ── */}
      <Accordion allowMultiple defaultIndex={[0, 1, 2]}>
        {/* ── Parameters ── */}
        <SimControlsParameters config={config} onConfigChange={onConfigChange} />

        {/* ── Deposit/Withdrawal Events ── */}
        <SimControlsEvents events={events} onEventsChange={onEventsChange} />

        {/* ── Utilization Curve ── */}
        <SimControlsUtilization
          utilizationCurve={utilizationCurve}
          onUtilizationChange={onUtilizationChange}
        />
      </Accordion>
    </VStack>
  )
}
