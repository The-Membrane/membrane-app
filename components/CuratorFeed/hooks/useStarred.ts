// Starred §07 markets: a per-viewer convenience, kept in this browser's localStorage.
// Every read and write is guarded: a private window, blocked storage or a thumbnail
// capture just means no stars, and the section works the same without them.

import { useCallback, useEffect, useState } from 'react'

import { parseStarred, STARRED_KEY, toggleStar } from '../oracleGapView'

export function useStarred() {
  const [starred, setStarred] = useState<Set<string>>(() => new Set())
  // Read after mount: the first render matches the server's (no stars).
  useEffect(() => {
    try {
      setStarred(parseStarred(window.localStorage.getItem(STARRED_KEY)))
    } catch {
      // storage unavailable: no stars
    }
  }, [])
  const toggle = useCallback((market: string) => {
    setStarred((s) => {
      const next = toggleStar(s, market)
      try {
        window.localStorage.setItem(STARRED_KEY, JSON.stringify([...next]))
      } catch {
        // storage unavailable: the star holds for this visit only
      }
      return next
    })
  }, [])
  return { starred, toggle }
}
