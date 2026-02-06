// #region agent log
const fs = require('fs');
const path = require('path');

const logPath = '/Users/EBmic/membrane-core/.cursor/debug.log';
const log = (data) => {
    try {
        fs.appendFileSync(logPath, JSON.stringify({ ...data, timestamp: Date.now() }) + '\n');
    } catch (e) { }
};

// Hypothesis A: vendor-chunks directory is empty or missing expected files
const vendorChunksPath = path.join(__dirname, '.next/server/vendor-chunks');
log({
    sessionId: 'debug-session',
    runId: 'run1',
    hypothesisId: 'A',
    location: 'debug-build.js:vendor-chunks-check',
    message: 'Checking vendor-chunks directory',
    data: {
        path: vendorChunksPath,
        exists: fs.existsSync(vendorChunksPath),
        files: fs.existsSync(vendorChunksPath) ? fs.readdirSync(vendorChunksPath) : []
    }
});

// Hypothesis B: webpack-runtime.js is looking for a chunk that doesn't exist
const webpackRuntimePath = path.join(__dirname, '.next/server/webpack-runtime.js');
log({
    sessionId: 'debug-session',
    runId: 'run1',
    hypothesisId: 'B',
    location: 'debug-build.js:webpack-runtime-check',
    message: 'Checking webpack-runtime.js',
    data: {
        path: webpackRuntimePath,
        exists: fs.existsSync(webpackRuntimePath),
        size: fs.existsSync(webpackRuntimePath) ? fs.statSync(webpackRuntimePath).size : 0
    }
});

// Hypothesis C: chunks directory exists but missing specific file
const chunksPath = path.join(__dirname, '.next/server/chunks');
log({
    sessionId: 'debug-session',
    runId: 'run1',
    hypothesisId: 'C',
    location: 'debug-build.js:chunks-check',
    message: 'Checking chunks directory',
    data: {
        path: chunksPath,
        exists: fs.existsSync(chunksPath),
        fileCount: fs.existsSync(chunksPath) ? fs.readdirSync(chunksPath).length : 0,
        sampleFiles: fs.existsSync(chunksPath) ? fs.readdirSync(chunksPath).slice(0, 5) : []
    }
});

// Hypothesis D: .next build is incomplete or corrupted
const nextPath = path.join(__dirname, '.next');
log({
    sessionId: 'debug-session',
    runId: 'run1',
    hypothesisId: 'D',
    location: 'debug-build.js:next-dir-check',
    message: 'Checking .next directory structure',
    data: {
        path: nextPath,
        exists: fs.existsSync(nextPath),
        hasServer: fs.existsSync(path.join(nextPath, 'server')),
        hasChunks: fs.existsSync(path.join(nextPath, 'server/chunks')),
        hasVendorChunks: fs.existsSync(path.join(nextPath, 'server/vendor-chunks'))
    }
});

// Hypothesis E: Expected chunk file name pattern
const expectedChunkName = 'next@14.1.0_@babel+core@7.25.8_babel-plugin-macros@3.1.0_react-dom@18.3.1_react@18.3.1__react@18.3.1.js';
log({
    sessionId: 'debug-session',
    runId: 'run1',
    hypothesisId: 'E',
    location: 'debug-build.js:expected-chunk-check',
    message: 'Checking for expected chunk file',
    data: {
        expectedName: expectedChunkName,
        vendorChunksPath: vendorChunksPath,
        fileExists: fs.existsSync(path.join(vendorChunksPath, expectedChunkName)),
        allVendorFiles: fs.existsSync(vendorChunksPath) ? fs.readdirSync(vendorChunksPath) : []
    }
});

// Post-fix verification: Check if vendor-chunks has files after rebuild
log({
    sessionId: 'debug-session',
    runId: 'post-fix',
    hypothesisId: 'FIX',
    location: 'debug-build.js:post-fix-verification',
    message: 'Post-fix verification: vendor-chunks after rebuild',
    data: {
        vendorChunksExists: fs.existsSync(vendorChunksPath),
        vendorChunksFileCount: fs.existsSync(vendorChunksPath) ? fs.readdirSync(vendorChunksPath).length : 0,
        vendorChunksFiles: fs.existsSync(vendorChunksPath) ? fs.readdirSync(vendorChunksPath) : [],
        expectedFileExists: fs.existsSync(path.join(vendorChunksPath, expectedChunkName))
    }
});

console.log('Debug check complete. See logs at:', logPath);
// #endregion

