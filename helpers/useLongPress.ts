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

    const nodeRef = useRef<HTMLElement | null>(null)
    const ref = useCallback((node: HTMLElement | null) => {
        // Release listeners from the previously-attached node before (re)attaching. A
        // callback ref must clean up what it registers, and React 18 does not support
        // returning a cleanup from a callback ref — so track the node ourselves.
        const prev = nodeRef.current
        if (prev) {
            prev.removeEventListener('mousedown', start as any)
            prev.removeEventListener('mouseup', stop as any)
            prev.removeEventListener('mouseleave', stop as any)
            prev.removeEventListener('touchstart', start as any)
            prev.removeEventListener('touchend', stop as any)
            prev.removeEventListener('touchcancel', stop as any)
        }
        nodeRef.current = node
        if (node) {
            node.addEventListener('mousedown', start as any)
            node.addEventListener('mouseup', stop as any)
            node.addEventListener('mouseleave', stop as any)
            // start/stop never call preventDefault(), so these can be passive.
            node.addEventListener('touchstart', start as any, { passive: true })
            node.addEventListener('touchend', stop as any, { passive: true })
            node.addEventListener('touchcancel', stop as any)
        }
    }, [start, stop])

    return ref
}

