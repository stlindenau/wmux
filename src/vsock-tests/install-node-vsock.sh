#!/bin/bash
# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information

# Install node-vsock for pure VSOCK communication

set -e

echo "🔧 Installing node-vsock for pure VSOCK support"
echo "==============================================="
echo

# Check if we're in WSL2
echo "1. Checking WSL2 environment..."
if grep -qi "microsoft.*wsl2" /proc/version 2>/dev/null; then
    echo "✅ WSL2 environment detected"
else
    echo "❌ WSL2 not detected - VSOCK requires WSL2"
    exit 1
fi

# Check for /dev/vsock
echo "2. Checking VSOCK device..."
if [ -e /dev/vsock ]; then
    echo "✅ /dev/vsock device found"
    ls -l /dev/vsock
else
    echo "⚠️  /dev/vsock device missing"
    echo "   Loading VSOCK kernel module..."

    if sudo modprobe vsock 2>/dev/null; then
        echo "✅ VSOCK kernel module loaded"
    else
        echo "❌ Failed to load VSOCK kernel module"
        echo "   Your kernel may not support VSOCK"
        exit 1
    fi

    if [ -e /dev/vsock ]; then
        echo "✅ /dev/vsock device now available"
    else
        echo "❌ /dev/vsock still not available after loading module"
        exit 1
    fi
fi

# Check Node.js and npm
echo "3. Checking Node.js..."
if command -v node >/dev/null 2>&1; then
    NODE_VERSION=$(node --version)
    echo "✅ Node.js found: $NODE_VERSION"
else
    echo "❌ Node.js not found"
    echo "   Install Node.js first"
    exit 1
fi

if command -v npm >/dev/null 2>&1; then
    NPM_VERSION=$(npm --version)
    echo "✅ npm found: $NPM_VERSION"
else
    echo "❌ npm not found"
    echo "   Install npm first"
    exit 1
fi

# Install node-vsock
echo "4. Installing node-vsock..."
echo "   This may take a few minutes (native compilation)..."
echo

if npm install node-vsock; then
    echo "✅ node-vsock installed successfully"
else
    echo "❌ node-vsock installation failed"
    echo
    echo "🔧 Troubleshooting:"
    echo "   • Install build tools: sudo apt update && sudo apt install build-essential"
    echo "   • Install Python: sudo apt install python3 python3-dev"
    echo "   • Clear npm cache: npm cache clean --force"
    echo "   • Try with sudo: sudo npm install -g node-vsock"
    exit 1
fi

# Test the installation
echo "5. Testing node-vsock..."
if node -e "require('node-vsock'); console.log('✅ node-vsock loads correctly')" 2>/dev/null; then
    echo "✅ node-vsock test passed"
else
    echo "❌ node-vsock test failed"
    echo "   Module installed but cannot be loaded"
    exit 1
fi

echo
echo "🎉 Setup complete!"
echo "=================="
echo
echo "✅ WSL2 environment: Ready"
echo "✅ VSOCK device: Available"
echo "✅ node-vsock module: Installed"
echo
echo "🧪 Test pure VSOCK:"
echo "   node wsl-vsock-pure.js --message \"Hello VSOCK!\""
echo
echo "📋 Architecture:"
echo "   WSL2 (AF_VSOCK) ↔ Windows (AF_HYPERV) ↔ Named Pipe"
echo "   No TCP/IP, No firewall issues, No changing IPs"