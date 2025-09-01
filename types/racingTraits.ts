export enum PaintFinish { Solid = 'Solid', Metallic = 'Metallic', Matte = 'Matte', Pearlescent = 'Pearlescent' }

export enum BaseColor {
  Black = 'Black', White = 'White', Silver = 'Silver', Gray = 'Gray', Red = 'Red', Blue = 'Blue', Green = 'Green', Yellow = 'Yellow', Orange = 'Orange', Purple = 'Purple',
  Teal = 'Teal', Gold = 'Gold', CustomHex = 'CustomHex'
}

export enum AccentPattern { None = 'None', Stripes = 'Stripes', Flames = 'Flames', Camo = 'Camo', Geometric = 'Geometric', Gradient = 'Gradient' }
export enum HeadlightColor { White = 'White', Blue = 'Blue', NeonGreen = 'NeonGreen', Pink = 'Pink' }
export enum UnderglowColor { None = 'None', White = 'White', Blue = 'Blue', Purple = 'Purple', Red = 'Red', Green = 'Green' }
export enum BrakeLightStyle { ClassicRect = 'ClassicRect', SlimStrip = 'SlimStrip', Circular = 'Circular', SplitPanel = 'SplitPanel' }
export enum FrontBumperStyle { Standard = 'Standard', SportAggressive = 'SportAggressive', OffroadReinforced = 'OffroadReinforced', Retro = 'Retro' }
export enum SpoilerType { None = 'None', SmallLip = 'SmallLip', Ducktail = 'Ducktail', LargeGtWing = 'LargeGtWing' }
export enum RoofType { Hardtop = 'Hardtop', Convertible = 'Convertible', Sunroof = 'Sunroof', Targa = 'Targa' }
export enum FenderStyle { Stock = 'Stock', Widebody = 'Widebody', RetroFlare = 'RetroFlare', AeroCutout = 'AeroCutout' }
export enum ExhaustLength { Short = 'Short', Mid = 'Mid', Long = 'Long' }
export enum ExhaustTipStyle { Round = 'Round', Square = 'Square', Angled = 'Angled', DualPipe = 'DualPipe' }
export enum EngineVisuals { Covered = 'Covered', ChromePipes = 'ChromePipes', VisibleIntercooler = 'VisibleIntercooler', PaintedValveCover = 'PaintedValveCover' }
export enum RimStyle { Classic5Spoke = 'Classic5Spoke', FuturisticSolid = 'FuturisticSolid', Mesh = 'Mesh', DeepDish = 'DeepDish' }
export enum RimColor { Chrome = 'Chrome', Black = 'Black', Gold = 'Gold', Custom = 'Custom' }
export enum TireType { Slicks = 'Slicks', SemiSlicks = 'SemiSlicks', OffroadTread = 'OffroadTread', Whitewall = 'Whitewall' }
export enum NumberFont { BoldBlock = 'BoldBlock', ScriptItalic = 'ScriptItalic', RetroStencil = 'RetroStencil', Digital = 'Digital' }
export enum RoofAccessory { None = 'None', LightBar = 'LightBar', Antenna = 'Antenna', RoofRack = 'RoofRack' }
export enum SideMirror { Standard = 'Standard', AeroSmall = 'AeroSmall', RetroRound = 'RetroRound', WideRacing = 'WideRacing' }
export enum WindowTint { None = 'None', Light = 'Light', Medium = 'Medium', Dark = 'Dark', Colored = 'Colored' }
export enum TrailEffect { None = 'None', Smoke = 'Smoke', Sparks = 'Sparks', NeonStreak = 'NeonStreak' }
export enum DecalPreset { FlamesA = 'FlamesA', FlamesB = 'FlamesB', CamoDesert = 'CamoDesert', CamoUrban = 'CamoUrban', GeometricLines = 'GeometricLines', SponsorPackA = 'SponsorPackA', SponsorPackB = 'SponsorPackB' }

export type Decal = { kind: 'Preset', preset: DecalPreset } | { kind: 'Custom', svg: string }

export interface CarTraits {
  base_color: BaseColor
  accent_pattern: AccentPattern
  paint_finish: PaintFinish
  headlight_color: HeadlightColor
  underglow: UnderglowColor
  brake_light_style: BrakeLightStyle
  front_bumper: FrontBumperStyle
  spoiler: SpoilerType
  roof: RoofType
  fender: FenderStyle
  exhaust_length: ExhaustLength
  exhaust_tip: ExhaustTipStyle
  engine_visuals: EngineVisuals
  rim_style: RimStyle
  rim_color: RimColor
  tire: TireType
  number_font: NumberFont
  roof_accessory: RoofAccessory
  side_mirror: SideMirror
  window_tint: WindowTint
  trail_effect: TrailEffect
  decal: Decal
}

export type Weighted<T> = { item: T; weight: number }

