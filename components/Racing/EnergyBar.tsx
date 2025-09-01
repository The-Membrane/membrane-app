import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, HStack, IconButton, Progress, Text, VStack, Menu, MenuButton, MenuList, MenuOptionGroup, MenuItemOption } from '@chakra-ui/react'
import { AddIcon } from '@chakra-ui/icons'
import useAppState from '@/persisted-state/useAppState';
import { useCarEnergy } from '@/services/q-racing'
import ConfirmModal from '@/components/ConfirmModal'
import useRefillEnergy, { TrainingPaymentOption } from '@/components/Racing/hooks/useRefillEnergy'
import useRacingState from './hooks/useRacingState';

// Simple lightning icon using SVG
const LightningIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
    <Box as="span" display="inline-block" w={`${size}px`} h={`${size}px`} mr={2}>
        <svg viewBox="0 0 24 24" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" fill="#7CFF00" xmlns="http://www.w3.org/2000/svg">
            <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
        </svg>
    </Box>
)

export type EnergyBarProps = {
    tokenId?: string
    inline?: boolean
}

const formatDuration = (ms: number) => {
    if (ms <= 0) return 'Full'
    const totalSeconds = Math.floor(ms / 1000)
    const h = Math.floor(totalSeconds / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
}

const EnergyBar: React.FC<EnergyBarProps> = ({ tokenId, inline }) => {
    const { appState } = useAppState()
    const { data } = useCarEnergy(tokenId, appState.rpcUrl)
    const { racingState, setRacingState } = useRacingState()

    useMemo(() => {
        if (data) {
            setRacingState({ energy: data.current_energy })
        }
    }, [data])

    const pct = useMemo(() => {
        if (!data) return 0
        if (data.max_energy === 0) return 0
        return Math.min(100, Math.round((racingState.energy / data.max_energy) * 100))
    }, [data])

    const timeToFull = useMemo(() => {
        if (!data) return 0
        const missing = Math.max(0, data.max_energy - racingState.energy)
        if (missing === 0 || data.energy_recovery_hours === 0) return 0
        const fullMs = data.energy_recovery_hours * 60 * 60 * 1000
        return Math.ceil((missing / data.max_energy) * fullMs)
    }, [data])

    const paymentOptions = (data?.training_payment_options ?? []).concat([{ denom: 'uatom', amount: '1000000' }])
    const [isMenuOpen, setIsMenuOpen] = useState(false)
    const openedAtRef = useRef<number | null>(null)
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const MIN_OPEN_MS = 700

    const openMenu = () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current)
            closeTimerRef.current = null
        }
        openedAtRef.current = Date.now()
        setIsMenuOpen(true)
    }

    const handleMouseLeave = () => {
        const openedAt = openedAtRef.current
        const now = Date.now()
        const elapsed = openedAt ? now - openedAt : MIN_OPEN_MS
        const remaining = Math.max(0, MIN_OPEN_MS - elapsed)
        if (remaining === 0) {
            setIsMenuOpen(false)
        } else {
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
            closeTimerRef.current = setTimeout(() => {
                setIsMenuOpen(false)
                closeTimerRef.current = null
            }, remaining)
        }
    }

    const immediateCloseMenu = () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current)
            closeTimerRef.current = null
        }
        setIsMenuOpen(false)
    }

    useEffect(() => () => {
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }, [])

    const [selectedOption, setSelectedOption] = useState<TrainingPaymentOption | null>(null)
    const refill = useRefillEnergy({ tokenId, paymentOption: selectedOption })

    return (
        <HStack spacing={3} position={inline ? 'relative' : 'absolute'} top={inline ? undefined : 3} right={inline ? undefined : 3} bg="#0a0f1e" border="2px solid #0033ff" px={3} py={2} borderRadius="md">
            <LightningIcon size={30} />
            <VStack align="start" spacing={0} minW="180px">
                <Text fontSize="10px" fontFamily='"Press Start 2P", monospace' color={racingState.energyColor} mb={1}>
                    {data ? `${racingState.energy} / ${data.max_energy}` : '0 / 0'}
                </Text>
                <HStack w="100%" spacing={2}>
                    <Progress value={pct} flex={1} size="sm" colorScheme="teal" bg="#1b2338" />
                    <Text fontSize="12px" fontFamily='"Press Start 2P", monospace' color="#b8c1ff">{pct}%</Text>
                </HStack>
                <Text fontSize="10px" fontFamily='"Press Start 2P", monospace' color="#7cffa0">
                    {formatDuration(timeToFull)}
                </Text>
            </VStack>
            <Box onMouseEnter={openMenu} onMouseLeave={handleMouseLeave} position="relative">
                {/* Invisible MenuButton for hover menu positioning */}
                <Menu isOpen={isMenuOpen} onOpen={openMenu} onClose={immediateCloseMenu} placement="bottom-end">
                    <MenuButton as={Box} position="absolute" top="0" left="0" w="30px" h="30px" opacity="0" zIndex="1" />
                    <MenuList minW="240px" bg="#0b0e17" borderColor="#2a3550" px={1}>
                        {paymentOptions.length > 0 ? (
                            <MenuOptionGroup
                                type='radio'
                                title='Payment'
                                value={selectedOption ? `${selectedOption.denom}:${selectedOption.amount}` : 'free'}
                                onChange={(val) => {
                                    if (typeof val === 'string') {
                                        if (val === 'free') {
                                            setSelectedOption(null)
                                        } else {
                                            const [denom, amount] = val.split(':')
                                            setSelectedOption({ denom, amount })
                                        }
                                    }
                                }}
                            >
                                {paymentOptions.map((opt, idx) => (
                                    <MenuItemOption key={`${opt.denom}-${idx}`} value={`${opt.denom}:${opt.amount}`}>
                                        <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#e6e6e6">
                                            Pay {opt.amount} {opt.denom}
                                        </Text>
                                    </MenuItemOption>
                                ))}
                                <MenuItemOption value='free'>
                                    <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#e6e6e6">
                                        Free refill
                                    </Text>
                                </MenuItemOption>
                            </MenuOptionGroup>
                        ) : (
                            <MenuOptionGroup type='radio' value='free'>
                                <MenuItemOption value='free'>
                                    <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#e6e6e6">
                                        Free refill
                                    </Text>
                                </MenuItemOption>
                            </MenuOptionGroup>
                        )}
                    </MenuList>
                </Menu>

                {/* Visible ConfirmModal button on top */}
                <ConfirmModal
                    label=""
                    executeDirectly={true}
                    action={refill.action}
                    onClick={immediateCloseMenu}
                    buttonProps={{
                        as: IconButton,
                        'aria-label': 'refill',
                        icon: <AddIcon />,
                        width: '30px',
                        height: '30px',
                        variant: 'outline',
                        colorScheme: 'teal',
                        position: 'relative',
                        zIndex: '2',
                    } as any}
                >
                    <VStack align="start" spacing={1}>
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#e6e6e6">
                            Confirm energy refill
                        </Text>
                        {selectedOption ? (
                            <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">
                                Pay {selectedOption.amount} {selectedOption.denom}
                            </Text>
                        ) : (
                            <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">
                                Free refill
                            </Text>
                        )}
                    </VStack>
                </ConfirmModal>
            </Box>
        </HStack>
    )
}

export default EnergyBar
