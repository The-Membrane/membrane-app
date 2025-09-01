import type { CarAttribute } from '@/components/Racing/hooks/useMintCar'

// Simple weighted random picker
function pickWeighted<T>(pairs: Array<{ value: T; weight: number }>): T {
  const total = pairs.reduce((s, p) => s + p.weight, 0)
  let r = Math.random() * total
  for (const p of pairs) {
    if (r < p.weight) return p.value
    r -= p.weight
  }
  return pairs[pairs.length - 1]!.value
}

// Color maps for preview
const colorHex = {
  White: '#ffffff',
  Black: '#000000',
  Silver: '#c0c0c0',
  Gray: '#808080',
  Red: '#ff3b3b',
  Blue: '#2a6bff',
  Green: '#2dff6a',
  Orange: '#ffa500',
  Yellow: '#ffe100',
  Purple: '#8a2be2',
  Teal: '#008080',
  Gold: '#ffd700',
} as const

const headlightHex = {
  White: '#ffffff',
  Blue: '#6bc1ff',
  NeonGreen: '#39ff14',
  Pink: '#ff66cc',
} as const

const underglowHex = {
  None: 'None',
  Blue: '#274bff',
  Purple: '#8000ff',
  Red: '#ff3b3b',
  Green: '#2dff6a',
  White: '#ffffff',
} as const

const rimHex = {
  Black: '#000000',
  Chrome: '#c9c9c9',
  Gold: '#ffd700',
} as const

const windowTintToAmount: Record<string, number> = {
  None: 0,
  Light: 0.25,
  Medium: 0.5,
  Dark: 0.75,
  Colored: 0.4,
}

function randomHex(): string {
  const v = Math.floor(Math.random() * 0xffffff)
  return `#${v.toString(16).padStart(6, '0')}`
}

function randomInRange(min: number, max: number): number {
  return Math.random() * (max - min) + min
}

export type GeneratedTraits = {
  attributes: CarAttribute[]
}

