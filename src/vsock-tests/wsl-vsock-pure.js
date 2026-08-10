#!/usr/bin/env node
// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/**
 * Pure VSOCK Client - No TCP fallback
 * Requires: npm install node-vsock
 */

const fs = require('fs');

class PureVsockClient {
    constructor(options = {}) {
        this.hostCid = options.hostCid || 2; // Windows host
        this.port = options.port || 9787;
        this.vsock = null;
        this.socket = null;
    }

    async checkVsockSupport() {
        console.log('🔍 Checking pure VSOCK support...');

        // Check if we're in WSL2
        try {
            const procVersion = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
            const isWSL2 = procVersion.includes('microsoft') && procVersion.includes('wsl2');

            if (!isWSL2) {
                throw new Error('Not running in WSL2 - VSOCK requires WSL2');
            }
            console.log('✅ WSL2 environment detected');
        } catch (error) {
            console.log(`❌ WSL2 check failed: ${error.message}`);
            return false;
        }

        // Check /dev/vsock
        if (!fs.existsSync('/dev/vsock')) {
            console.log('❌ /dev/vsock device not found');
            console.log('   Try: sudo modprobe vsock');
            return false;
        }
        console.log('✅ /dev/vsock device found');

        // Try to load node-vsock
        try {
            this.vsock = require('node-vsock');
            console.log('✅ node-vsock module loaded');
            return true;
        } catch (error) {
            console.log('❌ node-vsock module not found');
            console.log('   Install with: npm install node-vsock');
            console.log(`   Error: ${error.message}`);
            return false;
        }
    }

    async connectVsock() {
        console.log(`🔌 Connecting to Windows host via VSOCK CID ${this.hostCid}:${this.port}...`);

        if (!this.vsock) {
            throw new Error('VSOCK module not loaded');
        }

        try {
            // Create VSOCK socket
            this.socket = new this.vsock.VsockSocket();

            console.log('📡 VSOCK socket created');

            // Connect to Windows host
            await new Promise((resolve, reject) => {
                this.socket.connect(this.hostCid, this.port, (error) => {
                    if (error) {
                        reject(new Error(`VSOCK connection failed: ${error.message}`));
                    } else {
                        console.log('✅ VSOCK connection established');
                        resolve();
                    }
                });
            });

            return true;

        } catch (error) {
            console.log(`❌ VSOCK connection failed: ${error.message}`);

            // Common error explanations
            if (error.message.includes('ECONNREFUSED')) {
                console.log('   → Windows AF_HYPERV server not listening');
                console.log('   → Check wmux bridge is using real AF_HYPERV (not TCP simulation)');
            } else if (error.message.includes('ENODEV')) {
                console.log('   → VSOCK kernel module not loaded');
                console.log('   → Try: sudo modprobe vsock vmw_vsock_core');
            } else if (error.message.includes('EPERM')) {
                console.log('   → Permission denied accessing /dev/vsock');
                console.log('   → Try running with sudo or add user to appropriate group');
            }

            return false;
        }
    }

    async sendMessage(message) {
        if (!this.socket) {
            throw new Error('No VSOCK connection');
        }

        const data = JSON.stringify({
            type: 'vsock-message',
            content: message,
            timestamp: Date.now(),
            client: 'pure-vsock-wsl2'
        }) + '\n';

        console.log(`📤 Sending via VSOCK: ${message}`);

        return new Promise((resolve, reject) => {
            this.socket.write(data, (error) => {
                if (error) {
                    reject(error);
                } else {
                    console.log('✅ Message sent via VSOCK');
                    resolve();
                }
            });

            // Listen for response
            this.socket.once('data', (responseData) => {
                const response = responseData.toString().trim();
                console.log(`📥 VSOCK response: ${response}`);
                resolve(response);
            });
        });
    }

    async disconnect() {
        if (this.socket) {
            this.socket.end();
            this.socket = null;
            console.log('📴 VSOCK connection closed');
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    let message = 'Pure VSOCK test from WSL2';

    // Parse --message argument
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--message' && args[i + 1]) {
            message = args[i + 1];
            break;
        }
    }

    console.log('🚀 Pure VSOCK Test - WSL2 to Windows');
    console.log('===================================');
    console.log('Architecture: WSL2 (AF_VSOCK) ↔ Windows (AF_HYPERV)');
    console.log('Benefits: No TCP/IP, No firewall, No changing IPs');
    console.log();

    const client = new PureVsockClient();

    try {
        // Check VSOCK support
        const hasVsock = await client.checkVsockSupport();
        if (!hasVsock) {
            console.log('\n❌ VSOCK not available');
            console.log('\n🔧 Setup steps:');
            console.log('   1. Ensure WSL2 (not WSL1)');
            console.log('   2. Install: npm install node-vsock');
            console.log('   3. Load kernel module: sudo modprobe vsock');
            console.log('   4. Check device: ls -l /dev/vsock');
            process.exit(1);
        }

        console.log();

        // Connect via VSOCK
        const connected = await client.connectVsock();
        if (!connected) {
            console.log('\n❌ VSOCK connection failed');
            console.log('\n🔧 Windows side requirements:');
            console.log('   1. Bridge must use real AF_HYPERV (not TCP simulation)');
            console.log('   2. AF_HYPERV service registered in registry');
            console.log('   3. Bridge listening on correct VSOCK port');
            process.exit(1);
        }

        // Send test message
        await client.sendMessage(message);

        // Wait for response
        await new Promise(resolve => setTimeout(resolve, 1000));

        await client.disconnect();

        console.log('\n🎉 Pure VSOCK communication successful!');
        console.log('🔒 Secure VM-to-host communication established');
        console.log('🚫 Zero network/firewall involvement');

    } catch (error) {
        console.error(`\n❌ Pure VSOCK test failed: ${error.message}`);
        await client.disconnect();
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { PureVsockClient };