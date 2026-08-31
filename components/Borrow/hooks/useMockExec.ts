import { useCallback, useEffect, useRef, useState } from 'react'

import type { ExecPhase } from '../types'

export interface UseMockExecResult {
  phase: ExecPhase
  /** Kicks off the signing → pending → done choreography. */
  confirm: () => void
  /** Resets back to 'confirm' — call when the sheet closes. */
  reset: () => void
}

/**
 * Mock-chain choreography ported from window.__exec's go.onclick in
 * public/proto/borrow.html (lines ~372-382): "signing…" for 800ms, then
 * "pending — waiting for the receipt…" for 1100ms, then settled. Real chain,
 * same choreography — this hook only owns the phase timing.
 */
export function useMockExec(): UseMockExecResult {
  const [phase, setPhase] = useState<ExecPhase>('confirm')
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearTimers = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }

  const confirm = useCallback(() => {
    setPhase('signing')
    timers.current.push(
      setTimeout(() => {
        setPhase('pending')
        timers.current.push(setTimeout(() => setPhase('done'), 1100))
      }, 800)
    )
  }, [])

  const reset = useCallback(() => {
    clearTimers()
    setPhase('confirm')
  }, [])

  useEffect(() => clearTimers, [])

  return { phase, confirm, reset }
}

export default useMockExec
