#!/usr/bin/env node
// Windows-specific platform detection test
// Run this on Windows to verify dual-listen functionality

const { getPipePath, getUnixSocketPath, getAppDataDir } = require('./dist/shared/instance.js');

console.log('=== Windows Platform Detection Test ===\n');
console.log('Platform:', process.platform);
console.log('Architecture:', process.arch);
console.log('Node version:', process.version);
console.log();

if (process.platform !== 'win32') {
    console.log('⚠️  This script is designed for Windows!');
    console.log('Current platform:', process.platform);
    console.log('\nFor this platform, use: node test-platform.js\n');
    process.exit(0);
}

console.log('=== Path Resolution ===\n');
const pipePath = getPipePath();
const unixPath = getUnixSocketPath();
const appDataDir = getAppDataDir();

console.log('getPipePath():', pipePath);
console.log('  - Type: Named Pipe');
console.log('  - Format:', pipePath.startsWith('\\\\.\\pipe\\') ? '✅ Valid' : '❌ Invalid');
console.log();

console.log('getUnixSocketPath():', unixPath);
console.log('  - Type: Unix Socket (for WSL)');
console.log('  - Is Windows path:', /^[A-Z]:\\/.test(unixPath) ? '✅ Yes' : '❌ No');
console.log('  - Contains .sock extension:', unixPath.endsWith('.sock') ? '✅ Yes' : '❌ No');
console.log('  - In TEMP directory:', unixPath.includes('\\Temp\\') ? '✅ Yes' : '❌ No');
console.log();

console.log('getAppDataDir():', appDataDir);
console.log('  - In APPDATA:', appDataDir.includes('AppData\\Roaming') ? '✅ Yes' : '❌ No');
console.log();

console.log('=== WSL Path Translation ===\n');
// Convert Windows path to WSL format
const wslPath = unixPath.replace(/^([A-Z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`)
                       .replace(/\\/g, '/');
console.log('Windows path:', unixPath);
console.log('WSL path:    ', wslPath);
console.log();

console.log('From WSL, you can connect using:');
console.log(`  export WMUX_UNIX_SOCKET="${wslPath}"`);
console.log('  wmux list-workspaces');
console.log();

console.log('=== Environment Variables (Windows) ===\n');
console.log('TEMP:', process.env.TEMP || '(not set)');
console.log('APPDATA:', process.env.APPDATA || '(not set)');
console.log('USERPROFILE:', process.env.USERPROFILE || '(not set)');
console.log('WMUX_INSTANCE:', process.env.WMUX_INSTANCE || '(not set)');
console.log();

console.log('=== Instance Suffix Test ===\n');
const originalInstance = process.env.WMUX_INSTANCE;
process.env.WMUX_INSTANCE = 'test';
console.log('With WMUX_INSTANCE=test:');
console.log('  Named Pipe:', getPipePath());
console.log('  Unix Socket:', getUnixSocketPath());
console.log('  AppData:', getAppDataDir());
if (originalInstance !== undefined) {
    process.env.WMUX_INSTANCE = originalInstance;
} else {
    delete process.env.WMUX_INSTANCE;
}
console.log();

console.log('=== Expected wmux Behavior on Windows ===\n');
console.log('1. wmux will listen on BOTH:');
console.log(`   - Named Pipe: ${pipePath}`);
console.log(`   - Unix Socket: ${unixPath}`);
console.log();
console.log('2. Local Windows shells connect via: Named Pipe');
console.log('3. WSL bridge connects via: Unix Socket');
console.log('4. Environment variables exported:');
console.log('   - WMUX_PIPE (for local shells)');
console.log('   - WMUX_UNIX_SOCKET (for WSL)');
console.log('   - WMUX_PIPE_TOKEN (authentication)');
console.log();

console.log('=== Manual Testing Steps ===\n');
console.log('1. Start wmux on Windows');
console.log('   - Should see log: "Listening on named pipe: ..."');
console.log('   - Should see log: "Listening on Unix socket: ..."');
console.log('   - Should see log: "WSL can access this socket via ..."');
console.log();
console.log('2. From a Windows PowerShell/CMD in wmux:');
console.log('   - Echo %WMUX_PIPE% (should show named pipe path)');
console.log('   - Echo %WMUX_UNIX_SOCKET% (should show Unix socket path)');
console.log('   - wmux list-workspaces (should work via named pipe)');
console.log();
console.log('3. From WSL:');
console.log(`   - export WMUX_UNIX_SOCKET="${wslPath}"`);
console.log('   - export WMUX_PIPE_TOKEN=$(cat /mnt/c/Users/.../AppData/Roaming/wmux/pipe-token)');
console.log('   - wmux list-workspaces (should work via Unix socket)');
console.log('   - wmux bridge --port 9787 (start bridge for devcontainer)');
console.log();
console.log('4. From devcontainer:');
console.log('   - export WMUX_REMOTE=host.docker.internal:9787');
console.log('   - export WMUX_REMOTE_TOKEN=<token-from-windows>');
console.log('   - wmux list-workspaces (should work via TCP bridge)');
console.log();

console.log('✅ Windows platform detection test complete!');
console.log('\nNext step: Build wmux and run it on Windows to verify dual-listen.\n');
