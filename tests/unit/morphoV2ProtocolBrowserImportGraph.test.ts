import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const entries = [
  'lib/carry/morphoV2ProtocolCapacityHistoryPins.ts',
  'lib/carry/morphoV2ProtocolCapacityReplay.ts',
  'lib/carry/morphoV2ProtocolEvidenceCodec.ts',
  'lib/carry/morphoV2HolderTimeProcess.ts',
]
const builtins = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, '')]))
// Existing browser subject metadata is separate from native protocol receipt/history evidence.
const existingSubjectMetadata = 'scripts/route-cohort/aug-2026-ab-vault-seed.json'

/** Type-only edges disappear from the browser build; every remaining first-party edge matters. */
function runtimeImports(source: string, filename: string): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const imports: string[] = []
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const named = clause?.namedBindings
      const onlyNamedTypes =
        named &&
        ts.isNamedImports(named) &&
        named.elements.length > 0 &&
        named.elements.every((element) => element.isTypeOnly)
      if (!clause?.isTypeOnly && !(onlyNamedTypes && !clause?.name)) {
        imports.push(node.moduleSpecifier.text)
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const onlyNamedTypes =
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element) => element.isTypeOnly)
      if (!node.isTypeOnly && !onlyNamedTypes) imports.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression
      imports.push(
        expression && ts.isStringLiteral(expression)
          ? expression.text
          : '<unresolved runtime import>',
      )
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0]
      imports.push(
        argument && ts.isStringLiteral(argument) ? argument.text : '<unresolved runtime import>',
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return imports
}

function resolveFirstParty(specifier: string, from: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null
  const base = specifier.startsWith('@/')
    ? path.resolve(root, specifier.slice(2))
    : path.resolve(path.dirname(from), specifier)
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.mjs', '.json'].map((suffix) => base + suffix),
    ...['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map((filename) =>
      path.join(base, filename),
    ),
  ]
  const resolved = candidates.find((candidate) => existsSync(candidate) && path.extname(candidate))
  if (!resolved)
    throw Error(`unresolved first-party browser edge: ${path.relative(root, from)} → ${specifier}`)
  return resolved
}

function browserRuntimeGraph() {
  const pending = entries.map((entry) => path.resolve(root, entry))
  const visited = new Set<string>()
  const edges: { from: string; specifier: string; to: string | null }[] = []
  while (pending.length) {
    const filename = pending.shift()!
    if (visited.has(filename)) continue
    visited.add(filename)
    if (filename.endsWith('.json')) continue
    for (const specifier of runtimeImports(readFileSync(filename, 'utf8'), filename)) {
      const to = resolveFirstParty(specifier, filename)
      edges.push({
        from: path.relative(root, filename),
        specifier,
        to: to && path.relative(root, to),
      })
      if (to) pending.push(to)
    }
  }
  return { files: [...visited].map((filename) => path.relative(root, filename)), edges }
}

describe('Morpho V2 browser evidence runtime boundary', () => {
  it('recognizes runtime edges while excluding all TypeScript type-only forms', () => {
    expect(
      runtimeImports(
        `
      import type { A } from 'node:fs';
      import { type B } from 'node:crypto';
      export type { C } from '@/lib/server/private';
      export { type D } from '@/scripts/research/private';
      type E = import('node:path').ParsedPath;
      import { type F, live } from './mixed';
      import './side-effect';
      export { value } from './exported';
      const dynamic = import('./dynamic');
      const common = require('./common');
    `,
        'synthetic.ts',
      ),
    ).toEqual(['./mixed', './side-effect', './exported', './dynamic', './common'])
  })

  it('keeps pins, native replay, codec and holder free of Node runtimes and raw research loaders', () => {
    const graph = browserRuntimeGraph()
    const forbiddenEdges = graph.edges.filter(
      ({ specifier, to }) =>
        specifier.startsWith('node:') ||
        builtins.has(specifier) ||
        specifier === '<unresolved runtime import>' ||
        Boolean(
          to &&
          (to.startsWith('lib/server/') ||
            (to.startsWith('scripts/') && to !== existingSubjectMetadata) ||
            /morphoV2(?:CurrentProtocolCapacityEvidence|PilotHistoricalEvidence|ProtocolCapacityHistory)\.(?:ts|tsx|js|mjs)$/.test(
              to,
            ) ||
            (/data\/research\/.*\.json$/.test(to) && !to.endsWith('.frame.json'))),
        ),
    )
    expect(forbiddenEdges).toEqual([])
    expect(graph.files).toContain(
      'data/research/venue-signals/morpho-v2-protocol-capacity-history-pilot-2026-10-07T15-32.frame.json',
    )
    expect(graph.edges.some(({ specifier }) => specifier === 'viem')).toBe(true)
    expect(graph.files.every((filename) => !filename.includes('node_modules'))).toBe(true)
  })
})
