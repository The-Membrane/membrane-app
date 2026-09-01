// Offchain Q-Racing — the play-first maze run (no wallet needed).
// See docs/OFFCHAIN_QRACING_PLAN.md Phase 2. The server picks the maze seed; this component
// regenerates the identical maze locally (lib/game/maze) and replays moves locally
// (lib/game/replay) for live rendering — but the server is authoritative on the outcome:
// on reaching the finish it auto-submits the move path and the server verifies + credits BYTE.
//
// Living Typeface: bone-on-black, phosphor player dot, hairlines, sharp corners, mono numbers.
// Deliberately NOT the legacy Press-Start-2P arcade styling.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Flex, HStack, Input, SimpleGrid, Text, VStack } from '@chakra-ui/react'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'

import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { generateMaze, mazeSizeForDifficulty } from '@/lib/game/maze'
import { replayPath } from '@/lib/game/replay'
import useOffchainRacing, { type SubmitRaceResult } from '@/hooks/useOffchainRacing'

const BYTE_DECIMALS = 6

function formatByte(base: string | null | undefined): string {
  if (!base) return '0'
  try {
    const v = BigInt(base)
    const whole = v / 10n ** BigInt(BYTE_DECIMALS)
    const frac = (v % 10n ** BigInt(BYTE_DECIMALS)).toString().padStart(BYTE_DECIMALS, '0')
    const trimmed = frac.replace(/0+$/, '')
    return trimmed ? `${whole}.${trimmed}` : `${whole}`
  } catch {
    return '0'
  }
}

const KEY_TO_DIR: Record<string, number> = {
  ArrowUp: 0,
  ArrowDown: 1,
  ArrowLeft: 2,
  ArrowRight: 3,
  w: 0,
  s: 1,
  a: 2,
  d: 3,
  W: 0,
  S: 1,
  A: 2,
  D: 3,
}

const label = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}

const mono = {
  fontFamily: TYPOGRAPHY.fontMono,
  color: SEMANTIC_COLORS.textPrimary,
}

type ActiveRace = { raceId: string; mazeSeed: number; difficulty: number }

function cellPxFor(size: number): number {
  if (size <= 11) return 26
  if (size <= 15) return 22
  return 18
}

function tileColor(tile: string): string {
  switch (tile) {
    case 'W':
      return 'rgba(236, 230, 216, 0.06)' // bone hairline structure
    case 'F':
      return SEMANTIC_COLORS.primary // phosphor finish
    case 'S':
      return 'rgba(70, 211, 154, 0.25)' // teal start
    case 'K':
      return 'rgba(216, 178, 74, 0.28)' // gold sticky
    case 'B':
      return 'rgba(70, 211, 154, 0.30)' // teal boost
    default:
      return SEMANTIC_COLORS.bgPrimary // corridor
  }
}

const DPAD: Array<{ dir: number; glyph: string; area: string }> = [
  { dir: 0, glyph: '↑', area: 'up' },
  { dir: 2, glyph: '←', area: 'left' },
  { dir: 3, glyph: '→', area: 'right' },
  { dir: 1, glyph: '↓', area: 'down' },
]

