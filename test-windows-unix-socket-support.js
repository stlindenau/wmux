#!/usr/bin/env node
// Test if Windows supports Unix sockets at all

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

console.log('=== Windows Unix Socket Support Test ===\n');

console.log('System Information:');
console.log('  Platform:', process.platform);
console.log('  Node.js:', process.version);
console.log('  OS:', os.type(), os.release());
console.log('  Windows Version:', os.version());
console.log();

if (process.platform !== 'win32') {
    console.log('⚠️  This test is for Windows only');
    process.exit(0);
}

// Try different socket locations
const testPaths = [
    path.join(process.env.USERPROFILE, 'test-unix.sock'),
    path.join(process.env.APPDATA, 'test-unix.sock'),
    path.join(process.env.TEMP, 'test-unix.sock'),
    path.join(os.tmpdir(), 'test-unix.sock'),
];

console.log('Testing Unix socket creation in different locations:\n');

let successCount = 0;
let testIndex = 0;

function testNextPath() {
    if (testIndex >= testPaths.length) {
        console.log('\n=== Summary ===');
        console.log(`Successful: ${successCount}/${testPaths.length}`);

        if (successCount === 0) {
            console.log('\n❌ Unix sockets are NOT supported on this system');
            console.log('\nPossible reasons:');
            console.log('  1. Windows version too old (need build 17063+)');
            console.log('  2. Corporate security policy blocking Unix sockets');
            console.log('  3. Feature disabled in Windows');
            console.log('\nRun these commands to check:');
            console.log('  [System.Environment]::OSVersion.Version');
            console.log('  Get-WindowsOptionalFeature -Online | Where-Object {$_.FeatureName -like "*WSL*"}');
        } else {
            console.log('\n✅ Unix sockets ARE supported on this system!');
            console.log('The issue is specific to the chosen socket path.');
        }
        return;
    }

    const socketPath = testPaths[testIndex];
    console.log(`Test ${testIndex + 1}: ${socketPath}`);

    const server = net.createServer();

    server.on('error', (err) => {
        console.log(`  ❌ Error: ${err.code} - ${err.message}`);
        testIndex++;
        testNextPath();
    });

    server.listen(socketPath, () => {
        console.log('  ✅ Socket created successfully!');
        successCount++;
        server.close();

        // Clean up
        try {
            fs.unlinkSync(socketPath);
            console.log('  ✅ Socket cleaned up');
        } catch (e) {
            console.log('  ⚠️  Could not clean up socket file');
        }

        testIndex++;
        testNextPath();
    });
}

testNextPath();
