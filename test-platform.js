#!/usr/bin/env node
// Test script to verify platform detection and path resolution

const { getPipePath, getUnixSocketPath, getAppDataDir } = require('./dist/shared/instance.js');

console.log('=== Platform Detection Test ===\n');
console.log('Platform:', process.platform);
console.log('Architecture:', process.arch);
console.log('Node version:', process.version);
console.log();

console.log('=== Path Resolution ===\n');
console.log('getPipePath():', getPipePath());
console.log('getUnixSocketPath():', getUnixSocketPath());
console.log('getAppDataDir():', getAppDataDir());
console.log();

console.log('=== Environment Variables ===\n');
console.log('WMUX_INSTANCE:', process.env.WMUX_INSTANCE || '(not set)');
console.log('XDG_RUNTIME_DIR:', process.env.XDG_RUNTIME_DIR || '(not set)');
console.log('XDG_CONFIG_HOME:', process.env.XDG_CONFIG_HOME || '(not set)');
console.log('TEMP:', process.env.TEMP || '(not set)');
console.log('APPDATA:', process.env.APPDATA || '(not set)');
console.log();

console.log('=== Path Analysis ===\n');
const unixSocketPath = getUnixSocketPath();
console.log('Unix socket path:', unixSocketPath);
console.log('  - Is absolute:', unixSocketPath.startsWith('/') || /^[A-Z]:\\/.test(unixSocketPath));
console.log('  - Contains .sock extension:', unixSocketPath.endsWith('.sock'));

if (process.platform === 'win32') {
    console.log('  - WSL accessible path:', unixSocketPath.replace(/^([A-Z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/'));
}
console.log();

console.log('=== Instance Suffix Test ===\n');
const originalInstance = process.env.WMUX_INSTANCE;
process.env.WMUX_INSTANCE = 'test';
console.log('With WMUX_INSTANCE=test:');
console.log('  getPipePath():', getPipePath());
console.log('  getUnixSocketPath():', getUnixSocketPath());
console.log('  getAppDataDir():', getAppDataDir());
if (originalInstance !== undefined) {
    process.env.WMUX_INSTANCE = originalInstance;
} else {
    delete process.env.WMUX_INSTANCE;
}
console.log();

console.log('✅ Platform detection test complete!');
