import React, { useEffect, useMemo, useState } from 'react'
import { Box, HStack, Select, Text, VStack, Flex, Input, Switch, Slider, SliderTrack, SliderFilledTrack, SliderThumb, Tooltip, Collapse } from '@chakra-ui/react'
import { useRouter } from 'next/router'
import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import { useOwnedCars } from '@/hooks/useQRacing'
import { useCarMetadata, useCarQTable, useCarBrainProgress } from '@/services/q-racing'
import { Button } from '@chakra-ui/react'
import useChangeName from './hooks/useChangeName'
import { CheckIcon, Pencil, ChevronDown, ChevronUp } from 'lucide-react'
import { CloseIcon, InfoIcon } from '@chakra-ui/icons'
import IQProgressChart from './IQProgressChart'
import useRacingState from './hooks/useRacingState'

// const QTableView = ({ qValues }: { qValues: { state_hash: any; action_values: [number, number, number, number] }[] }) => {
//     // Simple grid: each row shows state id (short) and the 4 action values
//     return (
//         <VStack align="stretch" spacing={2} maxH={{ base: '200px', md: '360px' }} overflowY="auto" border="1px solid #2a3550" p={2} borderRadius={4}>
//             {qValues.map((q, idx) => {
//                 const id = Array.isArray(q.state_hash) ? (q.state_hash as number[]).slice(0, 4).join('') : String(q.state_hash).slice(0, 8)
//                 return (
//                     <Flex
//                         key={idx}
//                         direction={{ base: 'column', sm: 'row' }}
//                         justify="space-between"
//                         fontFamily='"Press Start 2P", monospace'
//                         fontSize={{ base: '8px', sm: '10px' }}
//                         color="#b8c1ff"
//                         gap={1}
//                     >
//                         <Text color="#00ffea" wordBreak="break-all">{id}</Text>
//                         <Text fontSize={{ base: '8px', sm: '10px' }}>[{q.action_values.join(', ')}]</Text>
//                     </Flex>
//                 )
//             })}
//         </VStack>
//     )
// }

// const CarVisual = ({ tokenId }: { tokenId?: string }) => {
//     // Placeholder visual area for car rendering
//     return (
//         <Box w="480px" h="360px" border="2px solid #0033ff" bg="#070b15" borderRadius={6} />
//     )
// }

const COLOR_NAME_TO_HEX: Record<string, string> = {
    White: '#ffffff',
    Black: '#000000',
    Silver: '#c0c0c0',
    Gray: '#808080',
    Red: '#ff0000',
    Blue: '#0000ff',
    Green: '#008000',
    Orange: '#ffa500',
    Yellow: '#ffff00',
    Purple: '#800080',
    Teal: '#008080',
    Gold: '#ffd700',
    Chrome: '#c9c9c9',
    NeonGreen: '#39ff14',
    Pink: '#ff66cc',
}

function isColorTrait(label: string): boolean {
    const norm = label.replace(/[_-]/g, ' ').toLowerCase().trim()
    return (
        norm.includes('color') ||
        norm === 'underglow' ||
        norm === 'rim color' ||
        norm === 'base color' ||
        norm === 'headlight color'
    )
}

function extractColorHex(value: string): string | null {
    const hexMatch = value.match(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})/)
    if (hexMatch) {
        const hex = hexMatch[0]
        return hex.length === 4
            ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
            : hex
    }
    const name = (value.split(' ')[0] || '').trim()
    if (name && COLOR_NAME_TO_HEX[name]) return COLOR_NAME_TO_HEX[name]
    return null
}

