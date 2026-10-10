// Root: --max-old-space-size=384, external 90s job cap, 288 MiB runtime preflight.
// No watch, services or environment loading.
module.exports = {
  root: '/Users/EBmic/membrane-app', envFile: false,
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': '/Users/EBmic/membrane-app' } },
  server: { watch: null, hmr: false, fs: { allow: ['/Users/EBmic/membrane-app', '/private/tmp'] } },
  test: {
    include: ['scripts/research/link-holder-stage-v2-default-live-oct10.test.tsx'],
    environment: 'node', pool: 'threads', fileParallelism: false, maxWorkers: 1,
    watch: false, testTimeout: 90000, hookTimeout: 90000, reporters: ['default'],
  },
}
