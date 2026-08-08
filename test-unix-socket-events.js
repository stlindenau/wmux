#!/usr/bin/env node
// Test that waits for actual 'listening' events

const net = require('net');
const fs = require('fs');
const { getUnixSocketPath, getPipePath } = require('./dist/shared/instance.js');
const { PipeServer } = require('./dist/main/pipe-server.js');

console.log('=== Unix Socket Event-Based Test ===\n');

const socketPath = getUnixSocketPath();
const pipePath = getPipePath();

console.log('Platform:', process.platform);
console.log('Named Pipe path:', pipePath);
console.log('Unix Socket path:', socketPath);
console.log();

const testToken = 'test-token-12345';
const pipeServer = new PipeServer(pipePath, testToken);

// Track which servers have started
let pipeListening = false;
let unixListening = false;
let testComplete = false;

// Monitor the actual server objects for events
function monitorServer(server, name) {
    if (!server) {
        console.log(`⚠️  ${name} is null!`);
        return;
    }

    server.on('listening', () => {
        console.log(`✅ ${name} 'listening' event fired`);
        const addr = server.address();
        console.log(`   Address:`, addr);

        if (name === 'pipeServer') pipeListening = true;
        if (name === 'unixServer') unixListening = true;

        checkComplete();
    });

    server.on('error', (err) => {
        console.error(`❌ ${name} error:`, err.message);
        console.error(`   Code:`, err.code);
        console.error(`   Full error:`, err);
    });
}

function checkComplete() {
    if (process.platform === 'win32') {
        // Windows: both should be listening
        if (pipeListening && unixListening && !testComplete) {
            testComplete = true;
            setTimeout(runTests, 100);
        }
    } else {
        // Linux: only unix socket
        if (unixListening && !testComplete) {
            testComplete = true;
            setTimeout(runTests, 100);
        }
    }
}

function runTests() {
    console.log('\n=== Running Tests ===\n');

    // Check socket file
    const exists = fs.existsSync(socketPath);
    console.log('Socket file exists:', exists);

    if (exists) {
        console.log('✅ Unix socket created successfully!');

        // Try to connect
        console.log('\nAttempting connection...');
        const client = net.connect({ path: socketPath }, () => {
            console.log('✅ Connected to Unix socket!');

            // Send ping
            client.write('ping\n');
            client.on('data', (data) => {
                console.log('✅ Received:', data.toString().trim());
                client.end();
                cleanup();
            });
        });

        client.on('error', (err) => {
            console.error('❌ Connection error:', err.message);
            cleanup();
        });
    } else {
        console.log('❌ Socket file not created');
        console.log('\nDiagnostics:');
        console.log('pipeServer._handle:', pipeServer.pipeServer?._handle);
        console.log('unixServer._handle:', pipeServer.unixServer?._handle);
        cleanup();
    }
}

function cleanup() {
    console.log('\nStopping server...');
    pipeServer.stop();
    console.log('Done.');
}

// Start the server
console.log('Starting PipeServer...\n');

try {
    pipeServer.start();

    // Wait a bit for server objects to be created
    setTimeout(() => {
        console.log('Monitoring server events...\n');
        monitorServer(pipeServer.pipeServer, 'pipeServer');
        monitorServer(pipeServer.unixServer, 'unixServer');
    }, 100);

} catch (err) {
    console.error('❌ Exception during start():', err);
    process.exit(1);
}

// Timeout after 5 seconds
setTimeout(() => {
    if (!testComplete) {
        console.error('\n❌ Timeout waiting for servers to start!');
        console.log('\nServer states:');
        console.log('pipeListening:', pipeListening);
        console.log('unixListening:', unixListening);
        console.log('\nServer handles:');
        console.log('pipeServer._handle:', pipeServer.pipeServer?._handle);
        console.log('unixServer._handle:', pipeServer.unixServer?._handle);
        cleanup();
        process.exit(1);
    }
}, 5000);
