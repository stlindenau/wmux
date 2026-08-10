#!/usr/bin/env node
// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/**
 * WSL2 VSOCK Client in JavaScript for wmux bridge communication
 *
 * This client works in the Windows -> VSOCK -> WSL -> TCP -> Container chain.
 * It connects from WSL2 to the Windows AF_HYPERV server via VSOCK,
 * then can relay to containers via TCP.
 *
 * Usage: node wsl-vsock-client.js [options]
 */

const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');

// Constants
const AF_VSOCK = 40; // Linux AF_VSOCK family
const VMADDR_CID_HOST = 2; // Windows host CID
const DEFAULT_PORT = 9787;

class VsockWmuxClient {
    constructor(options = {}) {
        this.hostCid = options.hostCid || VMADDR_CID_HOST;
        this.port = options.port || DEFAULT_PORT;
        this.vsockSupported = false;
        this.connection = null;
        this.tcpRelayServer = null;
        this.tcpRelayPort = options.tcpRelayPort || 9788;
    }

    async checkVsockSupport() {
        console.log('🔍 Checking VSOCK support in Node.js...');

        try {
            // Check if we're in WSL
            const procVersion = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
            const isWSL = procVersion.includes('microsoft') || procVersion.includes('wsl');

            if (!isWSL) {
                throw new Error('Not running in WSL environment');
            }

            console.log('✅ Running in WSL environment');

            // Check for VSOCK device
            if (!fs.existsSync('/dev/vsock')) {
                throw new Error('/dev/vsock device not found');
            }

            console.log('✅ /dev/vsock device found');

            // Note: Node.js doesn't have built-in AF_VSOCK support
            // We'll need to use a workaround or native addon
            console.log('⚠️  Node.js doesn\'t have native AF_VSOCK support');
            console.log('   Using Python bridge for VSOCK communication...');

            return true;

        } catch (error) {
            console.log(`❌ VSOCK support check failed: ${error.message}`);
            return false;
        }
    }