export interface RarityTable {
  base_color: Weighted<BaseColor>[]
  accent_pattern: Weighted<AccentPattern>[]
  paint_finish: Weighted<PaintFinish>[]
  headlight_color: Weighted<HeadlightColor>[]
  underglow: Weighted<UnderglowColor>[]
  brake_light_style: Weighted<BrakeLightStyle>[]
  front_bumper: Weighted<FrontBumperStyle>[]
  spoiler: Weighted<SpoilerType>[]
  roof: Weighted<RoofType>[]
  fender: Weighted<FenderStyle>[]
  exhaust_length: Weighted<ExhaustLength>[]
  exhaust_tip: Weighted<ExhaustTipStyle>[]
  engine_visuals: Weighted<EngineVisuals>[]
  rim_style: Weighted<RimStyle>[]
  rim_color: Weighted<RimColor>[]
  tire: Weighted<TireType>[]
  number_font: Weighted<NumberFont>[]
  roof_accessory: Weighted<RoofAccessory>[]
  side_mirror: Weighted<SideMirror>[]
  window_tint: Weighted<WindowTint>[]
  trail_effect: Weighted<TrailEffect>[]
  decal_preset: Weighted<DecalPreset>[]
  custom_decal_slot_weight: number
}

const w = <T,>(item: T, weight: number): Weighted<T> => ({ item, weight })

export const defaultRarityTable = (): RarityTable => ({
  base_color: [
    w(BaseColor.White, 1600), w(BaseColor.Black, 1600), w(BaseColor.Silver, 1200), w(BaseColor.Gray, 1200),
    w(BaseColor.Red, 900), w(BaseColor.Blue, 900), w(BaseColor.Green, 600), w(BaseColor.Orange, 400),
    w(BaseColor.Yellow, 300), w(BaseColor.Purple, 300), w(BaseColor.Teal, 300), w(BaseColor.Gold, 100),
  ],
  accent_pattern: [
    w(AccentPattern.None, 3500), w(AccentPattern.Stripes, 2200), w(AccentPattern.Flames, 1200), w(AccentPattern.Camo, 900), w(AccentPattern.Geometric, 900), w(AccentPattern.Gradient, 300),
  ],
  paint_finish: [
    w(PaintFinish.Solid, 5000), w(PaintFinish.Metallic, 3000), w(PaintFinish.Matte, 1500), w(PaintFinish.Pearlescent, 500),
  ],
  headlight_color: [
    w(HeadlightColor.White, 6000), w(HeadlightColor.Blue, 2500), w(HeadlightColor.NeonGreen, 900), w(HeadlightColor.Pink, 600),
  ],
  underglow: [
    w(UnderglowColor.None, 6000), w(UnderglowColor.Blue, 1200), w(UnderglowColor.Purple, 900), w(UnderglowColor.Red, 900), w(UnderglowColor.Green, 700), w(UnderglowColor.White, 300),
  ],
  brake_light_style: [
    w(BrakeLightStyle.ClassicRect, 4000), w(BrakeLightStyle.SlimStrip, 3200), w(BrakeLightStyle.Circular, 1800), w(BrakeLightStyle.SplitPanel, 1000),
  ],
  front_bumper: [
    w(FrontBumperStyle.Standard, 5000), w(FrontBumperStyle.SportAggressive, 2500), w(FrontBumperStyle.Retro, 1500), w(FrontBumperStyle.OffroadReinforced, 1000),
  ],
  spoiler: [
    w(SpoilerType.None, 4200), w(SpoilerType.SmallLip, 3200), w(SpoilerType.Ducktail, 1800), w(SpoilerType.LargeGtWing, 800),
  ],
  roof: [
    w(RoofType.Hardtop, 5200), w(RoofType.Sunroof, 2200), w(RoofType.Targa, 900), w(RoofType.Convertible, 700),
  ],
  fender: [
    w(FenderStyle.Stock, 5200), w(FenderStyle.Widebody, 2200), w(FenderStyle.RetroFlare, 1600), w(FenderStyle.AeroCutout, 1000),
  ],
  exhaust_length: [ w(ExhaustLength.Mid, 5000), w(ExhaustLength.Short, 3000), w(ExhaustLength.Long, 2000) ],
  exhaust_tip: [ w(ExhaustTipStyle.Round, 4500), w(ExhaustTipStyle.Square, 2000), w(ExhaustTipStyle.Angled, 2000), w(ExhaustTipStyle.DualPipe, 1500) ],
  engine_visuals: [
    w(EngineVisuals.Covered, 5200), w(EngineVisuals.PaintedValveCover, 2000), w(EngineVisuals.ChromePipes, 1600), w(EngineVisuals.VisibleIntercooler, 1200),
  ],
  rim_style: [ w(RimStyle.Classic5Spoke, 4000), w(RimStyle.Mesh, 3000), w(RimStyle.DeepDish, 1800), w(RimStyle.FuturisticSolid, 1200) ],
  rim_color: [ w(RimColor.Black, 3800), w(RimColor.Chrome, 3400), w(RimColor.Gold, 1400), w(RimColor.Custom, 1400) ],
  tire: [ w(TireType.SemiSlicks, 4200), w(TireType.Slicks, 3200), w(TireType.OffroadTread, 1800), w(TireType.Whitewall, 800) ],
  number_font: [ w(NumberFont.BoldBlock, 4200), w(NumberFont.Digital, 2400), w(NumberFont.RetroStencil, 2000), w(NumberFont.ScriptItalic, 1400) ],
  roof_accessory: [ w(RoofAccessory.None, 6000), w(RoofAccessory.Antenna, 1600), w(RoofAccessory.LightBar, 1200), w(RoofAccessory.RoofRack, 1200) ],
  side_mirror: [ w(SideMirror.Standard, 5200), w(SideMirror.AeroSmall, 2200), w(SideMirror.RetroRound, 1600), w(SideMirror.WideRacing, 1000) ],
  window_tint: [ w(WindowTint.None, 3000), w(WindowTint.Light, 2800), w(WindowTint.Medium, 2600), w(WindowTint.Dark, 1400), w(WindowTint.Colored, 200) ],
  trail_effect: [ w(TrailEffect.None, 6000), w(TrailEffect.Smoke, 1800), w(TrailEffect.Sparks, 1400), w(TrailEffect.NeonStreak, 800) ],
  decal_preset: [
    w(DecalPreset.FlamesA, 1500), w(DecalPreset.FlamesB, 1200), w(DecalPreset.CamoDesert, 1100), w(DecalPreset.CamoUrban, 1100), w(DecalPreset.GeometricLines, 900), w(DecalPreset.SponsorPackA, 800), w(DecalPreset.SponsorPackB, 800),
  ],
  custom_decal_slot_weight: 600,
})

