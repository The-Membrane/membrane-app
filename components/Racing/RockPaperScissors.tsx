import React from 'react'
import { Box, Flex, HStack, Text, VStack, Slider, SliderTrack, SliderFilledTrack, SliderThumb } from '@chakra-ui/react'
import { rpsActionToEmoji, rpsActionToLabel } from '@/services/q-racing'
import useRpsGame from '@/components/Racing/hooks/useRpsGame'
import RpsControlBar from '@/components/Racing/RpsControlBar'
import RpsControlPanels from '@/components/Racing/RpsControlPanels'

const RockPaperScissors: React.FC = () => {
    const game = useRpsGame()
    const {
        matchHistory,
        opponentName,
        ticks,
        speed,
        phase,
        currentRound,
        currentRecord,
        maxPhaseTicks,
        clampedPhase,
        setPhaseTickDisplay,
        score,
        chant,
    } = game

    return (
        <Flex direction="column" h="100%">
            <RpsControlBar
                ownedCars={game.ownedCars}
                selectedCarId={game.selectedCarId}
                setSelectedCarId={game.setSelectedCarId}
                isTraining={game.isTraining}
                setIsTraining={game.setIsTraining}
                opponentId={game.opponentId}
                setOpponentId={game.setOpponentId}
                setOpponentName={game.setOpponentName}
                allCars={game.allCars}
                numberOfMatches={game.numberOfMatches}
                setNumberOfMatches={game.setNumberOfMatches}
                playSeries={game.playSeries}
            />

            <RpsControlPanels
                playing={game.playing}
                setPlaying={game.setPlaying}
                phaseTickRef={game.phaseTickRef}
                setPhaseTickDisplay={game.setPhaseTickDisplay}
                speed={game.speed}
                setSpeed={game.setSpeed}
                isTraining={game.isTraining}
                mode={game.mode}
                setMode={game.setMode}
                fixedTicks={game.fixedTicks}
                setFixedTicks={game.setFixedTicks}
                bestOfWins={game.bestOfWins}
                setBestOfWins={game.setBestOfWins}
                epsilon={game.epsilon}
                setEpsilon={game.setEpsilon}
            />

            {/* Info Section - Performance Stats */}
            <div style={{ background: '#0a0f1e', borderBottom: '1px solid #2a3550', padding: '12px 18px' }}>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '32px' }}>
                    {/* Win Rate in Last N Ticks */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">
                            Win Rate (Last {matchHistory?.history?.length || 0} ticks)
                        </Text>
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="24px" color="#00ffea">
                            {matchHistory?.history && matchHistory.history.length > 0 ?
                                ((matchHistory.history.filter(outcome => outcome === 2).length / matchHistory.history.length) * 100).toFixed(1) : '0.0'}%
                        </Text>
                    </div>

                    {/* Current Score */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">
                            Win - Loss - Draw
                        </Text>
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="24px" color="#e6e6e6">
                            {score.win}-{score.loss}-{score.draw}
                        </Text>
                    </div>
                </div>
            </div>

            {/* Main Game Area */}
            <Flex gap={4} p={3} flex="1">
                <VStack align="stretch" flex={1} spacing={3}>
                    <Box border="1px solid #2a3550" p={4} bg="#0a0f1e">
                        <HStack justify="center" spacing={6}>
                            {chant.map((c, idx) => (
                                <Text key={c.label} fontFamily='"Press Start 2P", monospace' fontSize="18px" color="#00ffea" style={{ opacity: c.active ? 1 : 0.2 }}>
                                    {c.label}
                                </Text>
                            ))}
                        </HStack>
                    </Box>

                    <Box border="1px solid #2a3550" p={6} bg="#070b15">
                        <HStack justify="center" spacing={16}>
                            <VStack>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">You</Text>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="48px">{phase === 3 ? rpsActionToEmoji(currentRecord?.my_action) : '❓'}</Text>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">{phase === 3 ? rpsActionToLabel(currentRecord?.my_action) : ''}</Text>
                            </VStack>
                            <VStack>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#b8c1ff">{opponentName}</Text>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="48px">{phase === 3 ? rpsActionToEmoji(currentRecord?.opp_action) : '❓'}</Text>
                                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">{phase === 3 ? rpsActionToLabel(currentRecord?.opp_action) : ''}</Text>
                            </VStack>
                        </HStack>
                    </Box>

                    <VStack align="stretch" spacing={2}>
                        <HStack justify="space-between">
                            <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">Round: {ticks.length === 0 ? 0 : currentRound + 1} / {Math.max(0, ticks.length)}</Text>
                            <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">Speed: {speed.toFixed(2)}x</Text>
                        </HStack>
                        <Slider min={0} max={maxPhaseTicks} step={1} value={clampedPhase} onChange={setPhaseTickDisplay}>
                            <SliderTrack bg="#1a2340">
                                <SliderFilledTrack bg="#0033ff" />
                            </SliderTrack>
                            <SliderThumb />
                        </Slider>
                    </VStack>
                </VStack>
            </Flex>
        </Flex>
    )
}

export default RockPaperScissors
