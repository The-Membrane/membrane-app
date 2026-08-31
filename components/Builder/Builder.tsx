// Carry Builder — port of public/proto/builder.html ("Variant B · builder").
// Drag venues onto three slots, tune BTC-in and draw, then sweep the board through a
// fifteen-floor, daily-seeded gauntlet. Always-on practice surface: NO wallet gate by
// design; fixture-driven blocks carry MockStamp instead.

import React, { useCallback, useRef } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

import CalibrationPanel from './CalibrationPanel'
import FactoryFloor from './FactoryFloor'
import GauntletStage, { InfoDetails } from './GauntletStage'
import Leaderboard from './Leaderboard'
import PartsTray from './PartsTray'
import Readout from './Readout'
import RunBar from './RunBar'
import SeedChip from './SeedChip'
import VerdictCard from './VerdictCard'
import { useBuilderEngine } from './hooks/useBuilderEngine'
import { useTileDrag } from './hooks/useTileDrag'

export const Builder: React.FC = () => {
  const { chainName } = useChainRoute()
  const shellRef = useRef<HTMLDivElement>(null)
  const runbarRef = useRef<HTMLDivElement>(null)

  const scroll = {
    toBoard: () => shellRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    toFloor: () => runbarRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  }
  const { view, actions } = useBuilderEngine(scroll)
  const drag = useTileDrag(actions.placeTileAt)

  const bTestLabel = view.bTestMode === 'continue' ? 'Continue' : view.history.length ? 'Run the gauntlet again' : 'Run the gauntlet'
  const playerLabel =
    'you — ' + (view.placed.map((t) => t.nm).join(' + ') || 'empty') + ' · ' + (view.st.ltv * 100).toFixed(0) + '%'

  const onDrill = useCallback((i: number) => actions.drillFloor(i), [actions])

  return (
    <Box maxW="1240px" mx="auto" px={{ base: SPACING.md, md: SPACING.lg }} pb={SPACING['2xl']} fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
      {/* header */}
      <Box py={SPACING.lg} pb={SPACING.base} display="grid" gap={SPACING.sm}>
        <Box display="flex" justifyContent="space-between" alignItems="baseline" gap={SPACING.md} flexWrap="wrap">
          <Text as="h1" fontFamily={TYPOGRAPHY.fontDisplay} fontSize="clamp(23px, 3.6vw, 34px)" lineHeight={1.12} sx={{ textWrap: 'balance' }} letterSpacing="-0.01em">
            Build the position.
          </Text>
          <Box
            as="button"
            type="button"
            onClick={actions.toggleView}
            bg="transparent"
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            color={SEMANTIC_COLORS.textSecondary}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="9px"
            letterSpacing="0.18em"
            textTransform="uppercase"
            px={SPACING.sm}
            py="5px"
            cursor="pointer"
            borderRadius={0}
            transition={TRANSITIONS.colors}
            _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
            _focusVisible={FOCUS_STYLES.ring}
          >
            view: {view.vet ? 'veteran' : 'first visit'}
          </Box>
        </Box>
        {!view.vet && (
          <Text fontSize="13px" color={SEMANTIC_COLORS.textSecondary} maxW="82ch">
            Drag venues onto the three slots. Belts carry borrowed CDT out, yield comes back. Then shock it — the shock is the only
            thing that grades you, because a build that earns more and dies is not a better build.
          </Text>
        )}
      </Box>

      {/* board shell: tray / floor / readout */}
      <Box ref={shellRef} display="grid" gridTemplateColumns={{ base: '1fr', lg: '200px 1fr 240px' }} border="1px solid" borderColor={SEMANTIC_COLORS.borderStrong}>
        <PartsTray slots={view.st.slots} vet={view.vet} onTemplate={actions.applyTemplate} onPlaceFree={actions.placeTileFree} drag={drag} />
        <FactoryFloor slots={view.st.slots} intent={view.st.intent} calc={view.calc} btc={view.st.btc} onRemoveSlot={actions.removeSlot} onIntent={actions.setIntent} />
        <Readout
          calc={view.calc}
          btc={view.st.btc}
          liqLine={view.liqLine}
          breakPoint={view.breakPoint}
          bTestLabel={bTestLabel}
          bTestDisabled={view.calc.p.length === 0 && view.bTestMode === 'run'}
          onBtc={actions.setBtc}
          onLtv={actions.setLtv}
          onRun={actions.runOrContinue}
          onClear={actions.clearBoard}
        />
      </Box>

      <InfoDetails title="The gauntlet" sr="How a floor works">
        Bitcoin moves and your LTV jumps. If it crosses the line the engine recalls whatever is liquid in your venues and puts it
        against the debt — only enough to get back under the line, not the whole loan — and only the shortfall is taken out of your
        bitcoin. So a venue’s recall number is the whole game: it is the share that actually comes back when it is asked, cooldowns
        and queues already priced in. That is why the highest-yield board is so rarely the best board.
      </InfoDetails>

      <SeedChip
        seed={view.seed}
        scenarioCount={view.scenarios.length}
        onApplySeed={actions.applySeed}
        onRandomize={actions.randomizeSeed}
        onBackToDaily={actions.backToDaily}
        challengeUrl={actions.challengeUrl}
      />

      <Box ref={runbarRef}>
        <RunBar
          scenarios={view.scenarios}
          run={view.run}
          practice={view.practice}
          maxReached={view.maxReached}
          rFloorLabel={view.rFloorLabel}
          netMade={view.netMade}
          runHint={view.stage.runHint}
          onDrill={onDrill}
        />
      </Box>

      {/* stage + calibration aside */}
      <Box display="grid" gridTemplateColumns={{ base: '1fr', md: 'minmax(0, 1fr) 310px' }} gap={SPACING.base} alignItems="start" mt={SPACING.md}>
        <GauntletStage
          stage={view.stage}
          fcastP={view.fcastP}
          vet={view.vet}
          cfxOpen={view.cfxOpen}
          playerLabel={playerLabel}
          onForecastP={actions.setForecastP}
          onLockForecast={actions.lockForecast}
          onSkipForecast={actions.skipForecast}
          onNext={actions.nextFloor}
          onRetry={actions.retryFloor}
          onToggleCfx={actions.toggleCfx}
        />
        <CalibrationPanel forecasts={view.forecasts} skipped={view.skipped} onReset={actions.resetCalls} />
      </Box>

      <VerdictCard
        verdict={view.verdict}
        mintHref={`/${chainName}/borrow`}
        positionHref={`/${chainName}/position`}
        onSaveCard={actions.saveResultCard}
      />

      <Leaderboard seedId={view.seed.id} scenarios={view.scenarios} history={view.history} stBtc={view.st.btc} intent={view.st.intent} />

      {/* drag ghost */}
      <Box
        ref={drag.ghostRef}
        position="fixed"
        zIndex={999}
        pointerEvents="none"
        border="1px solid"
        borderColor={SEMANTIC_COLORS.success}
        bg={SEMANTIC_COLORS.bgSecondary}
        px={SPACING.sm}
        py={SPACING.sm}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11.5px"
        color={SEMANTIC_COLORS.textPrimary}
        display="none"
      />
    </Box>
  )
}

export default Builder
