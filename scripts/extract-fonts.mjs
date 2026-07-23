#!/usr/bin/env node
/*
 * extract-fonts.mjs — Living Typeface font extractor
 * ==================================================
 * The user's living-typeface design HTML embeds every font as a base64
 * `data:font/woff2` URI inside @font-face rules. Those woff2 payloads can only be
 * reproduced by copying them out of that file (never regenerate them). This script
 * parses the @font-face blocks, decodes each embedded woff2, writes it to
 * public/fonts/{redaction,jetbrains}/<name>.woff2, and prints the matching
 * @font-face CSS to paste into styles/fonts.css.
 *
 * Usage:
 *   node scripts/extract-fonts.mjs path/to/living-typeface.html
 *
 * Families handled (font-family value in each @font-face block):
 *   'Redaction'                          -> redaction-<weight>[-italic].woff2  (redaction/)
 *   'Redaction 10' / 35 / 50 / 70 / 100  -> redaction-<n>.woff2                (redaction/)
 *   'JetBrains Mono'                      -> jetbrains-<weight>.woff2           (jetbrains/)
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const inputPath = process.argv[2]
if (!inputPath) {
  console.error('Usage: node scripts/extract-fonts.mjs path/to/living-typeface.html')
  process.exit(1)
}

// Resolve output roots relative to this script's location (scripts/ -> repo root).
const scriptDir = path.dirname(new URL(import.meta.url).pathname)
const repoRoot = path.resolve(scriptDir, '..')
const REDACTION_DIR = path.join(repoRoot, 'public', 'fonts', 'redaction')
const JETBRAINS_DIR = path.join(repoRoot, 'public', 'fonts', 'jetbrains')

/** Pull the value of a single-quoted or double-quoted / bare CSS declaration. */
function declValue(block, prop) {
  const m = block.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`, 'i'))
  return m ? m[1].trim() : undefined
}

/** Strip surrounding quotes from a CSS string value. */
function unquote(v) {
  if (!v) return v
  return v.replace(/^['"]/, '').replace(/['"]$/, '').trim()
}

/**
 * Derive { dir, filename, cssFamily, style, weight } for a parsed @font-face block.
 * Returns null if the family is not one we recognise.
 */
function classify(rawFamily, weight, style) {
  const family = unquote(rawFamily)
  const isItalic = (style || '').toLowerCase().includes('italic')
  const w = (weight || '400').toString().trim()

  // JetBrains Mono
  if (/jetbrains/i.test(family)) {
    return {
      dir: JETBRAINS_DIR,
      subdir: 'jetbrains',
      filename: `jetbrains-${w}.woff2`,
      cssFamily: 'JetBrains Mono',
      style: isItalic ? 'italic' : 'normal',
      weight: w,
    }
  }

  // Redaction pixelation display variants: "Redaction 10" / 35 / 50 / 70 / 100
  const pix = family.match(/^Redaction\s+(\d+)$/i)
  if (pix) {
    return {
      dir: REDACTION_DIR,
      subdir: 'redaction',
      filename: `redaction-${pix[1]}.woff2`,
      cssFamily: `Redaction ${pix[1]}`,
      style: isItalic ? 'italic' : 'normal',
      weight: w,
    }
  }

  // Base Redaction serif
  if (/^Redaction$/i.test(family)) {
    return {
      dir: REDACTION_DIR,
      subdir: 'redaction',
      filename: isItalic ? `redaction-italic-${w}.woff2` : `redaction-${w}.woff2`,
      cssFamily: 'Redaction',
      style: isItalic ? 'italic' : 'normal',
      weight: w,
    }
  }

  return null
}

async function main() {
  const html = await fs.readFile(path.resolve(inputPath), 'utf8')

  // Grab every @font-face { ... } block.
  const blocks = html.match(/@font-face\s*{[^}]*}/gi) || []
  if (blocks.length === 0) {
    console.error('No @font-face blocks found in', inputPath)
    process.exit(1)
  }

  await fs.mkdir(REDACTION_DIR, { recursive: true })
  await fs.mkdir(JETBRAINS_DIR, { recursive: true })

  const cssOut = []
  let written = 0
  let skipped = 0

  for (const block of blocks) {
    const family = declValue(block, 'font-family')
    const weight = declValue(block, 'font-weight')
    const style = declValue(block, 'font-style')
    const src = declValue(block, 'src')

    // Only handle blocks whose src embeds a base64 woff2 data-URI.
    const dataMatch = (src || block).match(
      /data:(?:application\/font-woff2|font\/woff2|application\/x-font-woff2)[^,]*;base64,([A-Za-z0-9+/=\s]+)/i,
    )
    if (!dataMatch) {
      skipped++
      continue
    }

    const info = classify(family, weight, style)
    if (!info) {
      console.warn(`Skipping unrecognised family: ${family}`)
      skipped++
      continue
    }

    const base64 = dataMatch[1].replace(/\s+/g, '')
    const buf = Buffer.from(base64, 'base64')
    const outFile = path.join(info.dir, info.filename)
    await fs.writeFile(outFile, buf)
    written++
    console.log(`  wrote public/fonts/${info.subdir}/${info.filename} (${buf.length} bytes)`)

    cssOut.push(
      [
        '@font-face {',
        `  font-family: '${info.cssFamily}';`,
        `  src: url('/fonts/${info.subdir}/${info.filename}') format('woff2');`,
        `  font-weight: ${info.weight};`,
        `  font-style: ${info.style};`,
        '  font-display: swap;',
        '}',
      ].join('\n'),
    )
  }

  console.log(`\nDone: ${written} font file(s) written, ${skipped} block(s) skipped.`)
  console.log('\n----- Paste into styles/fonts.css -----\n')
  console.log(cssOut.join('\n\n'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
