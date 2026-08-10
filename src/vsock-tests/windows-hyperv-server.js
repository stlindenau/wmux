#!/usr/bin/env node
// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/**
 * Windows AF_HYPERV VSOCK Server for wmux bridge
 *
 * This server demonstrates AF_HYPERV socket communication that could
 * replace the current TCP-based wmux bridge for better security.
 *
 * Usage: node windows-hyperv-server.js
 */

const net = require('net');
const { randomUUID } = require('crypto');

// AF_HYPERV constants (Windows Hyper-V sockets)
const AF_HYPERV = 34; // Windows socket family for Hyper-V
const VMADDR_CID_ANY = -1;  // Listen on any VM
const VMADDR_CID_HOST = 2;  // Host VM ID

// wmux bridge service GUID - needs to be registered in Windows registry
const WMUX_SERVICE_GUID = '3049197C-FACB-11E6-BD58-64006A7986D3';

class HypervWmuxServer {
    constructor(serviceGuid = WMUX_SERVICE_GUID) {
        this.serviceGuid = serviceGuid;
        this.server = null;
        this.clients = new Map();
    }

    async checkHypervSupport() {
        console.log('🔍 Checking AF_HYPERV support...');

        try {
            // Check if we're running on Windows with Hyper-V
            const os = require('os');
            if (os.platform() !== 'win32') {
                throw new Error('AF_HYPERV only available on Windows');
            }

            // Check for Hyper-V features
            const { execSync } = require('child_process');
            const hypervFeatures = execSync('dism /online /get-featureinfo /featurename:Microsoft-Hyper-V',
                { encoding: 'utf8', stdio: 'pipe' }).toString();

            if (!hypervFeatures.includes('State : Enabled')) {
                console.log('⚠️  Hyper-V not enabled - AF_HYPERV unavailable');
                return false;
            }

            console.log('✅ Windows + Hyper-V detected');
            return true;
        } catch (error) {
            console.log(`❌ AF_HYPERV check failed: ${error.message}`);
            return false;
        }
    }

    async registerServiceGuid() {
        console.log('📝 Registering service GUID in Windows registry...');

        try {
            const { execSync } = require('child_process');

            // AF_HYPERV requires service registration in registry
            const regKey = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Virtualization\\GuestCommunicationServices\\${this.serviceGuid}`;

            // Check if already registered
            try {
                execSync(`reg query "${regKey}"`, { stdio: 'pipe' });
                console.log('✅ Service GUID already registered');
                return true;
            } catch {
                // Not registered, need to add it
            }

            // Register the service
            execSync(`reg add "${regKey}" /v ElementName /d "wmux Bridge Service" /f`, { stdio: 'pipe' });
            console.log('✅ Service GUID registered successfully');
            console.log(`   GUID: ${this.serviceGuid}`);
            console.log(`   Registry: ${regKey}`);

            return true;
        } catch (error) {
            console.error(`❌ Failed to register service GUID: ${error.message}`);
            console.error('   Run as Administrator to register AF_HYPERV services');
            return false;
        }
    }

    async createHypervSocket() {
        console.log('🔌 Attempting AF_HYPERV socket creation...');

        try {
            // Note: Node.js doesn't have built-in AF_HYPERV support
            // This is a conceptual implementation - would need native module

            console.log('⚠️  Native AF_HYPERV not yet implemented in Node.js');
            console.log('   Would need native addon or .NET bridge');
            console.log('   Falling back to TCP simulation...');

            return this.createTcpFallback();
        } catch (error) {
            console.error(`❌ AF_HYPERV socket creation failed: ${error.message}`);
            throw error;
        }
    }

    createTcpFallback() {
        console.log('🔄 Creating TCP fallback server (simulating AF_HYPERV)...');

        const server = net.createServer((socket) => {
            const clientId = randomUUID();
            this.clients.set(clientId, socket);

            console.log(`📞 Client connected: ${clientId}`);
            console.log(`   Remote: ${socket.remoteAddress}:${socket.remotePort}`);

            // Send welcome message
            const welcome = {
                type: 'welcome',
                serverId: 'wmux-hyperv-bridge',
                version: '1.0.0',
                transport: 'tcp-fallback', // Would be 'hyperv' in real implementation
                timestamp: new Date().toISOString()
            };
            socket.write(JSON.stringify(welcome) + '\n');

            socket.on('data', (data) => {
                try {
                    const message = data.toString().trim();
                    console.log(`📨 Received from ${clientId}: ${message}`);

                    // Echo back with processing info
                    const response = {
                        type: 'response',
                        original: message,
                        processed: true,
                        timestamp: new Date().toISOString()
                    };
                    socket.write(JSON.stringify(response) + '\n');
                } catch (error) {
                    console.error(`❌ Error processing data: ${error.message}`);
                }
            });

            socket.on('close', () => {
                console.log(`📴 Client disconnected: ${clientId}`);
                this.clients.delete(clientId);
            });

            socket.on('error', (error) => {
                console.error(`❌ Socket error for ${clientId}: ${error.message}`);
                this.clients.delete(clientId);
            });
        });

        return server;
    }

    async start() {
        console.log('🚀 Starting wmux AF_HYPERV bridge server...\n');

        // Check prerequisites
        const hasHyperv = await this.checkHypervSupport();
        if (!hasHyperv) {
            console.log('⚠️  Continuing with limited functionality...\n');
        }

        const guidRegistered = await this.registerServiceGuid();
        if (!guidRegistered) {
            console.log('⚠️  Service GUID registration failed - connections may be blocked\n');
        }

        // Create server
        this.server = await this.createHypervSocket();

        // Start listening
        const port = 9787; // Same as current wmux bridge
        this.server.listen(port, '127.0.0.1', () => {
            console.log(`✅ wmux bridge server listening on 127.0.0.1:${port}`);
            console.log('📋 Connection info:');
            console.log(`   Service GUID: ${this.serviceGuid}`);
            console.log(`   Transport: TCP (AF_HYPERV simulation)`);
            console.log('\n🧪 Test from WSL/container:');
            console.log(`   echo "test message" | nc 127.0.0.1 ${port}`);
            console.log(`   # or use the wsl-vsock-client.js script`);
            console.log('\n⏹  Press Ctrl+C to stop');
        });

        this.server.on('error', (error) => {
            console.error(`❌ Server error: ${error.message}`);
            if (error.code === 'EADDRINUSE') {
                console.error('   Port already in use - is wmux bridge already running?');
            }
        });

        // Graceful shutdown
        process.on('SIGINT', () => {
            console.log('\n⏹  Shutting down server...');
            this.server.close(() => {
                console.log('✅ Server stopped');
                process.exit(0);
            });
        });
    }

    async stop() {
        if (this.server) {
            this.server.close();
            this.clients.clear();
        }
    }

    getStats() {
        return {
            activeClients: this.clients.size,
            serviceGuid: this.serviceGuid,
            uptime: process.uptime()
        };
    }
}

// CLI interface
if (require.main === module) {
    const server = new HypervWmuxServer();
    server.start().catch(error => {
        console.error(`❌ Failed to start server: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { HypervWmuxServer };