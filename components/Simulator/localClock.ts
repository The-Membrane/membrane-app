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

/** "Saturday, October 10, 2026" — the newspaper masthead's dateline, in the reader's
 *  own zone. Takes milliseconds (it is "now", not a path timestamp). */
export function fmtLocalDateline(ms: number, zone: string | undefined): string {
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: zone,
  })
}

/** "2026-10-10" — a calendar day in the reader's own zone, in the ISO shape a dated
 *  meta line already uses. `toISOString().slice(0, 10)` is the UTC day, which is a
 *  day off for a reader west of UTC in the evening. Takes milliseconds. */
export function fmtLocalIsoDate(ms: number, zone: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: zone,
  }).formatToParts(new Date(ms))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
