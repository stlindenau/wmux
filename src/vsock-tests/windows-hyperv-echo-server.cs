// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/*
 * Windows host AF_HYPERV echo server (canonical vsock demonstrator).
 *
 * Listens for AF_VSOCK connections coming from the WSL2 guest and echoes every
 * message back. Pure hypervisor-boundary IPC: NO TCP, NO IP, NO firewall rule.
 *
 * The WSL2 guest connects to (CID 2, port N). WSL2/Hyper-V presents that to the
 * Windows host as the AF_HYPERV service GUID:
 *     {N:x8}-facb-11e6-bd58-64006a7986d3
 * so the port is the single source of truth and the GUID is COMPUTED from it here
 * (this is the fix for the old hardcoded-GUID mismatch that caused ETIMEDOUT).
 *
 * First run must be elevated (Administrator): registering the service GUID under
 * HKLM\...\GuestCommunicationServices requires admin. Registration persists.
 *
 * Compile:  csc /out:windows-hyperv-echo-server.exe windows-hyperv-echo-server.cs
 * Run:      windows-hyperv-echo-server.exe [port]     (default 9787)
 */

using System;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace WmuxVsockDemo
{
    internal static class EchoServer
    {
        // AF_HYPERV socket family and helpers.
        private const int AF_HYPERV = 34;
        private const int SOCK_STREAM = 1;
        // Hyper-V sockets MUST be created with protocol HV_PROTOCOL_RAW (1); passing 0
        // yields WSAEPROTONOSUPPORT (10041).
        private const int HV_PROTOCOL_RAW = 1;
        private const int SOCKET_ERROR = -1;
        private static readonly IntPtr INVALID_SOCKET = new IntPtr(-1);
        private const int DEFAULT_PORT = 9787;
        private const int SOL_SOCKET = 0xFFFF;
        private const int SO_RCVTIMEO = 0x1006;
        private const int SO_SNDTIMEO = 0x1005;
        private static Stopwatch _startTime = Stopwatch.StartNew();

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int WSAStartup(ushort wVersionRequested, out WSAData lpWSAData);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int WSACleanup();

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int WSAGetLastError();

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern IntPtr socket(int af, int type, int protocol);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int bind(IntPtr s, byte[] addr, int addrlen);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int listen(IntPtr s, int backlog);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern IntPtr accept(IntPtr s, IntPtr addr, IntPtr addrlen);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int recv(IntPtr s, byte[] buf, int len, int flags);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int send(IntPtr s, byte[] buf, int len, int flags);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int closesocket(IntPtr s);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int setsockopt(IntPtr s, int level, int optname, ref int optval, int optlen);

        [StructLayout(LayoutKind.Sequential)]
        private struct WSAData
        {
            public ushort wVersion;
            public ushort wHighVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 257)]
            public string szDescription;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 129)]
            public string szSystemStatus;
            public ushort iMaxSockets;
            public ushort iMaxUdpDg;
            public IntPtr lpVendorInfo;
        }

        // SOCKADDR_HV — AF_HYPERV address (VmId + ServiceId).
        [StructLayout(LayoutKind.Sequential)]
        private struct SockaddrHv
        {
            public ushort Family;   // AF_HYPERV
            public ushort Reserved; // must be 0
            public Guid VmId;       // Guid.Empty == HV_GUID_WILDCARD (accept from any VM)
            public Guid ServiceId;  // computed from the vsock port
        }

        private static volatile bool _running = true;

        private static string GetWSAErrorName(int errCode)
        {
            if (errCode == 10013) return "WSAEACCES (10013) - Permission denied";
            if (errCode == 10048) return "WSAEADDRINUSE (10048) - Address already in use";
            if (errCode == 10049) return "WSAEADDRNOTAVAIL (10049) - Cannot assign requested address";
            if (errCode == 10047) return "WSAEAFNOSUPPORT (10047) - Address family not supported";
            if (errCode == 10041) return "WSAEPROTONOSUPPORT (10041) - Protocol not supported";
            if (errCode == 10060) return "WSAETIMEDOUT (10060) - Connection timed out";
            if (errCode == 10061) return "WSAECONNREFUSED (10061) - Connection refused";
            if (errCode == 10054) return "WSAECONNRESET (10054) - Connection reset by peer";
            return "WSA Error " + errCode;
        }

        private static void Log(string message)
        {
            var ts = _startTime.Elapsed;
            string time = ts.Hours.ToString("D2") + ":" + ts.Minutes.ToString("D2") + ":" + 
                         ts.Seconds.ToString("D2") + "." + ts.Milliseconds.ToString("D3");
            Console.WriteLine("[" + time + "] " + message);
        }

        // Derive the AF_HYPERV service GUID from a vsock port (single source of truth).
        private static Guid ServiceGuidForPort(int port)
        {
            return new Guid(string.Format("{0:x8}-facb-11e6-bd58-64006a7986d3", (uint)port));
        }

        private static int Main(string[] args)
        {
            int port = DEFAULT_PORT;
            if (args.Length > 0 && !int.TryParse(args[0], out port))
            {
                Console.WriteLine("Usage: windows-hyperv-echo-server.exe [port]");
                return 2;
            }

            Guid serviceId = ServiceGuidForPort(port);

            Console.WriteLine("Windows host AF_HYPERV echo server");
            Console.WriteLine("==================================");
            Log("Initialization started");
            Console.WriteLine("  vsock port   : " + port);
            Console.WriteLine("  service GUID : " + serviceId);
            Console.WriteLine("  transport    : pure AF_HYPERV (no TCP, no IP, no firewall)");
            Console.WriteLine();

            // Pre-flight checks
            Log("Running pre-flight diagnostics...");
            try
            {
                var hvService = ServiceController.GetServices()
                    .FirstOrDefault(s => s.ServiceName == "vmms");
                if (hvService != null)
                {
                    Log("  Hyper-V service status: " + hvService.Status);
                }
                else
                {
                    Log("  WARNING: Hyper-V service (vmms) not found");
                }
            }
            catch (Exception ex)
            {
                Log("  Could not check Hyper-V service: " + ex.Message);
            }

            // Check registry for service GUID
            try
            {
                using (RegistryKey key = Registry.LocalMachine.OpenSubKey(
                    @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\" + serviceId))
                {
                    if (key != null)
                    {
                        var value = key.GetValue("ElementName");
                        Log("  Service already registered: " + value);
                    }
                    else
                    {
                        Log("  Service not yet registered (will attempt registration)");
                    }
                }
            }
            catch (Exception ex)
            {
                Log("  Could not check registry: " + ex.Message);
            }
            Console.WriteLine();

            if (!RegisterService(serviceId))
            {
                return 1;
            }

            WSAData wsa;
            Log("Calling WSAStartup(0x0202)...");
            int startup = WSAStartup(0x0202, out wsa);
            if (startup != 0)
            {
                Log("[ERROR] WSAStartup failed: " + startup);
                return 1;
            }
            Log("  WSAStartup OK - Winsock " + wsa.wVersion.ToString("X2") + "." + wsa.wHighVersion.ToString("X2"));

            IntPtr listener = INVALID_SOCKET;
            try
            {
                Log("Creating AF_HYPERV socket(AF_HYPERV, SOCK_STREAM, HV_PROTOCOL_RAW)...");
                listener = socket(AF_HYPERV, SOCK_STREAM, HV_PROTOCOL_RAW);
                if (listener == INVALID_SOCKET)
                {
                    int err = WSAGetLastError();
                    Log("[ERROR] socket() failed: " + GetWSAErrorName(err));
                    Console.WriteLine("        Hyper-V sockets require the Windows Hypervisor Platform / WSL2.");
                    return 1;
                }
                Log("  Socket handle created: " + listener);

                var addr = new SockaddrHv
                {
                    Family = AF_HYPERV,
                    Reserved = 0,
                    VmId = Guid.Empty, // wildcard: accept from any VM (the WSL2 guest)
                    ServiceId = serviceId,
                };

                Log("  Address: VmId=" + addr.VmId + " (wildcard), ServiceId=" + addr.ServiceId);
                byte[] addrBytes = StructToBytes(addr);
                Log("  Calling bind(listener, addrBytes[" + addrBytes.Length + "])...");
                if (bind(listener, addrBytes, addrBytes.Length) == SOCKET_ERROR)
                {
                    int err = WSAGetLastError();
                    Log("[ERROR] bind() failed: " + GetWSAErrorName(err));
                    return 1;
                }
                Log("  bind() OK");

                // Set socket timeouts to detect stuck connections
                int recvTimeout = 30000; // 30 seconds
                int sendTimeout = 30000; // 30 seconds
                Log("  Setting socket timeouts: recv=" + recvTimeout + "ms, send=" + sendTimeout + "ms");
                if (setsockopt(listener, SOL_SOCKET, SO_RCVTIMEO, ref recvTimeout, sizeof(int)) == SOCKET_ERROR)
                {
                    int err = WSAGetLastError();
                    Log("[WARN] setsockopt(SO_RCVTIMEO) failed: " + GetWSAErrorName(err));
                }
                if (setsockopt(listener, SOL_SOCKET, SO_SNDTIMEO, ref sendTimeout, sizeof(int)) == SOCKET_ERROR)
                {
                    int err = WSAGetLastError();
                    Log("[WARN] setsockopt(SO_SNDTIMEO) failed: " + GetWSAErrorName(err));
                }

                Log("Calling listen(listener, 5)...");
                if (listen(listener, 5) == SOCKET_ERROR)
                {
                    int err = WSAGetLastError();
                    Log("[ERROR] listen() failed: " + GetWSAErrorName(err));
                    return 1;
                }
                Log("  listen() OK");

                Log("[OK] Listening for AF_HYPERV connections.");
                Console.WriteLine();
                Console.WriteLine("     Test from WSL2:");
                Console.WriteLine("       node wsl-vsock-echo-client.js --message \"Hello vsock\" --port " + port);
                Console.WriteLine();
                Console.WriteLine("Press Ctrl+C to stop.");
                Console.WriteLine();

                Console.CancelKeyPress += (s, e) =>
                {
                    e.Cancel = true;
                    _running = false;
                    Console.WriteLine();
                    Console.WriteLine("Shutting down...");
                    if (listener != INVALID_SOCKET)
                    {
                        closesocket(listener); // unblocks the pending accept()
                    }
                };

                int acceptCount = 0;
                while (_running)
                {
                    acceptCount++;
                    Log("Waiting for accept() [iteration " + acceptCount + "]...");
                    long acceptStartMs = DateTime.UtcNow.Ticks / 10000;
                    IntPtr client = accept(listener, IntPtr.Zero, IntPtr.Zero);
                    long acceptElapsedMs = (DateTime.UtcNow.Ticks / 10000) - acceptStartMs;
                    
                    if (client == INVALID_SOCKET)
                    {
                        if (!_running)
                        {
                            break;
                        }
                        int err = WSAGetLastError();
                        Log("[WARN] accept() iteration " + acceptCount + " failed after " + acceptElapsedMs + "ms: " + GetWSAErrorName(err));
                        continue;
                    }

                    string id = Guid.NewGuid().ToString("N").Substring(0, 8);
                    Log("[" + id + "] Client connected after " + acceptElapsedMs + "ms (socket handle: " + client + ")");
                    var t = new Thread(() => HandleClient(client, id));
                    t.IsBackground = true;
                    t.Start();
                }
            }
            finally
            {
                if (listener != INVALID_SOCKET)
                {
                    closesocket(listener);
                }
                WSACleanup();
                Console.WriteLine("Stopped.");
            }

            return 0;
        }

        private static void HandleClient(IntPtr client, string id)
        {
            try
            {
                var buffer = new byte[4096];
                while (_running)
                {
                    Log("[" + id + "] Calling recv()...");
                    int read = recv(client, buffer, buffer.Length, 0);
                    if (read <= 0)
                    {
                        if (read == 0)
                        {
                            Log("[" + id + "] recv() returned 0 (peer closed)");
                        }
                        else
                        {
                            int err = WSAGetLastError();
                            Log("[" + id + "] recv() failed: " + GetWSAErrorName(err));
                        }
                        break;
                    }

                    string message = Encoding.UTF8.GetString(buffer, 0, read).TrimEnd('\r', '\n');
                    Log("[" + id + "] RECV: " + read + " bytes: " + message);

                    string reply = "[ECHO] " + message + "\n";
                    byte[] replyBytes = Encoding.UTF8.GetBytes(reply);
                    Log("[" + id + "] Calling send(" + replyBytes.Length + " bytes)...");
                    int sent = send(client, replyBytes, replyBytes.Length, 0);
                    if (sent == SOCKET_ERROR)
                    {
                        int err = WSAGetLastError();
                        Log("[" + id + "] send() failed: " + GetWSAErrorName(err));
                        break;
                    }
                    Log("[" + id + "] SENT: " + sent + " bytes: " + reply.TrimEnd('\n'));
                }
            }
            catch (Exception ex)
            {
                Log("[" + id + "] Exception: " + ex.Message);
            }
            finally
            {
                closesocket(client);
                Log("[" + id + "] disconnected");
            }
        }

        private static bool RegisterService(Guid serviceId)
        {
            string path = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\"
                          + serviceId.ToString();
            try
            {
                using (RegistryKey key = Registry.LocalMachine.CreateSubKey(path))
                {
                    if (key == null)
                    {
                        Console.WriteLine("[ERROR] Could not create registry key: HKLM\\" + path);
                        return false;
                    }
                    key.SetValue("ElementName", "wmux vsock echo demo");
                    // GuestDefinedCapabilities: set as the GUID string in curly braces (standard format)
                    key.SetValue("GuestDefinedCapabilities", "{" + serviceId.ToString() + "}");
                    // Owner: optional but helps identify the service owner
                    key.SetValue("Owner", "ComputeSystem");
                    // Required Endpoint: standard for AF_HYPERV services
                    key.SetValue("RequiredGuestServices", "");
                }
                Console.WriteLine("[OK] Service GUID registered under GuestCommunicationServices.");
                Console.WriteLine("     Values set:");
                Console.WriteLine("       ElementName: wmux vsock echo demo");
                Console.WriteLine("       GuestDefinedCapabilities: {" + serviceId.ToString() + "}");
                Console.WriteLine("       Owner: ComputeSystem");
                return true;
            }
            catch (UnauthorizedAccessException)
            {
                Console.WriteLine("[ERROR] Access denied writing the service GUID.");
                Console.WriteLine("        Run this server elevated (Administrator) at least once.");
                return false;
            }
            catch (Exception ex)
            {
                Console.WriteLine("[ERROR] Service registration failed: " + ex.Message);
                return false;
            }
        }

        private static byte[] StructToBytes<T>(T value) where T : struct
        {
            int size = Marshal.SizeOf(typeof(T));
            byte[] bytes = new byte[size];
            IntPtr ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(value, ptr, false);
                Marshal.Copy(ptr, bytes, 0, size);
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
            return bytes;
        }
    }
}
