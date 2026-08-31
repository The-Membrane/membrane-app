import React, { useState } from 'react'
import { Box } from '@chakra-ui/react'

import { DemoBanner } from '@/components/demo'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { useChainRoute } from '@/hooks/useChainRoute'

import Collateral from './Collateral'
import ExecSheet from './ExecSheet'
import Hero from './Hero'
import Ladder from './Ladder'
import MarketBoards from './MarketBoards'
import OracleCard from './OracleCard'
import RedemptionHistory from './RedemptionHistory'
import Timeline from './Timeline'
import { COLL, DEFAULT_PRESET, LEV, PRESETS } from './fixtures'
import { boardToPreset, parseAmount, presetExec, rungExec } from './utils'
import { Board, ExecConfig, Preset } from './types'

/**
 * Carry — borrow against yield-bearing dollars and route the debt in the same
 * motion. Ported from public/proto/carry.html. Demo-first (V20): the page opens
 * fully populated from fixtures under DemoBanner; every transact CTA is a
 * DemoAwareCta that connects first, then replays the confirm sheet.
 */
export const Carry: React.FC = () => {
  const { chainName } = useChainRoute()

  // Hero dial state
  const [heroAmount, setHeroAmount] = useState('10000')
  const [presets, setPresets] = useState<Preset[]>(PRESETS)
  const [selectedPreset, setSelectedPreset] = useState(DEFAULT_PRESET)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Advanced ladder state
  const [selColl, setSelColl] = useState(0)
  const [rung, setRung] = useState(1)
  const [ladderAmount, setLadderAmount] = useState('10000')

  // Overlays
  const [exec, setExec] = useState<ExecConfig | null>(null)
  const [oracleSym, setOracleSym] = useState<string | null>(null)

  const openPresetCarry = () => setExec(presetExec(presets[selectedPreset], parseAmount(heroAmount)))

  const openRungCarry = (rungIndex: number) => setExec(rungExec(COLL[selColl], LEV[rungIndex], parseAmount(ladderAmount)))

  // Loading a board becomes a fourth, named preset chip on the dial.
  const loadBoard = (b: Board) => {
    const loaded = boardToPreset(b)
    setPresets([...PRESETS, loaded])
    setSelectedPreset(3)
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const selectColl = (i: number) => {
    setSelColl(i)
    setRung(1)
  }

  return (
    <Box maxW="1140px" mx="auto" px={SPACING.base} py={SPACING.lg} bg={SEMANTIC_COLORS.bgPrimary} color={SEMANTIC_COLORS.textPrimary}>
      <DemoBanner note="wallet-scoped numbers are a demo wallet · live market data stays live" />

      <Box mt={SPACING.base}>
        <Hero
          chainName={chainName}
          amount={heroAmount}
          onAmountChange={setHeroAmount}
          presets={presets}
          selectedPreset={selectedPreset}
          onSelectPreset={setSelectedPreset}
          onOpenCarry={openPresetCarry}
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
        />
      </Box>

      <MarketBoards onLoadBoard={loadBoard} />

      {advancedOpen && (
        <Box>
          <Collateral selected={selColl} onSelect={selectColl} onOpenOracle={setOracleSym} />
          <Ladder
            chainName={chainName}
            selColl={selColl}
            rung={rung}
            onSelectRung={setRung}
            amount={ladderAmount}
            onAmountChange={setLadderAmount}
            onOpenRung={openRungCarry}
          />
        </Box>
      )}

      <RedemptionHistory onOpenOracle={setOracleSym} />
      <Timeline />

      <ExecSheet config={exec} onClose={() => setExec(null)} />
      <OracleCard sym={oracleSym} onClose={() => setOracleSym(null)} />
    </Box>
  )
}

export default Carry
