import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import type { WeatherResponse } from '@/lib/weather/handler'

// GET /api/weather, shared by the weather strip and the Today home switch: one query key
// and one set of options, so react-query runs one fetch and both read the same response.
// The strip and the body it switches can then never disagree about the regime.

async function fetchWeather(): Promise<WeatherResponse> {
  const res = await fetch('/api/weather')
  if (!res.ok) throw new Error(`weather ${res.status}`)
  return res.json()
}

export function useWeather() {
  return useQuery({
    queryKey: ['weather'],
    queryFn: fetchWeather,
    refetchInterval: 60_000,
    staleTime: 55_000,
    refetchOnMount: true,
    retry: 1,
  })
}

/** The reader's clock, ticking, so ages stay true between refetches. Null until mount. */
export function useNow(everyMs: number): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
}
