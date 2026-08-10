// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/*
 * Register a VMBus socket service with a running WSL2 HCS VM.
 *
 * WSL2 is managed by the Host Compute Service (HCS) � not traditional Hyper-V.
 * GuestCommunicationServices registry entries are not honored for HCS-managed VMs.
 * WSL2 registers its own socket services (like port 50000) dynamically via HCS APIs.
 * This tool replicates that: opens the WSL2 HCS compute system and calls
 * HcsModifyComputeSystem to add a VMBus channel offer for our service GUID.
 *
 * Findings on Windows 10.0.26100:
 *   - computecore.dll v10.0.26100.8875 present
 *   - HcsFreeMemory does NOT exist; use CoTaskMemFree or LocalFree instead
 *   - HcsCreateOperation + HcsWaitForOperationResult required for async results
 *
 * Usage (must be run elevated):
 *   hcs-add-vsock-service.exe [port] <vm-id>
 *   Example: hcs-add-vsock-service.exe 9787 8A10709E-6C8D-464C-B558-734C4EF7AFAA
 *
 * Compile:  csc /out:hcs-add-vsock-service.exe hcs-add-vsock-service.cs
 */

using System;
using System.Runtime.InteropServices;

namespace WmuxVsockDemo
{
    internal static class HcsAddVsockService
    {
        [DllImport("computecore.dll", CharSet = CharSet.Unicode, CallingConvention = CallingConvention.Winapi)]
        private static extern uint HcsOpenComputeSystem(string id, uint access, out IntPtr system, out IntPtr result);

        // operation = HCS_OPERATION handle; must use HcsCreateOperation first
        [DllImport("computecore.dll", CharSet = CharSet.Unicode, CallingConvention = CallingConvention.Winapi)]
        private static extern uint HcsModifyComputeSystem(IntPtr system, IntPtr operation, string configuration, IntPtr identity);

        [DllImport("computecore.dll", CallingConvention = CallingConvention.Winapi)]
        private static extern uint HcsCloseComputeSystem(IntPtr system);

        [DllImport("computecore.dll", CallingConvention = CallingConvention.Winapi)]
        private static extern IntPtr HcsCreateOperation(IntPtr context, IntPtr callback);

        [DllImport("computecore.dll", CharSet = CharSet.Unicode, CallingConvention = CallingConvention.Winapi)]
        private static extern uint HcsGetComputeSystemProperties(IntPtr system, IntPtr operation, string propertyQuery);

        // Blocks until the operation completes and returns the JSON result
        [DllImport("computecore.dll", CharSet = CharSet.Unicode, CallingConvention = CallingConvention.Winapi)]
        private static extern uint HcsWaitForOperationResult(IntPtr operation, uint timeoutMs, out IntPtr resultDocument);

        [DllImport("computecore.dll", CallingConvention = CallingConvention.Winapi)]
        private static extern void HcsCloseOperation(IntPtr operation);

        // HcsFreeMemory not present in this build; use CoTaskMemFree
        [DllImport("ole32.dll", CallingConvention = CallingConvention.Winapi)]
        private static extern void CoTaskMemFree(IntPtr pv);

        private const uint GENERIC_ALL = 0x10000000;
        private const uint INFINITE = 0xFFFFFFFF;
        private const int DEFAULT_PORT = 9787;

        private static string ReadAndFree(IntPtr ptr)
        {
            if (ptr == IntPtr.Zero) return "";
            string s = Marshal.PtrToStringUni(ptr);
            CoTaskMemFree(ptr);
            return s;
        }

        private static string ServiceGuidForPort(int port)
        {
            return string.Format("{0:x8}-facb-11e6-bd58-64006a7986d3", (uint)port);
        }

