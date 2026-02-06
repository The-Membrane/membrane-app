import { useEffect, useCallback, useRef } from 'react'
import { useDittoSpeechBox } from './useDittoSpeechBox'
import { SpeechBoxView } from '../types'

interface KeyboardShortcut {
    key: string
    ctrlKey?: boolean
    shiftKey?: boolean
    altKey?: boolean
    metaKey?: boolean
    action: () => void
    description: string
}

/**
 * Hook for keyboard navigation within Ditto
 */
export const useKeyboardNavigation = () => {
    const { 
        isOpen, 
        toggleSpeechBox, 
        returnToHub, 
        close, 
        currentView,
        openSection 
    } = useDittoSpeechBox()

    const focusableElementsRef = useRef<HTMLElement[]>([])
    const currentFocusIndexRef = useRef(-1)

    // Navigate focus within Ditto
    const navigateFocus = useCallback((direction: 'next' | 'prev') => {
        const elements = focusableElementsRef.current
        if (elements.length === 0) return

        let newIndex = currentFocusIndexRef.current
        
        if (direction === 'next') {
            newIndex = (newIndex + 1) % elements.length
        } else {
            newIndex = newIndex <= 0 ? elements.length - 1 : newIndex - 1
        }

        elements[newIndex]?.focus()
        currentFocusIndexRef.current = newIndex
    }, [])

    // Define keyboard shortcuts
    const shortcuts: KeyboardShortcut[] = [
        {
            key: 'd',
            ctrlKey: true,
            action: toggleSpeechBox,
            description: 'Toggle Ditto',
        },
        {
            key: 'Escape',
            action: () => {
                if (isOpen) {
                    if (currentView !== 'hub') {
                        returnToHub()
                    } else {
                        close()
                    }
                }
            },
            description: 'Close/Back',
        },
        {
            key: 'ArrowDown',
            action: () => navigateFocus('next'),
            description: 'Next item',
        },
        {
            key: 'ArrowUp',
            action: () => navigateFocus('prev'),
            description: 'Previous item',
        },
        {
            key: 'h',
            altKey: true,
            action: () => isOpen && returnToHub(),
            description: 'Return to Hub',
        },
        {
            key: '1',
            altKey: true,
            action: () => isOpen && openSection('disco'),
            description: 'Open Disco',
        },
        {
            key: '2',
            altKey: true,
            action: () => isOpen && openSection('transmuter'),
            description: 'Open Transmuter',
        },
        {
            key: '3',
            altKey: true,
            action: () => isOpen && openSection('manic'),
            description: 'Open Manic',
        },
        {
            key: 'u',
            altKey: true,
            action: () => isOpen && openSection('updates'),
            description: 'Open Updates',
        },
    ]

    // Handle keyboard events
    const handleKeyDown = useCallback((event: KeyboardEvent) => {
        // Don't intercept if user is typing in an input
        if (
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement ||
            (event.target as HTMLElement)?.isContentEditable
        ) {
            // Only allow Escape to work in inputs
            if (event.key !== 'Escape') return
        }

        for (const shortcut of shortcuts) {
            const keyMatches = event.key === shortcut.key || event.key.toLowerCase() === shortcut.key.toLowerCase()
            const ctrlMatches = shortcut.ctrlKey ? event.ctrlKey || event.metaKey : !event.ctrlKey && !event.metaKey
            const shiftMatches = shortcut.shiftKey ? event.shiftKey : !event.shiftKey
            const altMatches = shortcut.altKey ? event.altKey : !event.altKey

            if (keyMatches && ctrlMatches && shiftMatches && altMatches) {
                event.preventDefault()
                shortcut.action()
                return
            }
        }
    }, [shortcuts])

    // Set up event listeners
    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [handleKeyDown])

    // Update focusable elements when view changes
    const updateFocusableElements = useCallback((containerRef: HTMLElement | null) => {
        if (!containerRef) {
            focusableElementsRef.current = []
            return
        }

        const focusable = containerRef.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        focusableElementsRef.current = Array.from(focusable)
        currentFocusIndexRef.current = -1
    }, [])

    return {
        shortcuts,
        navigateFocus,
        updateFocusableElements,
        // Utility for displaying shortcuts
        getShortcutKey: (shortcut: KeyboardShortcut): string => {
            const parts: string[] = []
            if (shortcut.ctrlKey) parts.push('Ctrl')
            if (shortcut.altKey) parts.push('Alt')
            if (shortcut.shiftKey) parts.push('Shift')
            if (shortcut.metaKey) parts.push('⌘')
            parts.push(shortcut.key.toUpperCase())
            return parts.join('+')
        },
    }
}