    async connectVsockViaPython() {
        console.log(`🔌 Connecting to VSOCK CID ${this.hostCid}:${this.port} via Python...`);

        return new Promise((resolve, reject) => {
            // Use Python script as a bridge for VSOCK communication
            const pythonScript = `
import socket
import sys
import json

try:
    if hasattr(socket, 'AF_VSOCK'):
        sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        sock.connect((${this.hostCid}, ${this.port}))

        # Send connection success
        print(json.dumps({"status": "connected", "transport": "vsock"}))
        sys.stdout.flush()

        # Relay mode - read from stdin and send to VSOCK
        while True:
            line = sys.stdin.readline()
            if not line:
                break
            sock.send(line.encode())
            response = sock.recv(1024).decode().strip()
            print(json.dumps({"type": "response", "data": response}))
            sys.stdout.flush()

    else:
        print(json.dumps({"status": "error", "message": "AF_VSOCK not available"}))

except Exception as e:
    print(json.dumps({"status": "error", "message": str(e)}))
`;

            const pythonProcess = spawn('python3', ['-c', pythonScript], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let connectionEstablished = false;

            pythonProcess.stdout.on('data', (data) => {
                const lines = data.toString().split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        const response = JSON.parse(line);

                        if (response.status === 'connected') {
                            console.log('✅ VSOCK connection established via Python bridge');
                            connectionEstablished = true;
                            this.connection = pythonProcess;
                            resolve(true);
                        } else if (response.status === 'error') {
                            if (!connectionEstablished) {
                                reject(new Error(response.message));
                            }
                        } else if (response.type === 'response') {
                            console.log(`📥 Received: ${response.data}`);
                        }
                    } catch (e) {
                        // Ignore non-JSON lines
                    }
                }
            });

            pythonProcess.stderr.on('data', (data) => {
                console.error(`Python stderr: ${data}`);
            });

            pythonProcess.on('close', (code) => {
                if (!connectionEstablished) {
                    reject(new Error(`Python process exited with code ${code}`));
                }
            });

            // Set timeout
            setTimeout(() => {
                if (!connectionEstablished) {
                    pythonProcess.kill();
                    reject(new Error('Connection timeout'));
                }
            }, 10000);
        });
    }

    async connectTcpFallback() {
        console.log('🔄 Falling back to TCP connection...');

        const hosts = [
            { host: 'host.docker.internal', name: 'Docker host' },
            { host: '172.17.0.1', name: 'Docker bridge' },
            { host: '127.0.0.1', name: 'Localhost' }
        ];

        for (const { host, name } of hosts) {
            try {
                console.log(`   Trying ${host} (${name})...`);

                const socket = net.createConnection(this.port, host);

                await new Promise((resolve, reject) => {
                    socket.on('connect', () => {
                        console.log(`✅ TCP connection established to ${host}:${this.port}`);
                        this.connection = socket;
                        resolve();
                    });

                    socket.on('error', reject);

                    setTimeout(() => reject(new Error('Timeout')), 5000);
                });

                return true;

            } catch (error) {
                console.log(`   ❌ ${host} failed: ${error.message}`);
            }
        }

        console.log('❌ All TCP fallback attempts failed');
        return false;
    }

    async sendMessage(message) {
        if (!this.connection) {
            throw new Error('No active connection');
        }

        const messageData = {
            type: 'message',
            content: message,
            timestamp: Date.now(),
            client: 'wsl-vsock-client-js'
        };

        if (this.connection.stdin) {
            // Python bridge
            this.connection.stdin.write(JSON.stringify(messageData) + '\n');
        } else {
            // Direct TCP
            this.connection.write(JSON.stringify(messageData) + '\n');
        }

        console.log(`📤 Sent: ${message}`);
    }

    createTcpRelayServer() {
        console.log(`🔗 Creating TCP relay server on port ${this.tcpRelayPort}...`);

        return new Promise((resolve, reject) => {
            this.tcpRelayServer = net.createServer((clientSocket) => {
                console.log('📞 Container client connected to TCP relay');

                clientSocket.on('data', (data) => {
                    const message = data.toString().trim();
                    console.log(`🔄 Relaying to VSOCK: ${message}`);

                    if (this.connection) {
                        this.sendMessage(message).catch(console.error);
                    }
                });

                clientSocket.on('close', () => {
                    console.log('📴 Container client disconnected');
                });

                clientSocket.on('error', (error) => {
                    console.error(`❌ Client error: ${error.message}`);
                });
            });

            this.tcpRelayServer.listen(this.tcpRelayPort, '127.0.0.1', () => {
                console.log(`✅ TCP relay server listening on 127.0.0.1:${this.tcpRelayPort}`);
                console.log('🐳 Containers can connect to this port for VSOCK relay');
                resolve();
            });

            this.tcpRelayServer.on('error', reject);
        });
    }

    async disconnect() {
        if (this.connection) {
            if (this.connection.stdin) {
                // Python bridge
                this.connection.stdin.end();
                this.connection.kill();
            } else {
                // Direct TCP
                this.connection.end();
            }
            this.connection = null;
            console.log('📴 VSOCK connection closed');
        }

        if (this.tcpRelayServer) {
            this.tcpRelayServer.close();
            this.tcpRelayServer = null;
            console.log('📴 TCP relay server stopped');
        }
    }

    async testCommunication() {
        console.log('🧪 Testing VSOCK communication...\n');

        try {
            // 1. Check VSOCK support
            const hasVsock = await this.checkVsockSupport();

            // 2. Establish connection
            let connected = false;

            if (hasVsock) {
                try {
                    await this.connectVsockViaPython();
                    connected = true;
                } catch (error) {
                    console.log(`❌ VSOCK connection failed: ${error.message}`);
                }
            }

            if (!connected) {
                connected = await this.connectTcpFallback();
            }

            if (!connected) {
                throw new Error('All connection attempts failed');
            }

            // 3. Test message exchange
            const testMessages = [
                'Hello from WSL2!',
                'VSOCK bridge test',
                'Container communication ready'
            ];

            for (const message of testMessages) {
                await this.sendMessage(message);
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // 4. Start TCP relay for containers
            await this.createTcpRelayServer();

            console.log('\n✅ VSOCK communication test completed successfully!');
            console.log('\n📋 Connection Summary:');
            console.log('   • VSOCK bridge: Active');
            console.log(`   • TCP relay: 127.0.0.1:${this.tcpRelayPort}`);
            console.log('   • Container access: Available');

            return true;

        } catch (error) {
            console.error(`❌ Test failed: ${error.message}`);
            return false;
        }
    }

    async interactiveMode() {
        console.log('\n💬 Interactive mode - type messages (Ctrl+C to quit):');

        process.stdin.setEncoding('utf8');

        process.stdin.on('data', async (input) => {
            const message = input.trim();
            if (message) {
                try {
                    await this.sendMessage(message);
                } catch (error) {
                    console.error(`❌ Send failed: ${error.message}`);
                }
            }
        });

        process.on('SIGINT', async () => {
            console.log('\n⏹  Shutting down...');
            await this.disconnect();
            process.exit(0);
        });
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2);

    const options = {
        hostCid: 2,
        port: 9787,
        tcpRelayPort: 9788
    };

    // Parse arguments
    for (let i = 0; i < args.length; i += 2) {
        const arg = args[i];
        const value = args[i + 1];

        switch (arg) {
            case '--host-cid':
                options.hostCid = parseInt(value);
                break;
            case '--port':
                options.port = parseInt(value);
                break;
            case '--tcp-relay-port':
                options.tcpRelayPort = parseInt(value);
                break;
            case '--message':
                options.singleMessage = value;
                break;
            case '--help':
                console.log('WSL2 VSOCK Client for wmux bridge');
                console.log('');
                console.log('Usage: node wsl-vsock-client.js [options]');
                console.log('');
                console.log('Options:');
                console.log('  --host-cid <n>         Windows host CID (default: 2)');
                console.log('  --port <n>             VSOCK port (default: 9787)');
                console.log('  --tcp-relay-port <n>   TCP relay port (default: 9788)');
                console.log('  --message <text>       Send single message and exit');
                console.log('  --help                 Show this help');
                console.log('');
                console.log('This creates a bridge: Windows VSOCK <-> WSL <-> Container TCP');
                process.exit(0);
        }
    }

    const client = new VsockWmuxClient(options);

    try {
        if (options.singleMessage) {
            // Single message mode
            const hasVsock = await client.checkVsockSupport();
            let connected = false;

            if (hasVsock) {
                try {
                    await client.connectVsockViaPython();
                    connected = true;
                } catch (error) {
                    console.log(`VSOCK failed: ${error.message}`);
                }
            }

            if (!connected) {
                connected = await client.connectTcpFallback();
            }

            if (connected) {
                await client.sendMessage(options.singleMessage);
                await client.disconnect();
            } else {
                process.exit(1);
            }
        } else {
            // Full test and interactive mode
            const success = await client.testCommunication();

            if (success) {
                await client.interactiveMode();
            } else {
                process.exit(1);
            }
        }

    } catch (error) {
        console.error(`❌ Unexpected error: ${error.message}`);
        await client.disconnect();
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { VsockWmuxClient };