const OffchainMazeRun: React.FC = () => {
  const { state, createPet, startRace, submitRace } = useOffchainRacing()
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()

  const [petName, setPetName] = useState('')
  const [difficulty, setDifficulty] = useState(1)
  const [race, setRace] = useState<ActiveRace | null>(null)
  const [moves, setMoves] = useState<number[]>([])
  const [result, setResult] = useState<SubmitRaceResult | null>(null)
  const submittedRef = useRef<string | null>(null)

  const pet = state.data?.pet ?? null
  const energy = state.data?.energy
  const canRace = !!pet && !!energy && energy.value >= 5 && !race

  const maze = useMemo(
    () => (race ? generateMaze(race.mazeSeed, race.difficulty) : null),
    [race],
  )
  const live = useMemo(() => (maze ? replayPath(maze, moves) : null), [maze, moves])
  const finished = !!live?.finished
  const cap = maze ? maze.width * maze.height * 2 : 0

  // Keyboard input — only while a run is active and not yet finished.
  useEffect(() => {
    if (!race || finished) return
    const onKey = (e: KeyboardEvent) => {
      const dir = KEY_TO_DIR[e.key]
      if (dir === undefined) return
      e.preventDefault()
      setMoves((m) => [...m, dir])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [race, finished])

  // Server-authoritative outcome: auto-submit the path the instant the local replay finishes.
  useEffect(() => {
    if (!race || !finished) return
    if (submittedRef.current === race.raceId) return
    submittedRef.current = race.raceId
    submitRace.mutate(
      { raceId: race.raceId, moves },
      {
        onSuccess: (r) => {
          setResult(r)
          setRace(null)
          setMoves([])
        },
        onError: () => {
          setRace(null)
          setMoves([])
        },
      },
    )
    // moves is intentionally read at fire time; guarded by submittedRef + finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [race, finished])

  const handleStart = () => {
    setResult(null)
    setMoves([])
    submittedRef.current = null
    startRace.mutate(
      { difficulty },
      {
        onSuccess: (r) => setRace({ raceId: r.raceId, mazeSeed: r.mazeSeed, difficulty: r.difficulty }),
      },
    )
  }

  const handleManualSubmit = () => {
    if (!race || submittedRef.current === race.raceId) return
    submittedRef.current = race.raceId
    submitRace.mutate(
      { raceId: race.raceId, moves },
      {
        onSuccess: (r) => {
          setResult(r)
          setRace(null)
          setMoves([])
        },
        onError: () => {
          setRace(null)
          setMoves([])
        },
      },
    )
  }

  const pushMove = (dir: number) => {
    if (!race || finished) return
    setMoves((m) => [...m, dir])
  }

  // ---- Render states -------------------------------------------------------

  if (state.isLoading) {
    return (
      <Card variant="default" w="100%">
        <Text {...mono} color={SEMANTIC_COLORS.textSecondary}>
          Loading game…
        </Text>
      </Card>
    )
  }

  if (state.isError) {
    return (
      <Card variant="default" w="100%">
        <Text {...mono} color={SEMANTIC_COLORS.danger}>
          Game backend unavailable. The offchain race needs the database configured.
        </Text>
      </Card>
    )
  }

  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap} w="100%">
      {/* Persistent tutorial banner (V20 intent-preserving connect target) */}
      <Box
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        bg={SEMANTIC_COLORS.bgSecondary}
        px={SPACING.base}
        py={SPACING.sm}
      >
        <Text {...label} color={SEMANTIC_COLORS.warning}>
          Practice circuit — your real pet lives on-chain
        </Text>
      </Box>

      {/* Stat row */}
      <SimpleGrid columns={{ base: 3, md: 3 }} spacing={SPACING.md}>
        <Card variant="subtle">
          <Text {...label}>Practice BYTE</Text>
          <Text {...mono} fontSize={TYPOGRAPHY.h4} color={SEMANTIC_COLORS.primary}>
            {formatByte(state.data?.byteBalance)}
          </Text>
        </Card>
        <Card variant="subtle">
          <Text {...label}>Energy</Text>
          <Text {...mono} fontSize={TYPOGRAPHY.h4}>
            {energy ? `${energy.value}/${energy.max}` : '—'}
          </Text>
        </Card>
        <Card variant="subtle">
          <Text {...label}>Pet</Text>
          <Text {...mono} fontSize={TYPOGRAPHY.small} noOfLines={1}>
            {pet ? pet.name : 'none'}
          </Text>
        </Card>
      </SimpleGrid>

      {/* No pet yet → create one */}
      {!pet && (
        <Card variant="default">
          <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
            <Text {...label}>Create your racer</Text>
            <HStack spacing={SPACING.sm}>
              <Input
                value={petName}
                onChange={(e) => setPetName(e.target.value)}
                placeholder="Name (max 24)"
                maxLength={24}
                borderRadius={0}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                fontFamily={TYPOGRAPHY.fontMono}
                color={SEMANTIC_COLORS.textPrimary}
                transition={TRANSITIONS.colors}
                _focus={FOCUS_STYLES.ring}
              />
              <Button
                colorScheme="phosphor"
                borderRadius={0}
                fontFamily={TYPOGRAPHY.fontMono}
                isLoading={createPet.isPending}
                isDisabled={petName.trim().length === 0}
                transition={TRANSITIONS.colors}
                _focus={FOCUS_STYLES.ring}
                onClick={() => createPet.mutate({ name: petName.trim() })}
              >
                Create
              </Button>
            </HStack>
            {createPet.isError && (
              <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.danger}>
                {createPet.error?.message}
              </Text>
            )}
          </VStack>
        </Card>
      )}

      {/* Result banner */}
      {result && (
        <Box
          border="1px solid"
          borderColor={result.verified ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.borderStrong}
          bg={SEMANTIC_COLORS.bgSecondary}
          px={SPACING.base}
          py={SPACING.md}
        >
          <Text {...mono} color={result.verified ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary}>
            {result.verified ? 'Finished' : 'Did not finish'} · {result.ticks} ticks
          </Text>
          {result.verified && (
            <Text {...mono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
              +{formatByte(result.byteAwarded)} practice BYTE · balance {formatByte(result.newBalance)} practice BYTE
            </Text>
          )}
        </Box>
      )}

      {/* Post-run nudge: intent-preserving connect toward the real on-chain record. */}
      {result && !race && (
        <Card variant="default">
          <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
            <Text {...label}>Ready for the real record</Text>
            <Text {...mono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
              You have the hang of it. Create your pet to start your real record.
            </Text>
            {isConnected ? (
              <Button
                colorScheme="phosphor"
                borderRadius={0}
                fontFamily={TYPOGRAPHY.fontMono}
                isDisabled
                transition={TRANSITIONS.colors}
                _focus={FOCUS_STYLES.ring}
              >
                Pet creation arrives with the on-chain wiring
              </Button>
            ) : (
              <Button
                colorScheme="phosphor"
                borderRadius={0}
                fontFamily={TYPOGRAPHY.fontMono}
                transition={TRANSITIONS.colors}
                _hover={HOVER_EFFECTS.borderHighlight}
                _active={ACTIVE_EFFECTS.dim}
                _focus={FOCUS_STYLES.ring}
                onClick={() => openConnectModal?.()}
              >
                Connect wallet
              </Button>
            )}
          </VStack>
        </Card>
      )}

      {/* Pre-race controls */}
      {pet && !race && (
        <Card variant="default">
          <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
            <Text {...label}>Difficulty · {mazeSizeForDifficulty(difficulty)}×{mazeSizeForDifficulty(difficulty)}</Text>
            <HStack spacing={SPACING.sm}>
              {[1, 2, 3, 4, 5].map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant={difficulty === d ? 'solid' : 'outline'}
                  colorScheme={difficulty === d ? 'phosphor' : undefined}
                  borderRadius={0}
                  fontFamily={TYPOGRAPHY.fontMono}
                  transition={TRANSITIONS.colors}
                  _hover={HOVER_EFFECTS.borderHighlight}
                  _focus={FOCUS_STYLES.ring}
                  onClick={() => setDifficulty(d)}
                >
                  {d}
                </Button>
              ))}
            </HStack>
            <Button
              colorScheme="phosphor"
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              isLoading={startRace.isPending}
              isDisabled={!canRace}
              transition={TRANSITIONS.colors}
              _active={ACTIVE_EFFECTS.dim}
              _focus={FOCUS_STYLES.ring}
              onClick={handleStart}
            >
              Start Race · 5 energy
            </Button>
            {startRace.isError && (
              <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.danger}>
                {startRace.error?.message}
              </Text>
            )}
            {!canRace && pet && energy && energy.value < 5 && (
              <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                Not enough energy — refills over time.
              </Text>
            )}
          </VStack>
        </Card>
      )}

      {/* Active run: maze board + tick counter + D-pad */}
      {race && maze && live && (
        <Card variant="default">
          <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
            <Flex justify="space-between" align="center">
              <Text {...label}>Run</Text>
              <Text {...mono} fontSize={TYPOGRAPHY.small}>
                {live.ticks}/{cap} ticks
              </Text>
            </Flex>

            <Box overflowX="auto">
              <Box
                display="grid"
                gridTemplateColumns={`repeat(${maze.width}, ${cellPxFor(maze.width)}px)`}
                gridAutoRows={`${cellPxFor(maze.width)}px`}
                width="fit-content"
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                mx="auto"
              >
                {maze.grid.map((row, y) =>
                  row.map((tile, x) => {
                    const isPlayer = live.finalPos.x === x && live.finalPos.y === y
                    return (
                      <Box
                        key={`${x}-${y}`}
                        bg={tileColor(tile)}
                        position="relative"
                        borderRight="1px solid"
                        borderBottom="1px solid"
                        borderColor="rgba(236, 230, 216, 0.04)"
                      >
                        {isPlayer && (
                          <Box
                            position="absolute"
                            inset="18%"
                            borderRadius="50%"
                            bg={SEMANTIC_COLORS.primary}
                          />
                        )}
                      </Box>
                    )
                  }),
                )}
              </Box>
            </Box>

            {/* On-screen D-pad */}
            <Box
              display="grid"
              gridTemplateAreas={`". up ." "left down right"`}
              gridTemplateColumns="repeat(3, 44px)"
              gap={SPACING.xs}
              justifyContent="center"
            >
              {DPAD.map(({ dir, glyph, area }) => (
                <Button
                  key={area}
                  gridArea={area}
                  h="44px"
                  minW="44px"
                  variant="outline"
                  borderRadius={0}
                  fontFamily={TYPOGRAPHY.fontMono}
                  isDisabled={finished}
                  transition={TRANSITIONS.colors}
                  _hover={HOVER_EFFECTS.borderHighlight}
                  _active={ACTIVE_EFFECTS.dim}
                  _focus={FOCUS_STYLES.ring}
                  aria-label={`Move ${area}`}
                  onClick={() => pushMove(dir)}
                >
                  {glyph}
                </Button>
              ))}
            </Box>

            <Text {...mono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary} textAlign="center">
              Arrow keys or WASD to move. Reach the phosphor finish.
            </Text>

            <Button
              variant="outline"
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              isLoading={submitRace.isPending}
              transition={TRANSITIONS.colors}
              _hover={HOVER_EFFECTS.borderHighlight}
              _focus={FOCUS_STYLES.ring}
              onClick={handleManualSubmit}
            >
              Submit run
            </Button>
          </VStack>
        </Card>
      )}
    </VStack>
  )
}

export default OffchainMazeRun