export function generateRandomTraits(): GeneratedTraits {
  // Rarity weights mirrored from traits_engine.rs default_rarity_table()
  const base_color = pickWeighted([
    { value: 'White', weight: 1600 },
    { value: 'Black', weight: 1600 },
    { value: 'Silver', weight: 1200 },
    { value: 'Gray', weight: 1200 },
    { value: 'Red', weight: 900 },
    { value: 'Blue', weight: 900 },
    { value: 'Green', weight: 600 },
    { value: 'Orange', weight: 400 },
    { value: 'Yellow', weight: 300 },
    { value: 'Purple', weight: 300 },
    { value: 'Teal', weight: 300 },
    { value: 'Gold', weight: 100 },
  ])

  const accent_pattern = pickWeighted([
    { value: 'None', weight: 3500 },
    { value: 'Stripes', weight: 2200 },
    { value: 'Flames', weight: 1200 },
    { value: 'Camo', weight: 900 },
    { value: 'Geometric', weight: 900 },
    { value: 'Gradient', weight: 300 },
  ])

  const paint_finish = pickWeighted([
    { value: 'Solid', weight: 5000 },
    { value: 'Metallic', weight: 3000 },
    { value: 'Matte', weight: 1500 },
    { value: 'Pearlescent', weight: 500 },
  ])

  const headlight_color = pickWeighted([
    { value: 'White', weight: 6000 },
    { value: 'Blue', weight: 2500 },
    { value: 'NeonGreen', weight: 900 },
    { value: 'Pink', weight: 600 },
  ])

  const underglow = pickWeighted([
    { value: 'None', weight: 6000 },
    { value: 'Blue', weight: 1200 },
    { value: 'Purple', weight: 900 },
    { value: 'Red', weight: 900 },
    { value: 'Green', weight: 700 },
    { value: 'White', weight: 300 },
  ])

  const brake_light_style = pickWeighted([
    { value: 'ClassicRect', weight: 4000 },
    { value: 'SlimStrip', weight: 3200 },
    { value: 'Circular', weight: 1800 },
    { value: 'SplitPanel', weight: 1000 },
  ])

  const front_bumper = pickWeighted([
    { value: 'Standard', weight: 5000 },
    { value: 'SportAggressive', weight: 2500 },
    { value: 'Retro', weight: 1500 },
    { value: 'OffroadReinforced', weight: 1000 },
  ])

  const spoiler = pickWeighted([
    { value: 'None', weight: 4200 },
    { value: 'SmallLip', weight: 3200 },
    { value: 'Ducktail', weight: 1800 },
    { value: 'LargeGtWing', weight: 800 },
  ])

  const roof = pickWeighted([
    { value: 'Hardtop', weight: 5200 },
    { value: 'Sunroof', weight: 2200 },
    { value: 'Targa', weight: 900 },
    { value: 'Convertible', weight: 700 },
  ])

  const fender = pickWeighted([
    { value: 'Stock', weight: 5200 },
    { value: 'Widebody', weight: 2200 },
    { value: 'RetroFlare', weight: 1600 },
    { value: 'AeroCutout', weight: 1000 },
  ])

  const exhaust_length = pickWeighted([
    { value: 'Mid', weight: 5000 },
    { value: 'Short', weight: 3000 },
    { value: 'Long', weight: 2000 },
  ])

  const exhaust_tip = pickWeighted([
    { value: 'Round', weight: 4500 },
    { value: 'Square', weight: 2000 },
    { value: 'Angled', weight: 2000 },
    { value: 'DualPipe', weight: 1500 },
  ])

  const engine_visuals = pickWeighted([
    { value: 'Covered', weight: 5200 },
    { value: 'PaintedValveCover', weight: 2000 },
    { value: 'ChromePipes', weight: 1600 },
    { value: 'VisibleIntercooler', weight: 1200 },
  ])

  const rim_style = pickWeighted([
    { value: 'Classic5Spoke', weight: 4000 },
    { value: 'Mesh', weight: 3000 },
    { value: 'DeepDish', weight: 1800 },
    { value: 'FuturisticSolid', weight: 1200 },
  ])

  const rim_color = pickWeighted([
    { value: 'Black', weight: 3800 },
    { value: 'Chrome', weight: 3400 },
    { value: 'Gold', weight: 1400 },
    { value: 'Custom', weight: 1400 },
  ])

  const tire = pickWeighted([
    { value: 'SemiSlicks', weight: 4200 },
    { value: 'Slicks', weight: 3200 },
    { value: 'OffroadTread', weight: 1800 },
    { value: 'Whitewall', weight: 800 },
  ])

  const number_font = pickWeighted([
    { value: 'BoldBlock', weight: 4200 },
    { value: 'Digital', weight: 2400 },
    { value: 'RetroStencil', weight: 2000 },
    { value: 'ScriptItalic', weight: 1400 },
  ])

  const roof_accessory = pickWeighted([
    { value: 'None', weight: 6000 },
    { value: 'Antenna', weight: 1600 },
    { value: 'LightBar', weight: 1200 },
    { value: 'RoofRack', weight: 1200 },
  ])

  const side_mirror = pickWeighted([
    { value: 'Standard', weight: 5200 },
    { value: 'AeroSmall', weight: 2200 },
    { value: 'RetroRound', weight: 1600 },
    { value: 'WideRacing', weight: 1000 },
  ])

  const window_tint = pickWeighted([
    { value: 'None', weight: 3000 },
    { value: 'Light', weight: 2800 },
    { value: 'Medium', weight: 2600 },
    { value: 'Dark', weight: 1400 },
    { value: 'Colored', weight: 200 },
  ])

  const trail_effect = pickWeighted([
    { value: 'None', weight: 6000 },
    { value: 'Smoke', weight: 1800 },
    { value: 'Sparks', weight: 1400 },
    { value: 'NeonStreak', weight: 800 },
  ])

  const decal_preset = pickWeighted([
    { value: 'FlamesA', weight: 1500 },
    { value: 'FlamesB', weight: 1200 },
    { value: 'CamoDesert', weight: 1100 },
    { value: 'CamoUrban', weight: 1100 },
    { value: 'GeometricLines', weight: 900 },
    { value: 'SponsorPackA', weight: 800 },
    { value: 'SponsorPackB', weight: 800 },
    // Custom decal slot option
    { value: 'Custom', weight: 600 },
  ])

  // Derived/aux fields for preview parity with CarTraits
  const tintAmount = windowTintToAmount[window_tint] ?? 0
  const decalScale = Number(randomInRange(0.7, 1.3).toFixed(2))
  const decalOpacity = Number(randomInRange(0.5, 1).toFixed(2))

  const attributes: CarAttribute[] = [
    { trait_type: 'Base Color', value: `${base_color} ${colorHex[base_color as keyof typeof colorHex] ?? ''}`.trim() },
    { trait_type: 'Accent Pattern', value: accent_pattern },
    { trait_type: 'Paint Finish', value: paint_finish },

    { trait_type: 'Headlight Color', value: `${headlight_color} ${headlightHex[headlight_color as keyof typeof headlightHex] ?? ''}`.trim() },
    { trait_type: 'Underglow', value: underglow === 'None' ? 'None' : `${underglow} ${underglowHex[underglow as keyof typeof underglowHex]}` },
    { trait_type: 'Brake Light Style', value: brake_light_style },

    { trait_type: 'Front Bumper', value: front_bumper },
    { trait_type: 'Spoiler', value: spoiler },
    { trait_type: 'Roof', value: roof },
    { trait_type: 'Fender', value: fender },

    { trait_type: 'Exhaust Length', value: exhaust_length },
    { trait_type: 'Exhaust Tip', value: exhaust_tip },
    { trait_type: 'Engine Visuals', value: engine_visuals },

    { trait_type: 'Rim Style', value: rim_style },
    { trait_type: 'Rim Color', value: rim_color === 'Custom' ? `Custom ${randomHex()}` : `${rim_color} ${rimHex[rim_color as keyof typeof rimHex]}` },
    { trait_type: 'Tire', value: tire },

    { trait_type: 'Number Font', value: number_font },
    { trait_type: 'Roof Accessory', value: roof_accessory },
    { trait_type: 'Side Mirror', value: side_mirror },
    { trait_type: 'Window Tint', value: window_tint },
    { trait_type: 'Window Tint Amount', value: tintAmount.toFixed(2) },
    { trait_type: 'Trail Effect', value: trail_effect },

    { trait_type: 'Decal', value: decal_preset === 'Custom' ? 'Custom' : `Preset::${decal_preset}` },
    ...(decal_preset === 'Custom'
      ? [
          { trait_type: 'Decal URL', value: 'Upload at mint' },
          { trait_type: 'Decal Scale', value: decalScale.toFixed(2) },
          { trait_type: 'Decal Opacity', value: decalOpacity.toFixed(2) },
        ]
      : [
          { trait_type: 'Decal Scale', value: decalScale.toFixed(2) },
          { trait_type: 'Decal Opacity', value: decalOpacity.toFixed(2) },
        ]),
  ]

  return { attributes }
} 