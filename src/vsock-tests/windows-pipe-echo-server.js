// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/**
 * Minimal Windows named pipe echo server for relay testing.
 * Creates \\.\pipe\wmux-test and echoes every message back.
 *
 * Usage (Windows):  node windows-pipe-echo-server.js [pipe-name]
 */
'use strict';

const net = require('net');

const pipeName = process.argv[2] || 'wmux-test';
const pipePath = '\\\\.\\pipe\\' + pipeName;

const server = net.createServer((conn) => {
  const id = Math.random().toString(36).slice(2, 8);
  console.log('[' + new Date().toISOString() + '] [' + id + '] client connected');
  conn.on('data', (buf) => {
    const msg = buf.toString().trimEnd();
    console.log('[' + id + '] RECV: ' + msg);
    const reply = '[ECHO] ' + msg + '\n';
    conn.write(reply);
    console.log('[' + id + '] SENT: ' + reply.trimEnd());
  });
  conn.on('end', () => console.log('[' + id + '] client disconnected'));
  conn.on('error', (err) => console.log('[' + id + '] error: ' + err.message));
});

server.listen(pipePath, () => {
  console.log('Windows named pipe echo server');
  console.log('  pipe : ' + pipePath);
  console.log('');
  console.log('Test from WSL2:');
  console.log('  bash wsl-npiperelay-setup.sh --pipe-name ' + pipeName + ' --socket /tmp/' + pipeName + '.sock');
  console.log('  echo "hello pipe" | socat - UNIX-CONNECT:/tmp/' + pipeName + '.sock');
  console.log('');
  console.log('Ctrl+C to stop.');
});

server.on('error', (err) => {
  console.error('Server error: ' + err.message);
  process.exit(1);
});
