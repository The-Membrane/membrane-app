/** REVIEW PREPARATION ONLY: parse compiler roots/AST; never starts tsc, a build or a server.
 * Must itself receive a separately sealed finite launcher spec before execution. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
const [snapshotArg, outputArg] = process.argv.slice(2)
if (process.argv.length !== 4 || !snapshotArg || !outputArg) throw Error('explicit_snapshot_and_new_output_required')
const snapshot = path.resolve(snapshotArg), output = path.resolve(outputArg)
if (fs.existsSync(output) || output === snapshot || output.startsWith(snapshot + path.sep)) throw Error('new_external_review_output_required')
const require = createRequire(path.join(snapshot, 'package.json')), ts = require('typescript')
const configPath = path.join(snapshot, 'tsconfig.json')
const loaded = ts.readConfigFile(configPath, ts.sys.readFile)
if (loaded.error) throw Error('compiler_config_read_error')
const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, snapshot, undefined, configPath)
if (parsed.errors.length) throw Error('compiler_config_parse_errors')
const roots = [...new Set(parsed.fileNames.map(p => path.resolve(p)))].sort()
if (!roots.length || roots.some(p => !p.startsWith(snapshot + path.sep))) throw Error('unexpected_root_boundary')
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const globals = [], reasons = {}
for (const file of roots) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), parsed.options.target ?? ts.ScriptTarget.ES2020, true)
  if (source.parseDiagnostics.length) throw Error('root_parse_error:' + path.relative(snapshot, file))
  const why = []
  if (!ts.isExternalModule(source)) why.push('global_script_root')
  if (source.isDeclarationFile) why.push('declaration_root_conservatively_shared')
  function visit(node) {
    if (ts.isModuleDeclaration(node) && (ts.isStringLiteral(node.name) || (node.flags & ts.NodeFlags.GlobalAugmentation)))
      why.push('ambient_module_or_global_augmentation')
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (why.length) {globals.push(file); reasons[path.relative(snapshot, file)] = [...new Set(why)]}
}
const shared = new Set(globals), ordinary = roots.filter(p => !shared.has(p))
// Every source root occurs in at least one partition; shared ambient roots occur in all.
// Normal imports are deliberately untouched and may pull the entire expensive graph back in.
const partitions = []
for (let offset = 0; offset < ordinary.length; offset += 16) partitions.push(ordinary.slice(offset, offset + 16))
if (!partitions.length) partitions.push([])
const covered = new Set(partitions.flat().concat(globals))
if (covered.size !== roots.length || roots.some(p => !covered.has(p))) throw Error('source_root_union_incomplete')
fs.mkdirSync(output, {recursive: true, mode: 0o700})
const records = []
for (let i = 0; i < partitions.length; i++) {
  const name = `partition-${String(i + 1).padStart(3, '0')}.json`, file = path.join(output, name)
  const config = {extends: configPath, files: [...globals, ...partitions[i]], include: []}
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', {mode: 0o400})
  records.push({config: file, sha256: digest(file), ownedRoots: partitions[i].map(p => path.relative(snapshot, p)),
    sharedRootCount: globals.length,
    compilerArguments: ['--project', file, '--noEmit', '--incremental', 'false', '--pretty', 'false']})
}
const manifest = {schema: 'full_app_exhaustive_typecheck_partition_review_v1', reviewStatus: 'PENDING_PARENT_REVIEW',
  snapshot, compilerVersion: ts.version, configPath, configSha256: digest(configPath),
  rootCount: roots.length, roots: Object.fromEntries(roots.map(p => [path.relative(snapshot, p), digest(p)])),
  sharedAmbientRoots: reasons, partitions: records, rootUnionComplete: true,
  compilerOptionsUnchanged: true, ordinaryModuleImportsUnchanged: true, suppressionsAdded: false,
  inheritedAllowJsAndResolveJsonModuleUnchanged: true, runtimeAcceptance: 'NOT_EXECUTED',
  limits: {nodeOldSpaceMiB: 2304, sampledAggregateRssMiB: 4096, oneExclusiveJob: true},
  limitations: ['A single root may still exceed the unchanged budget through its ordinary import graph.',
    'All partitions must pass with source/dependency seals and cleanup proofs before the union can count as full-app type acceptance.',
    'This does not replace production build, HTTP or browser acceptance. Any changed execution plan requires parent review.']}
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {mode: 0o400})
console.log(JSON.stringify({status: 'PREPARED_NOT_EXECUTED_PENDING_REVIEW', manifest: path.join(output, 'manifest.json'),
  rootCount: roots.length, partitionCount: records.length}))
