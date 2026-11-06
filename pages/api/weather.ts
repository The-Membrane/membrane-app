import { getMainnetClient } from '@/lib/position-sim/rpc'
import { createWeatherHandler } from '@/lib/weather/handler'
import {
  readBaseFee,
  readChainlinkHourly,
  readCoinbaseHourly,
  readDvolEth,
} from '@/lib/weather/sources'

// PUBLIC. The masthead weather strip (components/Weather/WeatherStrip.tsx): Ethereum base
// fee, the Deribit DVOL daily move and the M0 regime (Chainlink vs Coinbase, last 48h).
//
//   GET /api/weather
//
// DATA: keyless public sources only. Chain reads go through the read-only mainnet client
// (lib/position-sim/rpc.ts: public RPC list, NEXT_PUBLIC_MAINNET_RPC_URL first when set).
// Partial failure is a 200 with that part null and its error; total failure is a 503.
// The handler, memo and cache headers are lib/weather/handler.ts.

export default createWeatherHandler({
  now: () => Date.now(),
  gas: () => readBaseFee(getMainnetClient()),
  dvol: (nowMs) => readDvolEth(fetch, nowMs),
  market: (nowMs) => readCoinbaseHourly(fetch, nowMs),
  oracle: (nowMs) => readChainlinkHourly(getMainnetClient(), nowMs),
})
