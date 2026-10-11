/**
 * Oracle trees: how a move of one leaf reaches a market's price.
 *
 * A Morpho ChainlinkOracleV2 is a product of feeds and vault rates. An Ojo PT feed is
 * min(Pendle TWAP, linear discount). An Aave CAPO adapter clamps a rate's growth. Each
 * of these is a node; `evalTree` pushes a set of leaf moves through them and returns
 * the new output. Only ratios are used, so units and scale factors cancel.
 */

import type { LeafRead, PriceNode } from './types'

export type LeafNode = Extract<PriceNode, { op: 'leaf' }>

/** Evaluate the tree with each leaf's read value multiplied by `moveOf(leaf)`. */
export function evalTree(node: PriceNode, moveOf: (leaf: LeafNode) => number): number {
  switch (node.op) {
    case 'leaf':
      return node.value * moveOf(node)
    case 'const':
      return node.value
    case 'product': {
      let ratio = 1
      for (const f of node.factors) {
        const before = f.node.value
        const after = evalTree(f.node, moveOf)
        if (!(before > 0)) continue
        ratio *= f.exp === 1 ? after / before : before / after
      }
      return node.value * ratio
    }
    case 'min':
    case 'max': {
      const pick = node.op === 'min' ? Math.min : Math.max
      const before = pick(...node.of.map((c) => c.value))
      const after = pick(...node.of.map((c) => evalTree(c, moveOf)))
      return before > 0 ? node.value * (after / before) : node.value
    }
    case 'clamp': {
      const before = node.node.value
      let ratio = before > 0 ? evalTree(node.node, moveOf) / before : 1
      if (node.hi !== null) ratio = Math.min(ratio, node.hi)
      if (node.lo !== null) ratio = Math.max(ratio, node.lo)
      return node.value * ratio
    }
  }
}

/** Output factor (new / old) of the tree when leaf `leafId` read values move by `moveOf`. */
export function treeFactor(node: PriceNode, leafId: string, moveOf: (read: LeafRead) => number): number {
  if (!(node.value > 0)) return 1
  return evalTree(node, (l) => (l.leafId === leafId ? moveOf(l.read) : 1)) / node.value
}

/** Every leaf node in the tree, in order. */
export function leafNodes(node: PriceNode): LeafNode[] {
  switch (node.op) {
    case 'leaf':
      return [node]
    case 'const':
      return []
    case 'product':
      return node.factors.flatMap((f) => leafNodes(f.node))
    case 'min':
    case 'max':
      return node.of.flatMap(leafNodes)
    case 'clamp':
      return leafNodes(node.node)
  }
}

export const leafIds = (node: PriceNode): string[] => [...new Set(leafNodes(node).map((l) => l.leafId))]

/**
 * The log move a reader sees when the leaf spot is displaced by `x` (log) and held for
 * `holdSec`. Spot and feed reads see all of it. A TWAP of window W sees the held share
 * of the window. An EMA with half-life H sees 1 - 2^(-h/H).
 */
export function readMove(read: LeafRead, x: number, holdSec: number): number {
  switch (read.mode) {
    case 'spot':
    case 'feed':
    case 'rate':
      return x
    case 'twap':
      if (read.windowSec <= 0) return x
      return (x * Math.min(holdSec, read.windowSec)) / read.windowSec
    case 'ema':
      if (read.halfLifeSec <= 0) return x
      return x * (1 - Math.pow(2, -holdSec / read.halfLifeSec))
  }
}

/** Compact one-line rendering for JSON output and test messages. */
export function describeTree(node: PriceNode): string {
  switch (node.op) {
    case 'leaf': {
      const r = node.read
      const how = r.mode === 'twap' ? `twap${r.windowSec}s` : r.mode === 'ema' ? `ema${r.halfLifeSec}s` : r.mode
      return `${node.label ?? node.leafId}[${how}]`
    }
    case 'const':
      return `const(${node.label})`
    case 'product':
      return node.factors.map((f) => (f.exp === 1 ? '' : '1/') + describeTree(f.node)).join(' × ')
    case 'min':
    case 'max':
      return `${node.op}(${node.of.map(describeTree).join(', ')})`
    case 'clamp':
      return `clamp${node.label ? `<${node.label}>` : ''}[${node.lo ?? '-'},${node.hi ?? '-'}](${describeTree(node.node)})`
  }
}
