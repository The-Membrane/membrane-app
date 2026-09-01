import React, { useState, useEffect } from 'react'
import { useDisclosure } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import useAppState from '@/persisted-state/useAppState'

// Total duration (ms) of the full scan cycle (down -> up -> down). The scan
// line's position is derived purely from elapsed time so that a momentary
// mouseleave / pointer jitter can never cancel an in-progress scan.
const SCAN_DURATION_MS = 1800

// Intentionally a no-op: once a scan begins it runs to completion based
// on elapsed time (see the animation effect in useStorefront), so a momentary
// mouseleave / pointer jitter can no longer cancel it.
const handleScannerMouseLeave = () => { }

// Encapsulates all storefront scanner state, cursor tracking, the time-based
// scan animation, TOS modal disclosure/content loading, and the username
// input. Extracted verbatim from StorefrontView so hook order and effect
// behavior are preserved exactly.
export const useStorefront = () => {
    const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 })
    const circleRef = React.useRef<HTMLDivElement>(null)
    const { setAppState } = useAppState()

    // Scanner state
    const [isScanning, setIsScanning] = useState(false)
    const [scanComplete, setScanComplete] = useState(false)
    const [scanPatterns, setScanPatterns] = useState(0)
    const [lastY, setLastY] = useState<number | null>(null)
    const [currentDirection, setCurrentDirection] = useState<'down' | 'up' | null>(null)
    const [scanLineY, setScanLineY] = useState(0)
    const [scannerBounds, setScannerBounds] = useState<{ top: number; bottom: number; centerX: number } | null>(null)
    const [username, setUsername] = useState('')
    const { isOpen: isTOSOpen, onOpen: onTOSOpen, onClose: onTOSClose } = useDisclosure()
    const scanLineRef = React.useRef<HTMLDivElement>(null)
    const scannerRef = React.useRef<HTMLDivElement>(null)
    const scanAnimationRef = React.useRef<number | null>(null)
    const scanStartTimeRef = React.useRef<number | null>(null)

    // Load TOS content only when modal opens. staleTime: Infinity — it's a
    // static file, so once fetched it's cached for the session and never
    // re-fetched on subsequent opens (matches the previous `!tosContent` guard).
    const { data: tosContent = '' } = useQuery({
        queryKey: ['tos-content'],
        queryFn: async () => {
            try {
                const res = await fetch('/TOS.md')
                return await res.text()
            } catch (err) {
                console.error('Failed to load TOS:', err)
                throw err
            }
        },
        enabled: isTOSOpen,
        staleTime: Infinity,
    })

    React.useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            // Use requestAnimationFrame for smoother updates
            requestAnimationFrame(() => {
                if (circleRef.current) {
                    // Use transform instead of left/top for better performance
                    circleRef.current.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`
                }
                setMousePosition({ x: e.clientX, y: e.clientY })
            })
        }

        window.addEventListener('mousemove', handleMouseMove)

        return () => {
            window.removeEventListener('mousemove', handleMouseMove)
        }
    }, [])



    // Auto-scanning animation.
    // Position is derived from elapsed wall-clock time (not per-frame pixel
    // increments), so the cycle always completes in SCAN_DURATION_MS
    // regardless of frame rate. Combined with handleScannerMouseLeave no
    // longer cancelling the scan, this makes the gesture reliably
    // completable instead of requiring uninterrupted hover for the whole
    // three-phase cycle.
    React.useEffect(() => {
        if (!isScanning || scanComplete || !scannerBounds) return

        if (scanStartTimeRef.current === null) {
            scanStartTimeRef.current = performance.now()
        }

        const { top, bottom } = scannerBounds
        const boxHeight = bottom - top
        const phaseDuration = SCAN_DURATION_MS / 3 // down, up, down

        const animate = (now: number) => {
            const startTime = scanStartTimeRef.current ?? now
            const elapsed = now - startTime

            if (elapsed >= SCAN_DURATION_MS) {
                setScanLineY(bottom)
                setLastY(bottom)
                setCurrentDirection('down')
                setScanComplete(true)
                setIsScanning(false)
                setAppState({ setCookie: true })
                return // Stop animation - cycle complete
            }

            const phase = Math.floor(elapsed / phaseDuration) // 0, 1, or 2
            const phaseProgress = (elapsed - phase * phaseDuration) / phaseDuration

            let currentY: number
            if (phase === 1) {
                // Second part: up (bottom -> top)
                currentY = bottom - boxHeight * phaseProgress
                setCurrentDirection('up')
            } else {
                // First and third parts: down (top -> bottom)
                currentY = top + boxHeight * phaseProgress
                setCurrentDirection('down')
            }

            setScanLineY(currentY)
            setLastY(currentY)

            scanAnimationRef.current = requestAnimationFrame(animate)
        }

        scanAnimationRef.current = requestAnimationFrame(animate)

        return () => {
            if (scanAnimationRef.current) {
                cancelAnimationFrame(scanAnimationRef.current)
            }
        }
    }, [isScanning, scanComplete, scannerBounds, setAppState])

    // Update scanning line position (within the 40px box, not following cursor)
    React.useEffect(() => {
        if (!isScanning || scanComplete || !scanLineRef.current || !scannerBounds) return

        // Calculate center of the 40px box
        const boxCenterX = scannerBounds.centerX
        const boxCenterY = (scannerBounds.top + scannerBounds.bottom) / 2

        requestAnimationFrame(() => {
            if (scanLineRef.current) {
                scanLineRef.current.style.transform = `translate(${boxCenterX}px, ${scanLineY}px) translate(-50%, -50%)`
            }
        })
    }, [scanLineY, isScanning, scanComplete, scannerBounds])

    // Shared entry point for starting a scan - triggered by hover, click/tap,
    // or keyboard activation so the gesture is completable without needing
    // sustained, precise pointer control.
    const startScan = (target: HTMLElement) => {
        if (scanComplete || isScanning) return

        // Get scanner bounds - 16px x 24px activation area in the center
        const rect = target.getBoundingClientRect()
        const boxHeight = 24 // 24px height
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2

        scanStartTimeRef.current = null // let the animation effect stamp a fresh start time
        setScannerBounds({
            top: centerY - boxHeight / 2,
            bottom: centerY + boxHeight / 2,
            centerX: centerX
        })

        setIsScanning(true)
        setScanPatterns(0)
        setCurrentDirection('down') // Start with down direction
        setScanLineY(centerY - boxHeight / 2)
        setLastY(centerY - boxHeight / 2)
    }

    const handleScannerMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
        startScan(e.currentTarget)
    }

    // Accessible fallbacks for keyboard, touch, and automation - a single
    // click/tap or Enter/Space press starts the same reliable, time-based scan.
    const handleScannerClick = (e: React.MouseEvent<HTMLDivElement>) => {
        startScan(e.currentTarget)
    }

    const handleScannerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault()
            startScan(e.currentTarget)
        }
    }

    return {
        scanComplete,
        isScanning,
        scannerRef,
        scanLineRef,
        handleScannerMouseEnter,
        handleScannerMouseLeave,
        handleScannerClick,
        handleScannerKeyDown,
        username,
        setUsername,
        isTOSOpen,
        onTOSOpen,
        onTOSClose,
        tosContent,
    }
}
