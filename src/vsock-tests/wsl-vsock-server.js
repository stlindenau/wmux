#!/usr/bin/env node
// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/**
 * WSL2 VSOCK Server - Receive data from Windows via VSOCK
 *
 * This completes the end-to-end flow:
 * Windows Named Pipe → Bridge → AF_HYPERV → AF_VSOCK → WSL2 Server
 */

const fs = require('fs');

class VsockServer {
    constructor(options = {}) {
        this.port = options.port || 9787;
        this.vsock = null;
        this.server = null;
        this.clients = new Set();
    }

    async checkVsockSupport() {
        console.log('🔍 Checking VSOCK server support...');

        // Check WSL2
        try {
            const procVersion = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
            const isWSL2 = procVersion.includes('microsoft') && procVersion.includes('wsl2');

            if (!isWSL2) {
                throw new Error('Not running in WSL2');
            }
            console.log('✅ WSL2 environment detected');
        } catch (error) {
            console.log(`❌ WSL2 check failed: ${error.message}`);
            return false;
        }

        // Check /dev/vsock
        if (!fs.existsSync('/dev/vsock')) {
            console.log('❌ /dev/vsock device not found');
            return false;
        }
        console.log('✅ /dev/vsock device found');

        // Load node-vsock
        try {
            this.vsock = require('node-vsock');
            console.log('✅ node-vsock module loaded');
            return true;
        } catch (error) {
            console.log('❌ node-vsock not found - run: npm install node-vsock');
            return false;
        }
    }

    async startServer() {
        console.log('🚀 Starting VSOCK server for end-to-end demo');
        console.log('============================================');
        console.log('Architecture: Named Pipe → Bridge → AF_HYPERV → AF_VSOCK → WSL2');
        console.log();

        if (!await this.checkVsockSupport()) {
            process.exit(1);
        }

        try {
            // Create VSOCK server
            this.server = new this.vsock.VsockServer();

            console.log(`🔌 Starting VSOCK server on port ${this.port}...`);

            this.server.listen(this.port, () => {
                console.log(`✅ VSOCK server listening on port ${this.port}`);
                console.log('📡 Ready to receive data from Windows bridge');
                console.log();
                console.log('🧪 Test the complete flow:');
                console.log('   1. Start Windows bridge: wmux-hyperv-bridge-pure.exe');
                console.log('   2. Send via named pipe: pipe-test-client.ps1');
                console.log('   3. Watch data arrive here in WSL2');
                console.log();
                console.log('⏹  Press Ctrl+C to stop');
            });

            this.server.on('connection', (socket) => {
                const clientId = Math.random().toString(36).substring(7);
                this.clients.add(socket);

                console.log(`📞 VSOCK client connected: ${clientId}`);
                console.log(`   Active connections: ${this.clients.size}`);

                // Handle incoming data
                socket.on('data', (data) => {
                    const message = data.toString().trim();
                    const timestamp = new Date().toISOString();

                    console.log();
                    console.log(`📥 [${timestamp}] RECEIVED via VSOCK:`);
                    console.log(`   Client: ${clientId}`);
                    console.log(`   Data: ${message}`);

                    // Parse JSON if possible
                    try {
                        const parsed = JSON.parse(message);
                        console.log(`   Parsed JSON:`, parsed);
                    } catch {
                        // Not JSON, that's fine
                    }

                    // Echo back with WSL2 info
                    const response = {
                        type: 'vsock-response',
                        originalMessage: message,
                        receivedAt: timestamp,
                        receivedBy: 'WSL2-VSOCK-Server',
                        clientId: clientId,
                        status: 'end-to-end-success'
                    };

                    socket.write(JSON.stringify(response) + '\n');
                    console.log(`📤 Sent response back via VSOCK`);
                });

                socket.on('close', () => {
                    this.clients.delete(socket);
                    console.log(`📴 VSOCK client disconnected: ${clientId}`);
                    console.log(`   Active connections: ${this.clients.size}`);
                });

                socket.on('error', (error) => {
                    console.log(`❌ VSOCK client error ${clientId}: ${error.message}`);
                    this.clients.delete(socket);
                });

                // Send welcome message
                socket.write(JSON.stringify({
                    type: 'welcome',
                    message: 'Connected to WSL2 VSOCK server',
                    serverInfo: 'End-to-end bridge demo',
                    timestamp: new Date().toISOString()
                }) + '\n');
            });

            this.server.on('error', (error) => {
                console.log(`❌ VSOCK server error: ${error.message}`);
            });

            // Graceful shutdown
            process.on('SIGINT', () => {
                console.log('\n⏹  Shutting down VSOCK server...');
                this.cleanup();
                process.exit(0);
            });

            // Keep alive
            process.stdin.resume();

        } catch (error) {
            console.log(`❌ Failed to start VSOCK server: ${error.message}`);
            process.exit(1);
        }
    }

    cleanup() {
        if (this.server) {
            this.server.close();
            console.log('✅ VSOCK server stopped');
        }

        for (const client of this.clients) {
            client.end();
        }
        this.clients.clear();
    }

    // Statistics
    getStats() {
        return {
            activeConnections: this.clients.size,
            port: this.port,
            transport: 'AF_VSOCK'
        };
    }
}

async function main() {
    const server = new VsockServer();

    try {
        await server.startServer();
    } catch (error) {
        console.error(`❌ Server failed: ${error.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { VsockServer };