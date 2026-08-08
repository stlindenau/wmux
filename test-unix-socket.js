#!/usr/bin/env node
// Integration test for Unix socket functionality

const net = require('net');
const fs = require('fs');
const path = require('path');
const { getUnixSocketPath, getPipePath } = require('./dist/shared/instance.js');
const { PipeServer } = require('./dist/main/pipe-server.js');

console.log('=== Unix Socket Integration Test ===\n');

const socketPath = getUnixSocketPath();
const pipePath = getPipePath();

console.log('Platform:', process.platform);
console.log('Named Pipe path:', pipePath);
console.log('Unix Socket path:', socketPath);
console.log();

// Test 1: Socket creation
console.log('Test 1: Creating Unix socket server...');
const testToken = 'test-token-12345';

// IMPORTANT: On Windows, PipeServer constructor expects a named pipe path
// It will automatically create BOTH named pipe AND Unix socket
// On Linux, pipePath IS the Unix socket path
const pipeServer = new PipeServer(pipePath, testToken);

let testsPassed = 0;
let testsFailed = 0;

// Give the server time to start
setTimeout(() => {
    pipeServer.start();

    setTimeout(() => {
        // Check if socket file exists
        console.log('  Checking socket file existence...');
        if (fs.existsSync(socketPath)) {
            console.log('  ✅ Socket file created at:', socketPath);
            testsPassed++;

            // Check permissions on Linux
            if (process.platform !== 'win32') {
                const stats = fs.statSync(socketPath);
                const mode = (stats.mode & parseInt('777', 8)).toString(8);
                console.log('  Socket permissions:', mode);
                if (mode === '600') {
                    console.log('  ✅ Socket has correct permissions (600)');
                    testsPassed++;
                } else {
                    console.log('  ⚠️  Socket permissions are', mode, '(expected 600)');
                    testsFailed++;
                }
            }
        } else {
            console.log('  ❌ Socket file not created');
            testsFailed++;
        }
        console.log();

        // Test 2: Connection
        console.log('Test 2: Connecting to Unix socket...');
        const client = net.connect({ path: socketPath }, () => {
            console.log('  ✅ Successfully connected to Unix socket');
            testsPassed++;

            // Test 3: Send V1 ping
            console.log('\nTest 3: Sending V1 ping command...');
            client.write('ping\n');

            let responseData = '';
            client.on('data', (data) => {
                responseData += data.toString();

                if (responseData.includes('pong')) {
                    console.log('  ✅ Received pong response');
                    testsPassed++;
                    client.end();
                }
            });

            client.on('end', () => {
                console.log('  Connection closed\n');

                // Test 4: V2 system.identify
                console.log('Test 4: Sending V2 system.identify...');
                const client2 = net.connect({ path: socketPath }, () => {
                    const request = JSON.stringify({
                        method: 'system.identify',
                        params: {},
                        id: 1
                    });
                    client2.write(request + '\n');

                    let v2Response = '';
                    client2.on('data', (data) => {
                        v2Response += data.toString();

                        if (v2Response.includes('\n')) {
                            try {
                                const parsed = JSON.parse(v2Response.trim());
                                console.log('  ✅ Received V2 response:', JSON.stringify(parsed, null, 2));
                                testsPassed++;
                            } catch (e) {
                                console.log('  ❌ Failed to parse V2 response:', e.message);
                                testsFailed++;
                            }
                            client2.end();
                        }
                    });

                    client2.on('end', () => {
                        // Cleanup
                        console.log('\nTest 5: Server cleanup...');
                        pipeServer.stop();

                        setTimeout(() => {
                            // On Windows, cleanup is not expected (socket files persist)
                            // On Linux, socket file should be removed
                            if (process.platform === 'win32') {
                                console.log('  ⚠️  Socket cleanup skipped on Windows (files persist)');
                                console.log('  Note: Windows doesn\'t auto-remove socket files');
                                testsPassed++;
                            } else {
                                if (!fs.existsSync(socketPath)) {
                                    console.log('  ✅ Socket file removed after stop');
                                    testsPassed++;
                                } else {
                                    console.log('  ❌ Socket file still exists after stop');
                                    testsFailed++;
                                    // Clean up manually
                                    try { fs.unlinkSync(socketPath); } catch {}
                                }
                            }

                            printSummary();
                        }, 100);
                    });
                });

                client2.on('error', (err) => {
                    console.log('  ❌ V2 connection error:', err.message);
                    testsFailed++;
                    pipeServer.stop();
                    printSummary();
                });
            });
        });

        client.on('error', (err) => {
            console.log('  ❌ Connection failed:', err.message);
            testsFailed++;
            pipeServer.stop();
            printSummary();
        });

    }, 100); // Give server time to bind

}, 10);

function printSummary() {
    console.log('\n=== Test Summary ===');
    console.log(`Passed: ${testsPassed}`);
    console.log(`Failed: ${testsFailed}`);
    console.log(testsFailed === 0 ? '\n✅ All integration tests passed!' : '\n❌ Some tests failed!');
    process.exit(testsFailed > 0 ? 1 : 0);
}

// Timeout safety
setTimeout(() => {
    console.log('\n❌ Test timeout!');
    pipeServer.stop();
    if (process.platform !== 'win32') {
        try { fs.unlinkSync(socketPath); } catch {}
    }
    process.exit(1);
}, 5000);