const CarPanel: React.FC = () => {
    const { address } = useWallet()
    const { appState } = useAppState()
    const { data: cars } = useOwnedCars(address)
    const [carId, setCarId] = useState<string>('')
    const router = useRouter()

    const updateRouteCarId = (id?: string) => {
        const nextQuery: Record<string, any> = { ...router.query }
        if (id) {
            nextQuery.carId = id
        } else {
            delete nextQuery.carId
        }
        router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true, scroll: false })
    }

    const [isEditing, setIsEditing] = useState(false)
    const [newName, setNewName] = useState('')
    const [oldName, setOldName] = useState('')

    const { action: changeName } = useChangeName({ tokenId: carId || null, newName: newName || null })

    const { data: traits } = useCarMetadata(carId || undefined, appState.rpcUrl)
    const { data: q } = useCarQTable(carId || undefined, appState.rpcUrl)
    const { data: brainProgress } = useCarBrainProgress(carId || undefined, appState.rpcUrl)

    const qValues = useMemo(() => q?.q_values ?? [], [q])

    // Sync selection from URL when present
    useEffect(() => {
        const qCar = (router.query?.carId as string) || ''
        if (qCar && qCar !== carId) {
            // Only adopt if it's a valid car (or cars not loaded yet)
            if (!cars || cars.some((c) => c.id === qCar)) {
                setCarId(qCar)
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [router.query?.carId, cars])

    // Auto-select the first car if available, or clear selection if none
    useEffect(() => {
        if (cars && cars.length > 0) {
            if (!carId || !cars.some((c) => c.id === carId)) {
                const firstId = cars[0].id
                setCarId(firstId)
                updateRouteCarId(firstId)
            }
        } else if (carId) {
            setCarId('')
            updateRouteCarId(undefined)
        }
    }, [cars, carId])

    const options = useMemo(() => {
        if (!cars) return []
        console.log('cars', cars)
        return cars?.map((c) => (
            <option key={c.id} value={c.id}>{c.name ?? c.id}</option>
        ))
    }, [cars])

    const selectedName = useMemo(() => {
        const found = cars?.find((c) => c.id === carId)
        return found?.name ?? found?.id ?? ''
    }, [cars, carId])

    const handleRename = async () => {
        const trimmed = (newName || '').trim()
        if (!carId || !trimmed || trimmed === oldName) return
        try {
            await changeName.simulate.refetch()
            changeName.tx.mutate()
        } finally {
            setIsEditing(false)
        }
    }


    return (
        <Flex
            direction={{ base: 'column', lg: 'row' }}
            align="start"
            gap={4}
            w="100%"
        >
            <VStack align="stretch" spacing={3} minW={{ base: '100%', lg: '520px' }} w={{ base: '100%', lg: 'auto' }}>
                <Flex direction={{ base: 'column', sm: 'row' }} gap={2} align={{ base: 'stretch', sm: 'center' }}>
                    <Text w={{ base: 'auto', sm: '100px' }} fontFamily='"Press Start 2P", monospace' fontSize={{ base: '10px', sm: '12px' }} color="#b8c1ff">Car</Text>
                    <Select
                        size="sm"
                        value={carId}
                        onChange={(e) => { const id = e.target.value; setCarId(id); updateRouteCarId(id || undefined) }}
                        bg="#0a0f1e"
                        borderColor="#2a3550"
                        color="#e6e6e6"
                        minH={{ base: '44px', sm: 'auto' }}
                        flex="1"
                    >
                        <option value="">Select Car</option>
                        {options}
                    </Select>
                    {carId && !isEditing && (
                        <HStack spacing={2} ml={2}>
                            {/* <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#e6e6e6">{selectedName}</Text> */}
                            <Button
                                onClick={() => {
                                    setOldName(selectedName)
                                    setNewName(selectedName)
                                    setIsEditing(true)
                                }}
                                variant="ghost"
                                size="xs"
                                p={1}
                                minW={0}
                            >
                                <Pencil size={14} />
                            </Button>
                        </HStack>
                    )}
                    {carId && isEditing && (
                        <HStack spacing={2} ml={2}>
                            <input
                                autoFocus
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                className="rounded bg-slate-800 text-white border border-slate-600 px-2 py-1 text-sm"
                                style={{ padding: '3%' }}
                                placeholder="New name"
                            />
                            <Button
                                size="xs"
                                variant="ghost"
                                onClick={handleRename}
                                isDisabled={!newName.trim() || newName.trim() === oldName}
                            >
                                <CheckIcon size={33} />
                            </Button>
                            <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => {
                                    setNewName(oldName)
                                    setIsEditing(false)
                                }}
                            >
                                <CloseIcon />
                            </Button>
                        </HStack>
                    )}

                </Flex>

                <Box p={3} border="2px solid #0033ff" bg="#0b0e17" borderRadius={6} h="400px">
                    {brainProgress ? (
                        <IQProgressChart
                            entries={brainProgress.brain_progress.entries}
                            currentStatesSeen={brainProgress.brain_progress.total_states_seen}
                            currentWallCollisions={brainProgress.brain_progress.total_wall_collisions}
                            carId={carId}
                        />
                    ) : (
                        <Flex
                            align="center"
                            justify="center"
                            h="100%"
                            fontFamily='"Press Start 2P", monospace'
                            fontSize="10px"
                            color="#666"
                        >
                            No brain data
                        </Flex>
                    )}
                </Box>
                {/* Reward Config Panel */}
                <RewardConfigPanel />
                {/* <CarVisual tokenId={carId || undefined} /> */}
            </VStack>

            <VStack align="stretch" spacing={4} minW={{ base: '100%', lg: '420px' }} w={{ base: '100%', lg: 'auto' }}>
                <Box p={3} border="2px solid #0033ff" bg="#0b0e17" borderRadius={6}>
                    <Text mb={2} fontFamily='"Press Start 2P", monospace' fontSize={{ base: '10px', sm: '12px' }} color="#00ffea">Traits</Text>
                    <VStack align="stretch" spacing={1}>
                        {traits?.map((t, i) => {
                            const showSwatch = isColorTrait(t.trait_type)
                            const hex = showSwatch ? extractColorHex(t.value) : null
                            return (
                                <HStack key={`${t.trait_type}-${i}`} justify="space-between">
                                    <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">{t.trait_type}</Text>
                                    {showSwatch && hex ? (
                                        <Box w="14px" h="14px" borderRadius={2} border="1px solid #2a3550" style={{ background: hex }} />
                                    ) : (
                                        <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#00ffea">{t.value}</Text>
                                    )}
                                </HStack>
                            )
                        }) || <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#666">No traits</Text>}
                    </VStack>
                </Box>

            </VStack>
        </Flex>
    )
}

const RewardConfigPanel: React.FC = () => {
    const { racingState, setRacingState } = useRacingState()
    const [isExpanded, setIsExpanded] = useState(false)
    const cfg = racingState.rewardConfig || {
        distance: 3,
        stuck: -3,
        wall: -40,
        no_move: -30,
        explore: 0,
        going_backward: { penalty: -4, include_progress_towards_finish: true },
        rank: { first: 50, second: 0, third: 0, other: 0 },
    }

    const setCfg = (next: typeof cfg) => setRacingState({ rewardConfig: next })
    console.log('cfg', cfg)

    const sliderInput = (label: string, value: number, min: number, max: number, onChange: (n: number) => void, help?: string) => (
        <VStack align="stretch" spacing={1}>
            <HStack justify="space-between">
                <HStack spacing={2}>
                    <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">{label}</Text>
                    {help && (
                        <Tooltip label={help} hasArrow placement="top" openDelay={200}>
                            <span>
                                <InfoIcon boxSize={3} color="#b8c1ff" />
                            </span>
                        </Tooltip>
                    )}
                </HStack>
                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#00ffea">{value}</Text>
            </HStack>
            <Slider value={value} min={min} max={max} step={1} onChange={onChange}>
                <SliderTrack bg="#142042">
                    <SliderFilledTrack bg="#274bff" />
                </SliderTrack>
                <SliderThumb boxSize={3} />
            </Slider>
        </VStack>
    )

    const sliderNegativeInput = (label: string, currentNegative: number, onChangeNegative: (n: number) => void, help?: string) => (
        <VStack align="stretch" spacing={1}>
            <HStack justify="space-between">
                <HStack spacing={2}>
                    <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">{label}</Text>
                    {help && (
                        <Tooltip label={help} hasArrow placement="top" openDelay={200}>
                            <span>
                                <InfoIcon boxSize={3} color="#b8c1ff" />
                            </span>
                        </Tooltip>
                    )}
                </HStack>
                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#00ffea">{currentNegative}</Text>
            </HStack>
            <Slider value={Math.abs(currentNegative)} min={0} max={100} step={1} onChange={(n) => onChangeNegative(-n)}>
                <SliderTrack bg="#142042">
                    <SliderFilledTrack bg="#274bff" />
                </SliderTrack>
                <SliderThumb boxSize={3} />
            </Slider>
        </VStack>
    )

    return (
        <Box p={3} border="2px solid #0033ff" bg="#0b0e17" borderRadius={6}>
            <HStack justify="space-between" mb={2}>
                <Text fontFamily='"Press Start 2P", monospace' fontSize={{ base: '10px', sm: '12px' }} color="#00ffea">Reward Config</Text>
                <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setIsExpanded(!isExpanded)}
                    p={1}
                    minW={0}
                >
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </Button>
            </HStack>
            <Collapse in={isExpanded}>
                <VStack align="stretch" spacing={3}>
                    {sliderInput('Distance', cfg.distance, 0, 100, (n) => setCfg({ ...cfg, distance: n }), 'Per-tick reward for moving closer to finish. Higher values (10-50) help learn efficient paths. Balance with other penalties.')}
                    {sliderNegativeInput('Stuck Penalty', cfg.stuck, (n) => setCfg({ ...cfg, stuck: n }), 'Penalty when entering sticky/trap tiles. Too high will discourage forward movement through sticky tiles.')}
                    {sliderNegativeInput('Wall Penalty', cfg.wall, (n) => setCfg({ ...cfg, wall: n }), 'Penalty on wall collisions. Keep strong (e.g., -40 to -80) so the agent learns to avoid walls early.')}
                    {sliderNegativeInput('No Move Penalty', cfg.no_move, (n) => setCfg({ ...cfg, no_move: n }), 'Penalty for staying in the same tile. Helps prevent dithering/loops.')}
                    {/* {sliderInput('Explore', cfg.explore, 0, 100, (n) => setCfg({ ...cfg, explore: n }), 'Bonus for exploring new states/actions. Useful early training (0–10); reduce later to exploit learned paths.')} */}
                    {sliderNegativeInput('Going Backward Penalty', cfg.going_backward.penalty, (n) => setCfg({ ...cfg, going_backward: { ...cfg.going_backward, penalty: n } }), 'Penalty for moving away from finish. Too high will discourage necessary repositioning ex: maze dead ends.')}
                    <HStack justify="space-between">
                        <HStack spacing={2}>
                            <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">Include Progress Toward Finish</Text>
                            <Tooltip label={'If on, backward moves are penalized more closer to the finish.'} hasArrow placement="top" openDelay={200}>
                                <span>
                                    <InfoIcon boxSize={3} color="#b8c1ff" />
                                </span>
                            </Tooltip>
                        </HStack>
                        <Switch
                            size="sm"
                            isChecked={cfg.going_backward.include_progress_towards_finish}
                            onChange={(e) => setCfg({ ...cfg, going_backward: { ...cfg.going_backward, include_progress_towards_finish: e.target.checked } })}
                        />
                    </HStack>

                    <Text pt={2} fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#00ffea">Rank Rewards</Text>
                    {sliderInput('First', cfg.rank.first, 0, 100, (n) => setCfg({ ...cfg, rank: { ...cfg.rank, first: n } }), 'Terminal reward for winning. Drives goal completion; 30–100 typical depending on track length.')}
                    {/* {sliderInput('Second', cfg.rank.second, 0, 100, (n) => setCfg({ ...cfg, rank: { ...cfg.rank, second: n } }), 'Smaller terminal reward for 2nd place. Set low or 0 to focus the agent on winning.')}
                    {sliderInput('Third', cfg.rank.third, 0, 100, (n) => setCfg({ ...cfg, rank: { ...cfg.rank, third: n } }), 'Reward for 3rd. Consider low values (0–10) to reduce complacency and encourage improvement.')}
                    {sliderInput('Other', cfg.rank.other, 0, 100, (n) => setCfg({ ...cfg, rank: { ...cfg.rank, other: n } }), 'Reward for finishing outside top 3. Use 0 to discourage settling; small values if you want stability.')} */}

                    <HStack pt={2} justify="flex-end">
                        <Button size="sm" variant="outline" onClick={() => setCfg({
                            distance: 3,
                            stuck: -3,
                            wall: -40,
                            no_move: -30,
                            explore: 0,
                            going_backward: { penalty: -4, include_progress_towards_finish: true },
                            rank: { first: 50, second: 0, third: 0, other: 0 },
                        })}>Reset Defaults</Button>
                    </HStack>
                </VStack>
            </Collapse>
        </Box>
    )
}

export default CarPanel 