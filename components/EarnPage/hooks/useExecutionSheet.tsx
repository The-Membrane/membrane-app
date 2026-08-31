import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

import { ExecPhase, ExecRequest } from '../types'

interface ExecutionSheetContextValue {
  request: ExecRequest | null
  phase: ExecPhase
  /** Opens the sheet with a new request, idle until the user confirms. */
  open: (request: ExecRequest) => void
  /** Dismisses the sheet entirely (Cancel, overlay click, or Close after done). */
  close: () => void
  /** Advances signing → pending → done, mirroring the proto's mock-chain choreography (script :357-367). */
  confirm: () => void
}

const ExecutionSheetContext = createContext<ExecutionSheetContextValue | null>(null)

/**
 * Ports the proto's `window.__exec(o)` global (public/proto/supply.html script :344-368):
 * one confirm sheet, numbers not prose, then a "signing… / pending — waiting for the
 * receipt… / done" mock-chain choreography (800ms + 1100ms). Wrap a page tree in this
 * provider once; any descendant CTA calls `open(request)` via `useExecutionSheet()`.
 */
export const ExecutionSheetProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [request, setRequest] = useState<ExecRequest | null>(null)
  const [phase, setPhase] = useState<ExecPhase>('idle')
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearTimers = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }

  const open = useCallback((req: ExecRequest) => {
    clearTimers()
    setRequest(req)
    setPhase('idle')
  }, [])

  const close = useCallback(() => {
    clearTimers()
    setRequest(null)
    setPhase('idle')
  }, [])

  const confirm = useCallback(() => {
    setPhase('signing')
    const t1 = setTimeout(() => {
      setPhase('pending')
      const t2 = setTimeout(() => setPhase('done'), 1100)
      timers.current.push(t2)
    }, 800)
    timers.current.push(t1)
  }, [])

  const value = useMemo(() => ({ request, phase, open, close, confirm }), [request, phase, open, close, confirm])

  return <ExecutionSheetContext.Provider value={value}>{children}</ExecutionSheetContext.Provider>
}

export const useExecutionSheet = (): ExecutionSheetContextValue => {
  const ctx = useContext(ExecutionSheetContext)
  if (!ctx) throw new Error('useExecutionSheet must be used within an ExecutionSheetProvider')
  return ctx
}
