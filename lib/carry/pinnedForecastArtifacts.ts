import { sha256, stringToHex } from 'viem'
import type { MorphoV2HolderTimeProcessInput } from './morphoV2HolderTimeProcess'
/** Optional reviewed datasets are installed by exact bytes, never manufactured to satisfy imports. */
const values = new Map<string, unknown>()
export const FORECAST_ARTIFACT_PINS = Object.freeze({
  'aave-usdc-flow-stress-duration-v1.json':'234e6875376ff9978d2d7f019b83e93250455959b5a95ef1fcfcbbe588a86f62',
  'susds-pinned-index-history-v1.json':'a6e5de4c6f06efc2117e7fd1351a445bff295b5dd49ccc9ee2d312bcd5e151a7',
  'stusds-historical-capacity-2026-10-07T14-29.export.json':'f4b1ec1130f300d43e0ec7d0a60f9f18c4c17b2580a32460f8d5add533bd08fe',
  'morpho-usdt-reviewed-protocol-history-2026-10-08.frame.json':'098cac9ed3b7b766019cd8bfba24ace3b7f515b4f151b328eba48523f1749b1a',
  'fluid-protocol-capacity-history-usdc-oct2-2026-10-07.export.json':'f3911dd6361017f901a12654c83823de78b66e6219036d8eb1b3b66ee6802cf6',
  'fluid-protocol-capacity-history-usdt-oct2-2026-10-07.export.json':'86ce18b72109a95e3053cb2e29a97bb888d685a9160ae0f02edd2cfea3d8d060',
  'fluid-protocol-capacity-history-gho-oct2-2026-10-07.export.json':'66a5d0b9cdfaf9bb7e8821c100a82c6dd97575ef0e48fd8d8afdcbdb7ce83451',
  'morpho-v2-protocol-capacity-history-pilot-2026-10-07T15-32.frame.json':'d1062504e5d1e01c9183b1bc65654fc6a28c5e82571c0f021a7f3f7ee5ce8c6b',
})
function freeze<T>(v:T):T {if(v && typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}return v}
export function installPinnedForecastArtifact(name: keyof typeof FORECAST_ARTIFACT_PINS, text:string) {
  if(typeof text!=='string'||text.length>2*1024*1024||!Object.hasOwn(FORECAST_ARTIFACT_PINS,name)) return false
  try {
    const value=JSON.parse(text)
    // The sUSDS trust contract pins its exact canonical parsed serialization.
    const pinnedText = name==='susds-pinned-index-history-v1.json' ? JSON.stringify(value) : text
    if (sha256(stringToHex(pinnedText)).slice(2)!==FORECAST_ARTIFACT_PINS[name]) return false
    values.set(name,freeze(value));return true
  }catch{return false}
}
export function requiredPinnedForecastArtifact<T>(name:keyof typeof FORECAST_ARTIFACT_PINS):T {
  const value=values.get(name)
  if(!value)throw Error('pinned_forecast_artifact_missing:'+name)
  return structuredClone(value) as T
}
export function pinnedMorphoPilotHistory():MorphoV2HolderTimeProcessInput['history'] | null {
  const v=values.get('morpho-v2-protocol-capacity-history-pilot-2026-10-07T15-32.frame.json')
  return v ? structuredClone(v) as MorphoV2HolderTimeProcessInput['history'] : null
}

export function hasPinnedForecastArtifact(name:keyof typeof FORECAST_ARTIFACT_PINS):boolean { return values.has(name) }
