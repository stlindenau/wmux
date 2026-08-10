#!/usr/bin/env python3
# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information

"""
Check AF_VSOCK support in WSL2/container environment

This script validates whether the system supports AF_VSOCK sockets
for communication with the Windows host via Hyper-V.
"""

import socket
import os
import sys
import subprocess
import json
from typing import Dict, Any, List


class VsockChecker:
    def __init__(self):
        self.results = {
            'af_vsock_available': False,
            'vsock_device_exists': False,
            'kernel_modules': [],
            'platform_info': {},
            'recommendations': []
        }

    def check_python_support(self) -> bool:
        """Check if Python has AF_VSOCK support"""
        print("🐍 Checking Python AF_VSOCK support...")

        try:
            if hasattr(socket, 'AF_VSOCK'):
                af_vsock = socket.AF_VSOCK
                print(f"✅ Python AF_VSOCK available (value: {af_vsock})")
                self.results['af_vsock_available'] = True
                return True
            else:
                print("❌ Python AF_VSOCK not available")
                print("   Your Python version may be too old")
                self.results['recommendations'].append(
                    "Upgrade to Python 3.7+ for AF_VSOCK support"
                )
                return False
        except Exception as e:
            print(f"❌ Error checking Python support: {e}")
            return False

    def check_kernel_support(self) -> bool:
        """Check if kernel has VSOCK support"""
        print("\n🔍 Checking kernel VSOCK support...")

        # Check /dev/vsock device
        vsock_device = '/dev/vsock'
        if os.path.exists(vsock_device):
            print(f"✅ VSOCK device exists: {vsock_device}")
            self.results['vsock_device_exists'] = True
        else:
            print(f"❌ VSOCK device missing: {vsock_device}")
            self.results['recommendations'].append(
                "Load VSOCK kernel module: sudo modprobe vsock"
            )

        # Check kernel modules
        modules_found = []
        try:
            with open('/proc/modules', 'r') as f:
                modules_content = f.read()

            vsock_modules = ['vsock', 'vmw_vsock_core', 'vmw_vsock_vmci_transport']
            for module in vsock_modules:
                if module in modules_content:
                    modules_found.append(module)
                    print(f"✅ Kernel module loaded: {module}")

            if not modules_found:
                print("❌ No VSOCK kernel modules found")
                self.results['recommendations'].append(
                    "Load VSOCK modules: sudo modprobe vsock vmw_vsock_core"
                )
            else:
                print(f"✅ Found {len(modules_found)} VSOCK modules")

        except Exception as e:
            print(f"⚠️  Could not check kernel modules: {e}")

        self.results['kernel_modules'] = modules_found
        return len(modules_found) > 0 or os.path.exists(vsock_device)

    def get_platform_info(self) -> Dict[str, Any]:
        """Gather platform information"""
        print("\n📋 Gathering platform information...")

        info = {}

        # Basic system info
        try:
            uname = os.uname()
            info['system'] = uname.sysname
            info['release'] = uname.release
            info['version'] = uname.version
            info['machine'] = uname.machine
            print(f"   System: {uname.sysname} {uname.release}")
        except:
            info['system'] = 'unknown'

        # Check if we're in WSL
        try:
            with open('/proc/version', 'r') as f:
                version = f.read().lower()
                info['is_wsl'] = 'microsoft' in version or 'wsl' in version
                info['proc_version'] = version.strip()

            if info['is_wsl']:
                print("✅ Running in WSL environment")
                # Check WSL version
                if 'wsl2' in version:
                    info['wsl_version'] = 2
                    print("   WSL version: 2")
                else:
                    info['wsl_version'] = 1
                    print("   WSL version: 1 (VSOCK not supported)")
                    self.results['recommendations'].append(
                        "Upgrade to WSL2 for VSOCK support"
                    )
            else:
                print("   Not running in WSL")

        except Exception as e:
            print(f"⚠️  Could not determine WSL status: {e}")
            info['is_wsl'] = False

        # Check virtualization
        try:
            # Check for Hyper-V specific indicators
            hyperv_indicators = [
                '/sys/class/dmi/id/sys_vendor',
                '/sys/class/dmi/id/product_name'
            ]

            for indicator_file in hyperv_indicators:
                if os.path.exists(indicator_file):
                    with open(indicator_file, 'r') as f:
                        content = f.read().strip().lower()
                        if 'microsoft' in content or 'hyper-v' in content:
                            info['hypervisor'] = 'hyper-v'
                            print("✅ Hyper-V virtualization detected")
                            break
            else:
                info['hypervisor'] = 'unknown'
                print("   Virtualization: Unknown")

        except Exception as e:
            print(f"⚠️  Could not detect virtualization: {e}")

        # Python version
        info['python_version'] = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
        print(f"   Python: {info['python_version']}")

        self.results['platform_info'] = info
        return info

    def test_socket_creation(self) -> bool:
        """Test actual VSOCK socket creation"""
        print("\n🔌 Testing VSOCK socket creation...")

        if not self.results['af_vsock_available']:
            print("❌ Skipping - AF_VSOCK not available")
            return False

        try:
            # Try to create a VSOCK socket
            sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
            print("✅ VSOCK socket created successfully")

            # Try to get socket info
            try:
                sockname = sock.getsockname()
                print(f"   Socket name: {sockname}")
            except Exception as e:
                print(f"   Socket name unavailable: {e}")

            sock.close()
            print("✅ VSOCK socket closed successfully")
            return True

        except Exception as e:
            print(f"❌ VSOCK socket creation failed: {e}")
            return False

    def check_permissions(self) -> bool:
        """Check permissions for VSOCK operations"""
        print("\n🔐 Checking permissions...")

        # Check /dev/vsock permissions
        vsock_device = '/dev/vsock'
        if os.path.exists(vsock_device):
            try:
                stat = os.stat(vsock_device)
                mode = oct(stat.st_mode)[-3:]
                print(f"   /dev/vsock permissions: {mode}")

                # Check if readable/writable
                if os.access(vsock_device, os.R_OK | os.W_OK):
                    print("✅ /dev/vsock is accessible")
                    return True
                else:
                    print("❌ /dev/vsock is not accessible")
                    self.results['recommendations'].append(
                        "Add user to appropriate group or run as root"
                    )
                    return False

            except Exception as e:
                print(f"⚠️  Could not check /dev/vsock permissions: {e}")
        else:
            print("❌ /dev/vsock device not found")

        return False

    def generate_summary(self) -> Dict[str, Any]:
        """Generate final summary and recommendations"""
        print("\n" + "="*50)
        print("📊 VSOCK SUPPORT SUMMARY")
        print("="*50)

        summary = {
            'vsock_ready': False,
            'major_blockers': [],
            'minor_issues': [],
            'next_steps': []
        }

        # Check readiness
        if (self.results['af_vsock_available'] and
            self.results['vsock_device_exists'] and
            len(self.results['kernel_modules']) > 0):
            summary['vsock_ready'] = True
            print("✅ VSOCK is ready for use!")
        else:
            print("❌ VSOCK is NOT ready")

        # Identify blockers
        if not self.results['af_vsock_available']:
            summary['major_blockers'].append("Python AF_VSOCK not available")

        if not self.results['vsock_device_exists']:
            summary['major_blockers'].append("/dev/vsock device missing")

        if len(self.results['kernel_modules']) == 0:
            summary['major_blockers'].append("VSOCK kernel modules not loaded")

        platform = self.results['platform_info']
        if platform.get('is_wsl') and platform.get('wsl_version', 0) < 2:
            summary['major_blockers'].append("WSL1 does not support VSOCK")

        # Next steps
        if summary['major_blockers']:
            print("\n🚫 Major blockers:")
            for blocker in summary['major_blockers']:
                print(f"   • {blocker}")

        if self.results['recommendations']:
            print("\n🔧 Recommendations:")
            summary['next_steps'] = self.results['recommendations']
            for rec in self.results['recommendations']:
                print(f"   • {rec}")

        if summary['vsock_ready']:
            print("\n🚀 Ready to test VSOCK connection!")
            print("   Run: node wsl-vsock-client.js")
        else:
            print("\n🔄 After fixing issues, run this script again to recheck")

        return summary

    def run_full_check(self) -> Dict[str, Any]:
        """Run complete VSOCK support check"""
        print("🔍 VSOCK Support Checker for WSL2/Container")
        print("=" * 45)

        self.check_python_support()
        self.check_kernel_support()
        self.get_platform_info()
        self.test_socket_creation()
        self.check_permissions()

        summary = self.generate_summary()

        # Save results
        self.results['summary'] = summary
        return self.results

    def save_results(self, filename: str = 'vsock-check-results.json'):
        """Save results to JSON file"""
        try:
            with open(filename, 'w') as f:
                json.dump(self.results, f, indent=2)
            print(f"\n📄 Results saved to: {filename}")
        except Exception as e:
            print(f"⚠️  Could not save results: {e}")


def main():
    checker = VsockChecker()

    try:
        results = checker.run_full_check()

        # Save results if requested
        if '--save' in sys.argv:
            checker.save_results()

        # Exit with appropriate code
        if results['summary']['vsock_ready']:
            sys.exit(0)
        else:
            sys.exit(1)

    except KeyboardInterrupt:
        print("\n⏹  Interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()