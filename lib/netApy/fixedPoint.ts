/**
 * Fixed-point helpers that reproduce the on-chain math BIT FOR BIT.
 *
 * Each function names the Solidity it copies. The rounding is the point: Aave rounds
 * half-up (WadRayMath / PercentageMath), Morpho's IRM truncates toward zero on signed
 * values (MathLib.wMulToZero / wDivToZero) and Euler truncates in uint math. A
 * projection that rounds differently still drifts by a wei; the fixture test
 * (tests/unit/netApyIrm.test.ts) holds every model to exact equality with the chain.
 *
 * No I/O. Pure bigint.
 */

export const WAD = 10n ** 18n
export const RAY = 10n ** 27n
export const HALF_RAY = RAY / 2n
export const PERCENTAGE_FACTOR = 10_000n
export const HALF_PERCENTAGE_FACTOR = PERCENTAGE_FACTOR / 2n
/** Aave, Morpho and Euler all annualise with a 365-day year. */
export const SECONDS_PER_YEAR = 365n * 24n * 3600n

// ------------------------------------------------------------------ Aave (half-up)

/** WadRayMath.rayMul: (a·b + RAY/2) / RAY. */
export const rayMul = (a: bigint, b: bigint): bigint => (a * b + HALF_RAY) / RAY

/** WadRayMath.rayDiv: (a·RAY + b/2) / b. Throws on b = 0, as the assembly reverts. */
export const rayDiv = (a: bigint, b: bigint): bigint => {
  if (b === 0n) throw new Error('rayDiv: division by zero')
  return (a * RAY + b / 2n) / b
}

/** WadRayMath.wadToRay: a · 1e9. */
export const wadToRay = (a: bigint): bigint => a * 10n ** 9n

/** PercentageMath.percentMul: (v·p + 5000) / 10000. */
export const percentMul = (value: bigint, percentage: bigint): bigint =>
  (value * percentage + HALF_PERCENTAGE_FACTOR) / PERCENTAGE_FACTOR

/** DefaultReserveInterestRateStrategyV2._bpsToRay. */
export const bpsToRay = (bps: bigint): bigint => bps * 10n ** 23n

// ---------------------------------------------------- Morpho (signed, toward zero)

/**
 * BigInt division already truncates toward zero, which is exactly Solidity's signed
 * `/`. These are kept as named functions so a reader can match them to the source.
 */
export const wMulToZero = (x: bigint, y: bigint): bigint => (x * y) / WAD
export const wDivToZero = (x: bigint, y: bigint): bigint => (x * WAD) / y
/** morpho-blue MathLib.wDivDown on uints. */
export const wDivDown = (x: bigint, y: bigint): bigint => (x * WAD) / y

/** morpho-blue-irm UtilsLib.bound: min(max(x, low), high). */
export const bound = (x: bigint, low: bigint, high: bigint): bigint => (x < low ? low : x > high ? high : x)

const LN_2_INT = 693_147_180_559_945_309n
const LN_WEI_INT = -41_446_531_673_892_822_312n
const WEXP_UPPER_BOUND = 93_859_467_695_000_404_319n
/** 57716089161558943949701069502944508345128.422502756744429568 ether */
const WEXP_UPPER_VALUE = 57_716_089_161_558_943_949_701_069_502_944_508_345_128_422_502_756_744_429_568n

/**
 * morpho-blue-irm ExpLib.wExp — e^x in WAD with a 2nd-order Taylor term on the
 * remainder. `>>` on a negative bigint floors, as Solidity's SAR does; expR is
 * always positive here, so the two agree.
 */
export function wExp(x: bigint): bigint {
  if (x < LN_WEI_INT) return 0n
  if (x >= WEXP_UPPER_BOUND) return WEXP_UPPER_VALUE
  const roundingAdjustment = x < 0n ? -(LN_2_INT / 2n) : LN_2_INT / 2n
  const q = (x + roundingAdjustment) / LN_2_INT
  const r = x - q * LN_2_INT
  const expR = WAD + r + (r * r) / WAD / 2n
  return q >= 0n ? expR << q : expR >> -q
}

// ------------------------------------------------------------- display conversion

/** A fixed-point rate to a JS number. Display only — never feed it back into math. */
export const toFloat = (v: bigint, scale: bigint): number => {
  const whole = v / scale
  const frac = v % scale
  return Number(whole) + Number(frac) / Number(scale)
}

/** Continuous compounding of an APR. All three venues accrue per second, and at
 *  per-second granularity (1 + r/n)^n is e^r to well inside display precision. */
export const aprToApy = (apr: number): number => Math.expm1(apr)

/**
 * JSON with bigints. Snapshots carry raw on-chain integers (rates in ray, balances in
 * token units) and those exceed 2^53. A bigint is written as the string "<digits>n";
 * the reviver turns any string of that exact shape back into a bigint.
 */
export const bigintReplacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? `${v}n` : v)
export const bigintReviver = (_k: string, v: unknown): unknown =>
  typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v
