#!/usr/bin/env node
// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/**
 * Interactive VSOCK Data Sender
 * Type messages and send them over pure VSOCK
 */

const readline = require('readline');

// Import our pure VSOCK client
const { PureVsockClient } = require('./wsl-vsock-pure.js');

class VsockInteractive {
    constructor() {
        this.client = new PureVsockClient();
        this.connected = false;

        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: 'VSOCK> '
        });
    }

    async start() {
        console.log('🚀 Interactive VSOCK Data Sender');
        console.log('================================');
        console.log('Architecture: WSL2 → AF_VSOCK → Windows AF_HYPERV → Named Pipe');
        console.log();

        // Check VSOCK support
        const hasVsock = await this.client.checkVsockSupport();
        if (!hasVsock) {
            console.log('❌ VSOCK not available');
            process.exit(1);
        }

        // Connect
        console.log('🔌 Connecting to Windows bridge via pure VSOCK...');
        this.connected = await this.client.connectVsock();

        if (!this.connected) {
            console.log('❌ Failed to connect via VSOCK');
            console.log('   Ensure Windows bridge is running: wmux-hyperv-bridge-pure.exe');
            process.exit(1);
        }

        console.log('✅ Pure VSOCK connection established!');
        console.log();
        console.log('📝 Type messages to send over VSOCK bridge:');
        console.log('   Commands:');
        console.log('   - .help    Show this help');
        console.log('   - .status  Show connection status');
        console.log('   - .test    Send test data');
        console.log('   - .exit    Disconnect and exit');
        console.log();

        this.rl.prompt();

        this.rl.on('line', async (input) => {
            const line = input.trim();

            if (line === '.exit') {
                await this.disconnect();
                process.exit(0);
            } else if (line === '.help') {
                this.showHelp();
            } else if (line === '.status') {
                this.showStatus();
            } else if (line === '.test') {
                await this.sendTestData();
            } else if (line === '') {
                // Empty line, just prompt again
            } else {
                await this.sendMessage(line);
            }

            this.rl.prompt();
        });

        this.rl.on('SIGINT', async () => {
            console.log('\n👋 Disconnecting...');
            await this.disconnect();
            process.exit(0);
        });
    }

    async sendMessage(message) {
        if (!this.connected) {
            console.log('❌ Not connected');
            return;
        }

        try {
            console.log(`📤 Sending via VSOCK: "${message}"`);
            await this.client.sendMessage(message);
            console.log('✅ Message sent successfully');
        } catch (error) {
            console.log(`❌ Send failed: ${error.message}`);
        }
    }

    async sendTestData() {
        const testMessages = [
            'Test message 1',
            '{"type":"json","data":"structured data test"}',
            'Unicode test: 🚀🔒📡',
            'Long message: ' + 'A'.repeat(100),
            'Binary-like data: ' + Buffer.from('hello').toString('base64')
        ];

        console.log('🧪 Sending test data sequence...');

        for (let i = 0; i < testMessages.length; i++) {
            console.log(`   Test ${i+1}/${testMessages.length}: ${testMessages[i]}`);
            await this.sendMessage(testMessages[i]);
            await new Promise(resolve => setTimeout(resolve, 500)); // Small delay
        }

        console.log('✅ Test sequence completed');
    }

    showHelp() {
        console.log();
        console.log('📋 Interactive VSOCK Commands:');
        console.log('   .help    - Show this help');
        console.log('   .status  - Connection status');
        console.log('   .test    - Send test data sequence');
        console.log('   .exit    - Disconnect and exit');
        console.log('   <text>   - Send text message via VSOCK');
        console.log();
        console.log('Data Flow: Your Input → AF_VSOCK → Windows AF_HYPERV → Named Pipe');
        console.log();
    }

    showStatus() {
        console.log();
        console.log('📊 VSOCK Connection Status:');
        console.log('   Connected:', this.connected ? '✅ Yes' : '❌ No');
        console.log('   Transport: Pure AF_VSOCK (no TCP)');
        console.log('   Target: Windows host CID 2:9787');
        console.log('   Bridge: AF_HYPERV → Named Pipe');
        console.log();
    }

    async disconnect() {
        if (this.client) {
            await this.client.disconnect();
            this.connected = false;
        }
        this.rl.close();
    }
}

async function main() {
    const interactive = new VsockInteractive();

    try {
        await interactive.start();
    } catch (error) {
        console.error(`❌ Interactive session failed: ${error.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}