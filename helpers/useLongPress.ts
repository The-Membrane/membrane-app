import { useRef, useCallback } from 'react'

interface UseLongPressOptions {
    onLongPress: () => void
    threshold?: number
    onPress?: () => void
}

export const useLongPress = ({ onLongPress, threshold = 500, onPress }: UseLongPressOptions) => {
    const timerRef = useRef<NodeJS.Timeout | null>(null)
    const isLongPressRef = useRef(false)

    const start = useCallback((e: React.MouseEvent | React.TouchEvent) => {
        isLongPressRef.current = false
        timerRef.current = setTimeout(() => {
            isLongPressRef.current = true
            onLongPress()
        }, threshold)
    }, [onLongPress, threshold])

    const stop = useCallback((e: React.MouseEvent | React.TouchEvent) => {
        if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
        }
        
        // If it wasn't a long press, trigger the regular press
        if (!isLongPressRef.current && onPress) {
            onPress()
        }
    }, [onPress])

    const ref = useCallback((node: HTMLElement | null) => {
        if (node) {
            node.addEventListener('mousedown', start as any)
            node.addEventListener('mouseup', stop as any)
            node.addEventListener('mouseleave', stop as any)
            node.addEventListener('touchstart', start as any)
            node.addEventListener('touchend', stop as any)
            node.addEventListener('touchcancel', stop as any)
        }
    }, [start, stop])

    return ref
}

