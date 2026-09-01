import { useEffect } from 'react'
import type { RefObject } from 'react'
import type { IndividualLTVData } from '../LTVNumberLineCarousel'

interface KeyboardNavArgs {
    selectedLTV: number | null
    currentLTV: number | null
    ltvValues: IndividualLTVData[]
    allLTVValues: number[]
    onLTVSelect: (ltv: number) => void
}

// Keyboard navigation for the LTV carousel (ArrowLeft / ArrowRight).
export const useLTVCarouselKeyboardNav = ({
    selectedLTV,
    currentLTV,
    ltvValues,
    allLTVValues,
    onLTVSelect,
}: KeyboardNavArgs) => {
    useEffect(() => {
        const handleKeyPress = (e: KeyboardEvent) => {
            // Only handle if not typing in an input
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return
            }

            if (e.key === 'ArrowLeft') {
                e.preventDefault()
                if (selectedLTV === null) {
                    const targetLTV = currentLTV !== null ? currentLTV : (ltvValues.length > 0 ? ltvValues[0].ltv : allLTVValues[0])
                    onLTVSelect(targetLTV)
                } else {
                    const currentIndex = allLTVValues.findIndex((v) => Math.abs(v - selectedLTV) < 0.001)
                    if (currentIndex > 0) {
                        onLTVSelect(allLTVValues[currentIndex - 1])
                    }
                }
            } else if (e.key === 'ArrowRight') {
                e.preventDefault()
                if (selectedLTV === null) {
                    const targetLTV = currentLTV !== null ? currentLTV : (ltvValues.length > 0 ? ltvValues[0].ltv : allLTVValues[0])
                    onLTVSelect(targetLTV)
                } else {
                    const currentIndex = allLTVValues.findIndex((v) => Math.abs(v - selectedLTV) < 0.001)
                    if (currentIndex >= 0 && currentIndex < allLTVValues.length - 1) {
                        onLTVSelect(allLTVValues[currentIndex + 1])
                    }
                }
            }
        }

        window.addEventListener('keydown', handleKeyPress)
        return () => window.removeEventListener('keydown', handleKeyPress)
    }, [selectedLTV, currentLTV, ltvValues, allLTVValues, onLTVSelect])
}

// Scroll the selected LTV notch to the horizontal center of the container.
export const useLTVCarouselScrollToCenter = (
    selectedLTV: number | null,
    containerRef: RefObject<HTMLDivElement>,
) => {
    useEffect(() => {
        if (selectedLTV && containerRef.current) {
            const notchElement = containerRef.current.querySelector(
                `[data-ltv="${selectedLTV}"]`
            ) as HTMLElement
            if (notchElement && containerRef.current) {
                const container = containerRef.current
                const containerRect = container.getBoundingClientRect()
                const notchRect = notchElement.getBoundingClientRect()
                const scrollLeft = container.scrollLeft
                const notchOffset = notchRect.left - containerRect.left + scrollLeft
                const containerCenter = containerRect.width / 2
                const targetScroll = notchOffset - containerCenter

                container.scrollTo({
                    left: targetScroll,
                    behavior: 'smooth'
                })
            }
        }
        // containerRef is a stable RefObject; listing it satisfies exhaustive-deps without
        // changing how often this effect runs (identity never changes across renders).
    }, [selectedLTV, containerRef])
}