// xorshift32 PRNG for deterministic but simple rolls
const xorshift32 = (state: number): number => {
  let x = state | 0
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return (x >>> 0)
}

const pickWeighted = <T,>(roll: number, options: Weighted<T>[]): T => {
  const total = options.reduce((a, b) => a + b.weight, 0)
  let r = total === 0 ? 0 : roll % total
  for (const w of options) {
    if (r < w.weight) return w.item
    r -= w.weight
  }
  return options[options.length - 1].item
}

export const generateTraits = (seed: number, table: RarityTable): CarTraits => {
  let s = seed >>> 0
  const next = () => { s = xorshift32(s); return s }

  const base_color = pickWeighted(next(), table.base_color)
  const accent_pattern = pickWeighted(next(), table.accent_pattern)
  const paint_finish = pickWeighted(next(), table.paint_finish)
  const headlight_color = pickWeighted(next(), table.headlight_color)
  const underglow = pickWeighted(next(), table.underglow)
  const brake_light_style = pickWeighted(next(), table.brake_light_style)
  const front_bumper = pickWeighted(next(), table.front_bumper)
  const spoiler = pickWeighted(next(), table.spoiler)
  const roof = pickWeighted(next(), table.roof)
  const fender = pickWeighted(next(), table.fender)
  const exhaust_length = pickWeighted(next(), table.exhaust_length)
  const exhaust_tip = pickWeighted(next(), table.exhaust_tip)
  const engine_visuals = pickWeighted(next(), table.engine_visuals)
  const rim_style = pickWeighted(next(), table.rim_style)
  const rim_color = pickWeighted(next(), table.rim_color)
  const tire = pickWeighted(next(), table.tire)
  const number_font = pickWeighted(next(), table.number_font)
  const roof_accessory = pickWeighted(next(), table.roof_accessory)
  const side_mirror = pickWeighted(next(), table.side_mirror)
  const window_tint = pickWeighted(next(), table.window_tint)
  const trail_effect = pickWeighted(next(), table.trail_effect)

  const sum_presets = table.decal_preset.reduce((a, b) => a + b.weight, 0)
  const total = sum_presets + table.custom_decal_slot_weight
  const r = next() % Math.max(1, total)

  const decal: Decal = (r < sum_presets)
    ? { kind: 'Preset', preset: pickWeighted(r, table.decal_preset) }
    : { kind: 'Custom', svg: '' }

  return {
    base_color, accent_pattern, paint_finish, headlight_color, underglow, brake_light_style, front_bumper, spoiler, roof, fender, exhaust_length, exhaust_tip, engine_visuals, rim_style, rim_color, tire, number_font, roof_accessory, side_mirror, window_tint, trail_effect, decal,
  }
}

export const randomSeed = (): number => {
  const a = Math.floor(Math.random() * 0xffffffff)
  const b = Date.now() & 0xffffffff
  return (a ^ b) >>> 0
}

export const baseColorToHex = (c: BaseColor): string => {
  switch (c) {
    case BaseColor.Black: return '#111111'
    case BaseColor.White: return '#f4f4f4'
    case BaseColor.Silver: return '#c0c0c0'
    case BaseColor.Gray: return '#777777'
    case BaseColor.Red: return '#c0392b'
    case BaseColor.Blue: return '#2980b9'
    case BaseColor.Green: return '#27ae60'
    case BaseColor.Yellow: return '#f1c40f'
    case BaseColor.Orange: return '#e67e22'
    case BaseColor.Purple: return '#8e44ad'
    case BaseColor.Teal: return '#1abc9c'
    case BaseColor.Gold: return '#d4af37'
    case BaseColor.CustomHex: return '#ffffff'
    default: return '#ffffff'
  }
} 