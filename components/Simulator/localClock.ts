// Times in the reader's OWN timezone, 12-hour clock — "4:19 PM PDT", not "21:19 UTC".
//
// The measured path is UTC minute rounds, so every timestamp is a unix second; only
// the PRESENTATION is local. The server has no reader timezone, so SSR and the first
// client paint format in UTC; after mount the browser's zone takes over. That keeps
// the hydration byte-identical and then re-renders once with the local clock.

import { useEffect, useState } from 'react'

/** The zone to render in: undefined = the browser's own; 'UTC' before mount / on the server. */
export function useLocalZone(): string | undefined {
  const [zone, setZone] = useState<string | undefined>('UTC')
  useEffect(() => {
    try {
      setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || undefined)
    } catch {
      setZone(undefined)
    }
  }, [])
  return zone
}

/** "4:19 PM PDT" — hour without a leading zero, minutes, meridiem, short zone name. */
export function fmtLocalClock(ts: number, zone: string | undefined): string {
  const d = new Date(ts * 1000)
  return d
    .toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: zone,
      timeZoneName: 'short',
    })
    .replace(/ /g, ' ')
}

/** "10 Oct, 4:19 PM PDT" — for a stamp that needs the day as well. */
export function fmtLocalDayClock(ts: number, zone: string | undefined): string {
  const d = new Date(ts * 1000)
  const day = d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: zone })
  return `${day}, ${fmtLocalClock(ts, zone)}`
}
