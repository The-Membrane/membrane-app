import { useCallback, useEffect, useState } from 'react'

/**
 * SSR-safe localStorage-backed state. Mirrors the proto's localStorage seams
 * ('membrane.view', 'membrane.role', 'membrane.demoTour') but never touches
 * storage during render, so the server render and first client render agree.
 */
export function usePersistentState<T extends string>(
  key: string,
  fallback: T
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(fallback)

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const stored = window.localStorage.getItem(key)
      if (stored !== null) setValue(stored as T)
    } catch {
      /* storage unavailable — keep fallback */
    }
  }, [key])

  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        window.localStorage.setItem(key, next)
      } catch {
        /* ignore */
      }
    },
    [key]
  )

  return [value, set]
}