        private static int Main(string[] args)
        {
            int port = DEFAULT_PORT;
            string vmId = null;

            foreach (string a in args)
            {
                int n;
                if (int.TryParse(a, out n)) port = n;
                else vmId = a;
            }

            string serviceGuid = ServiceGuidForPort(port);
            Console.WriteLine("HCS AF_VSOCK Service Registrar");
            Console.WriteLine("==============================");
            Console.WriteLine("  port         : " + port);
            Console.WriteLine("  service GUID : " + serviceGuid);
            Console.WriteLine("  vm id        : " + (vmId ?? "(required)"));
            Console.WriteLine();

            if (string.IsNullOrEmpty(vmId))
            {
                Console.WriteLine("Usage: hcs-add-vsock-service.exe [port] <vm-id>");
                Console.WriteLine("  Get VM ID: hcsdiag list -raw  (elevated)");
                return 2;
            }

            // Open the WSL2 HCS compute system
            Console.WriteLine("[1] HcsOpenComputeSystem...");
            IntPtr system = IntPtr.Zero;
            IntPtr resultPtr = IntPtr.Zero;
            uint hr = HcsOpenComputeSystem(vmId, GENERIC_ALL, out system, out resultPtr);
            string resultJson = ReadAndFree(resultPtr);
            Console.WriteLine("  hr=" + hr.ToString("X8") + (resultJson.Length > 0 ? "  " + resultJson : ""));
            if (hr != 0 || system == IntPtr.Zero)
            {
                Console.WriteLine("[ERROR] Open failed. Run elevated?");
                return 1;
            }
            Console.WriteLine("  [OK] handle=0x" + system.ToString("X"));
            Console.WriteLine();

            Console.WriteLine("[2-A] HcsGetComputeSystemProperties to discover schema...");
            IntPtr propsOp = HcsCreateOperation(IntPtr.Zero, IntPtr.Zero);
            // Empty query returns full properties
            uint propsHr = HcsGetComputeSystemProperties(system, propsOp, "{}");
            Console.WriteLine("  get hr=0x" + propsHr.ToString("X8"));
            if (propsHr == 0)
            {
                IntPtr propsResult = IntPtr.Zero;
                uint propsWait = HcsWaitForOperationResult(propsOp, 10000, out propsResult);
                string propsJson = ReadAndFree(propsResult);
                Console.WriteLine("  wait hr=0x" + propsWait.ToString("X8"));
                if (propsJson.Length > 0)
                {
                    // Write to file so we can inspect it
                    System.IO.File.WriteAllText("C:\\Temp\\hcs-vm-properties.json", propsJson);
                    Console.WriteLine("  [OK] Properties written to C:\\Temp\\hcs-vm-properties.json");
                    Console.WriteLine("  Preview: " + propsJson.Substring(0, Math.Min(300, propsJson.Length)));
                }
            }
            HcsCloseOperation(propsOp);
            Console.WriteLine();
            IntPtr op = HcsCreateOperation(IntPtr.Zero, IntPtr.Zero);
            Console.WriteLine("  operation=0x" + op.ToString("X"));
            if (op == IntPtr.Zero)
            {
                Console.WriteLine("[ERROR] Could not create operation");
                HcsCloseComputeSystem(system);
                return 1;
            }
            Console.WriteLine();

            // Try multiple JSON formats
            string[] formats = new string[]
            {
                // Format A: VirtualMachine device delta (HCS native schema)
                "{\"VirtualMachine\":{\"Devices\":{\"HvSocket\":{\"HvSocketConfig\":{\"ServiceTable\":{\"" + serviceGuid + "\":{}}}}}}}",

                // Format B: with AllowWildcardBinds
                "{\"VirtualMachine\":{\"Devices\":{\"HvSocket\":{\"HvSocketConfig\":{\"ServiceTable\":{\"" + serviceGuid + "\":{\"AllowWildcardBinds\":true,\"Disabled\":false}}}}}}}",

                // Format C: GuestCommunicationServices as VirtualMachine delta
                "{\"VirtualMachine\":{\"GuestCommunicationServices\":{\"" + serviceGuid + "\":{\"ElementName\":\"wmux vsock echo demo\"}}}}",

                // Format D: Flat ResourceType (standard pattern, doesn't work for WSL2 but keep for logging)
                "{\"ResourceType\":\"VirtualSocketService\",\"RequestType\":\"Add\",\"Settings\":{\"ServiceId\":\"" + serviceGuid + "\"}}",
            };

            bool success = false;
            Console.WriteLine("[3] HcsModifyComputeSystem (trying formats)...");
            foreach (string json in formats)
            {
                Console.WriteLine("  " + json.Substring(0, Math.Min(72, json.Length)) + "...");
                hr = HcsModifyComputeSystem(system, op, json, IntPtr.Zero);
                Console.WriteLine("    modify hr=0x" + hr.ToString("X8"));

                if (hr == 0)
                {
                    // Wait for operation to complete and get result
                    IntPtr opResultPtr = IntPtr.Zero;
                    uint waitHr = HcsWaitForOperationResult(op, 10000, out opResultPtr);
                    string opResult = ReadAndFree(opResultPtr);
                    Console.WriteLine("    wait   hr=0x" + waitHr.ToString("X8") + (opResult.Length > 0 ? "  " + opResult : ""));
                    if (waitHr == 0)
                    {
                        success = true;
                        Console.WriteLine("    [OK] Format accepted!");
                        break;
                    }
                    // Re-create operation for next try (operation is consumed after wait)
                    HcsCloseOperation(op);
                    op = HcsCreateOperation(IntPtr.Zero, IntPtr.Zero);
                }
            }

            HcsCloseOperation(op);
            HcsCloseComputeSystem(system);
            Console.WriteLine();

            if (!success)
            {
                Console.WriteLine("[FAIL] No format was accepted by HCS.");
                Console.WriteLine("       hr=0x80004005 = generic failure");
                Console.WriteLine("       hr=0x80070005 = access denied");
                Console.WriteLine("       hr=0x80070057 = invalid argument (wrong JSON schema)");
                return 1;
            }

            Console.WriteLine("[OK] VMBus socket service registered.");
            Console.WriteLine("Verify from WSL2:");
            Console.WriteLine("  wsl -- bash -c \"find /sys/bus/vmbus/drivers/hv_sock/ -name class_id -exec grep -l " + serviceGuid + " {} +\"");
            return 0;
        }
    }
}
