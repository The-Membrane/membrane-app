import type {
  buildSusdeHolderTimeProcess,
  buildSusdeHolderTimeProcessV2,
  SusdeCurrentSource,
} from './susdeHolderTimeProcess'

/** Existing ForecastWorkbench horizon choices. A horizon change selects an issued row. */
export const SUSDE_HOLDER_FORECAST_HORIZONS = [1, 24, 48, 168] as const
export type SusdeHolderForecastHorizon = (typeof SUSDE_HOLDER_FORECAST_HORIZONS)[number]
export type SusdeHolderTimeProcessV1Model = NonNullable<
  ReturnType<typeof buildSusdeHolderTimeProcess>
>
export type SusdeHolderTimeProcessV2Model = NonNullable<
  ReturnType<typeof buildSusdeHolderTimeProcessV2>
>
export type SusdeHolderTimeProcessModel =
  | SusdeHolderTimeProcessV1Model
  | SusdeHolderTimeProcessV2Model
export type SusdeHolderTimeProcessOutput = Omit<SusdeHolderTimeProcessV1Model, 'input'>
export type SusdeHolderTimeProcessV2Output = Omit<SusdeHolderTimeProcessV2Model, 'input'>

/** Transport data only: these types grant no current-evidence approval authority. */
type SusdeHolderForecastEnvelopeCommon = {
  owner: string
  originalRequestedRaw: string
  source: SusdeCurrentSource
  issueAtUtc: string
  sourceProofValidUntil: string
  currentReceiptSha256: string
  supportedHorizonHours: readonly SusdeHolderForecastHorizon[]
  executable: false
  fullHolderAbility: false
  forecastValidated: false
  prospectiveValidated: false
  calibratedProbability: false
}

/** One native historical capture, retained for exact historic v1 replay. */
export type SusdeHolderForecastEnvelopeV1 = SusdeHolderForecastEnvelopeCommon & {
  schema: 'susde_holder_forecast_envelope_v1'
  historyCaptureSha256: string
  inputCommon: Omit<SusdeHolderTimeProcessV1Model['input'], 'horizonHours'>
  modelsByHorizonHours: Readonly<Record<SusdeHolderForecastHorizon, SusdeHolderTimeProcessOutput>>
}

/** A composed evidence set of independent captures, never represented as one capture. */
export type SusdeHolderForecastEnvelopeV2 = SusdeHolderForecastEnvelopeCommon & {
  schema: 'susde_holder_forecast_envelope_v2'
  evidenceSetSha256: string
  inputCommon: Omit<SusdeHolderTimeProcessV2Model['input'], 'horizonHours'>
  modelsByHorizonHours: Readonly<Record<SusdeHolderForecastHorizon, SusdeHolderTimeProcessV2Output>>
}

export type SusdeHolderForecastEnvelope =
  | SusdeHolderForecastEnvelopeV1
  | SusdeHolderForecastEnvelopeV2
