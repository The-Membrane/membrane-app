import {
  selectedVenueForecastAnalogPrior,
  type AnalogCashScenario,
  type VenueForecastAnalogPriorInput,
} from './venueForecastAnalogPrior'
import type { ConditionalSampledCashCurrentSource } from './conditionalSampledCashPathProjection'

export type AnalogCashScenarioIssue = {
  input: VenueForecastAnalogPriorInput
  currentSource: ConditionalSampledCashCurrentSource
}
function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, i) => equal(value, b[i]))
    )
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aa = a as Record<string, unknown>,
      bb = b as Record<string, unknown>
    return (
      Object.keys(aa).length === Object.keys(bb).length &&
      Object.keys(aa).every((key) => Object.hasOwn(bb, key) && equal(aa[key], bb[key]))
    )
  }
  return Object.is(a, b)
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
/** Snapshot the server's separate issue context, never the projection's own input. */
export function snapshotAnalogCashScenarioIssue(
  value: AnalogCashScenario | null | undefined,
): AnalogCashScenarioIssue | null {
  try {
    if (
      value?.status !== 'analog_cash_scenario' ||
      value.Ea !== null ||
      value.claim !== 'conditional_analog_native_cash_only' ||
      value.holderExecutableExit !== false ||
      value.forecastValidated !== false ||
      value.historicalExtremesAreConfidenceBands !== false ||
      !equal(value.issuedInput.currentSource, value.currentSource)
    )
      return null
    return freeze(structuredClone({ input: value.issuedInput, currentSource: value.currentSource }))
  } catch {
    return null
  }
}
/** Display integrity only: the server issuer alone authenticates native evidence. */
export function selectedAnalogCashScenarioForPresentation(
  value: AnalogCashScenario | null | undefined,
  issued: AnalogCashScenarioIssue | null,
  question: {
    routeKey: string
    destination: string
    asset: string | null
    decimals: number | null
    requestedRaw: string | null
    horizonHours: number
    asOfMs: number
    currentSource: ConditionalSampledCashCurrentSource | null
    ownNativeAvailable: boolean
    currentSourceConflict?: boolean
  },
  hash: (serialized: string) => string,
) {
  try {
    if (
      !issued ||
      !snapshotAnalogCashScenarioIssue(value) ||
      value?.status !== 'analog_cash_scenario' ||
      question.ownNativeAvailable ||
      question.currentSourceConflict ||
      !question.currentSource ||
      !question.requestedRaw ||
      !question.asset ||
      question.decimals === null ||
      issued.input.currentProfile.identity.routeKey !== question.routeKey ||
      issued.input.currentProfile.identity.destination !== question.destination.toLowerCase() ||
      issued.input.currentProfile.identity.asset !== question.asset.toLowerCase() ||
      issued.input.currentProfile.identity.assetDecimals !== question.decimals ||
      issued.input.requestedRaw !== question.requestedRaw ||
      issued.input.horizonHours !== question.horizonHours ||
      !equal(issued.input, value.issuedInput) ||
      !equal(issued.currentSource, value.currentSource) ||
      !equal(issued.currentSource, question.currentSource) ||
      value.donorSelection.limit !== 16 ||
      value.donorSelection.selectedDonors !== issued.input.donors.length ||
      value.donorSelection.selectedDonors > 16 ||
      value.donorSelection.eligibleDonors < value.donorSelection.selectedDonors
    )
      return null
    // These callbacks bind arithmetic replay to the externally captured server
    // issue. They neither authenticate JSON nor approve holder execution.
    return selectedVenueForecastAnalogPrior(
      value.prior,
      { input: issued.input, asOfMs: question.asOfMs },
      hash,
      {
        current: (candidate) =>
          equal(candidate, issued.input) && equal(candidate.currentSource, question.currentSource),
        donor: (candidate) => issued.input.donors.some((donor) => equal(candidate, donor)),
      },
    )
  } catch {
    return null
  }
}
