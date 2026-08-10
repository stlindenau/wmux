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
using System.Runtime.InteropServices;
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
            Console.WriteLine("  vsock port   : " + port);
            Console.WriteLine("  service GUID : " + serviceId);
            Console.WriteLine("  transport    : pure AF_HYPERV (no TCP, no IP, no firewall)");
            Console.WriteLine();

            if (!RegisterService(serviceId))
            {
                return 1;
            }

            WSAData wsa;
            int startup = WSAStartup(0x0202, out wsa);
            if (startup != 0)
            {
                Console.WriteLine("[ERROR] WSAStartup failed: " + startup);
                return 1;
            }

            IntPtr listener = INVALID_SOCKET;
            try
            {
                listener = socket(AF_HYPERV, SOCK_STREAM, HV_PROTOCOL_RAW);
                if (listener == INVALID_SOCKET)
                {
                    Console.WriteLine("[ERROR] AF_HYPERV socket() failed: " + WSAGetLastError());
                    Console.WriteLine("        Hyper-V sockets require the Windows Hypervisor Platform / WSL2.");
                    return 1;
                }

                var addr = new SockaddrHv
                {
                    Family = AF_HYPERV,
                    Reserved = 0,
                    VmId = Guid.Empty, // wildcard: accept from any VM (the WSL2 guest)
                    ServiceId = serviceId,
                };

                byte[] addrBytes = StructToBytes(addr);
                if (bind(listener, addrBytes, addrBytes.Length) == SOCKET_ERROR)
                {
                    Console.WriteLine("[ERROR] bind() failed: " + WSAGetLastError());
                    return 1;
                }

                if (listen(listener, 5) == SOCKET_ERROR)
                {
                    Console.WriteLine("[ERROR] listen() failed: " + WSAGetLastError());
                    return 1;
                }

                Console.WriteLine("[OK] Listening. Waiting for the WSL2 vsock client...");
                Console.WriteLine("     Test from WSL2:");
                Console.WriteLine("       node wsl-vsock-echo-client.js --message \"Hello vsock\" --port " + port);
                Console.WriteLine();
                Console.WriteLine("Press Ctrl+C to stop.");

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

                while (_running)
                {
                    IntPtr client = accept(listener, IntPtr.Zero, IntPtr.Zero);
                    if (client == INVALID_SOCKET)
                    {
                        if (!_running)
                        {
                            break;
                        }
                        Console.WriteLine("[WARN] accept() failed: " + WSAGetLastError());
                        continue;
                    }

                    string id = Guid.NewGuid().ToString("N").Substring(0, 8);
                    Console.WriteLine("[" + id + "] vsock client connected");
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
                    int read = recv(client, buffer, buffer.Length, 0);
                    if (read <= 0)
                    {
                        break;
                    }

                    string message = Encoding.UTF8.GetString(buffer, 0, read).TrimEnd('\r', '\n');
                    Console.WriteLine("[" + id + "] RECV: " + message);

                    string reply = "[ECHO] " + message + "\n";
                    byte[] replyBytes = Encoding.UTF8.GetBytes(reply);
                    int sent = send(client, replyBytes, replyBytes.Length, 0);
                    if (sent == SOCKET_ERROR)
                    {
                        Console.WriteLine("[" + id + "] send() failed: " + WSAGetLastError());
                        break;
                    }
                    Console.WriteLine("[" + id + "] SENT: " + reply.TrimEnd('\n'));
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("[" + id + "] error: " + ex.Message);
            }
            finally
            {
                closesocket(client);
                Console.WriteLine("[" + id + "] disconnected");
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
                }
                Console.WriteLine("[OK] Service GUID registered under GuestCommunicationServices.");
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
