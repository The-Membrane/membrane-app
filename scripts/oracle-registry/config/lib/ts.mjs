// Load the TypeScript config engine (lib/oracleRegistry/config/*.ts) from a plain node script,
// with no build step: tsx's CJS + ESM hooks (node_modules/tsx). The repo package is not
// "type": "module", so tsx compiles the engine to CommonJS and the named exports arrive on
// `default` (measured on node 23.5 / tsx 4.21: tsImport alone fails on `import type`).

let registered = false

export async function loadTs(relativeToThisDir) {
  if (!registered) {
    const cjs = await import('tsx/cjs/api')
    cjs.register()
    const esm = await import('tsx/esm/api')
    esm.register()
    registered = true
  }
  const mod = await import(new URL(relativeToThisDir, import.meta.url).href)
  return mod.default ?? mod
}
