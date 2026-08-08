#!/usr/bin/env node
// Debug version of Unix socket test with detailed logging

const net = require('net');
const fs = require('fs');
const { getUnixSocketPath, getPipePath } = require('./dist/shared/instance.js');
const { PipeServer } = require('./dist/main/pipe-server.js');

console.log('=== Unix Socket Debug Test ===\n');

const socketPath = getUnixSocketPath();
const pipePath = getPipePath();

console.log('Platform:', process.platform);
console.log('Named Pipe path:', pipePath);
console.log('Unix Socket path:', socketPath);
console.log();

// Test 1: Create server with error handling
console.log('Creating PipeServer...');
const testToken = 'test-token-12345';
const pipeServer = new PipeServer(pipePath, testToken);

// Add error event listener
pipeServer.on('error', (err) => {
    console.error('❌ PipeServer error:', err);
});

console.log('PipeServer created. Calling start()...');

try {
    pipeServer.start();
    console.log('start() called successfully');
} catch (err) {
    console.error('❌ start() threw error:', err);
    process.exit(1);
}

// Wait and check
setTimeout(() => {
    console.log('\n=== After 500ms ===');
    console.log('Checking socket file existence...');

    const exists = fs.existsSync(socketPath);
    console.log('Socket file exists:', exists);

    if (exists) {
        const stats = fs.statSync(socketPath);
        console.log('Socket file stats:');
        console.log('  - Size:', stats.size);
        console.log('  - Mode:', stats.mode.toString(8));
        console.log('  - Is socket:', stats.isSocket());
        console.log('  - Is file:', stats.isFile());
    } else {
        console.log('Socket file does not exist at:', socketPath);

        // Check if directory exists
        const dir = require('path').dirname(socketPath);
        console.log('\nChecking parent directory:', dir);
        console.log('Directory exists:', fs.existsSync(dir));

        if (fs.existsSync(dir)) {
            console.log('Directory contents:');
            fs.readdirSync(dir).filter(f => f.includes('wmux')).forEach(f => {
                console.log('  -', f);
            });
        }
    }

    // Try to inspect the server object
    console.log('\n=== Server Object Inspection ===');
    console.log('pipeServer.pipeServer:', pipeServer.pipeServer);
    console.log('pipeServer.unixServer:', pipeServer.unixServer);

    pipeServer.stop();
    console.log('\nServer stopped.');

}, 500);
