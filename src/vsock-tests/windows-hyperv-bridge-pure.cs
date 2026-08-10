// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/*
 * Pure AF_HYPERV to Named Pipe Bridge - NO TCP
 *
 * This bridge ONLY uses AF_HYPERV sockets - no TCP simulation
 * Requires P/Invoke to Windows socket APIs for real VSOCK
 *
 * Compile: csc /out:wmux-hyperv-bridge-pure.exe windows-hyperv-bridge-pure.cs
 */

using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace WmuxHypervBridge
{
    class HypervBridgePure
    {
        // AF_HYPERV constants
        private const int AF_HYPERV = 34;
        private const int SOCK_STREAM = 1;
        private const int IPPROTO_TCP = 6;
        private const string WMUX_SERVICE_GUID = "3049197C-FACB-11E6-BD58-64006A7986D3";
        private const string WMUX_PIPE_NAME = "wmux-bridge-poc";

        // Windows Socket API P/Invoke declarations
        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern IntPtr socket(int af, int type, int protocol);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int bind(IntPtr socket, byte[] addr, int addrlen);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int listen(IntPtr socket, int backlog);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern IntPtr accept(IntPtr socket, byte[] addr, ref int addrlen);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int recv(IntPtr socket, byte[] buf, int len, int flags);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int send(IntPtr socket, byte[] buf, int len, int flags);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int closesocket(IntPtr socket);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int WSAStartup(ushort wVersionRequested, out WSAData lpWSAData);

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int WSACleanup();

        [DllImport("ws2_32.dll", SetLastError = true)]
        private static extern int WSAGetLastError();

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

        // SOCKADDR_HV structure for AF_HYPERV
        [StructLayout(LayoutKind.Sequential)]
        private struct SOCKADDR_HV
        {
            public ushort Family;      // AF_HYPERV = 34
            public ushort Reserved;    // Must be 0
            public Guid VmId;          // VM GUID (VMADDR_CID_ANY for any VM)
            public Guid ServiceId;     // Service GUID
        }

        private CancellationTokenSource _cancellationTokenSource;
        private IntPtr _hypervSocket = IntPtr.Zero;

        // Well-known VM GUIDs
        private static readonly Guid VMADDR_CID_ANY = Guid.Empty;
        private static readonly Guid VMADDR_CID_HOST = new Guid("00000000-0000-0000-0000-000000000002");

        static void Main(string[] args)
        {
            Console.WriteLine("Pure AF_HYPERV to Named Pipe Bridge");
            Console.WriteLine("===================================");
            Console.WriteLine("NO TCP - Pure VSOCK only");
            Console.WriteLine();

            var bridge = new HypervBridgePure();

            try
            {
                bridge.StartAsync().Wait();
            }
            catch (Exception ex)
            {
                Console.WriteLine("Bridge failed: " + ex.Message);
                Environment.Exit(1);
            }
        }

        public Task StartAsync()
        {
            _cancellationTokenSource = new CancellationTokenSource();

            Console.WriteLine("Checking pure VSOCK prerequisites...");

            if (!CheckHypervSupport())
            {
                throw new Exception("Hyper-V support not available");
            }

            if (!RegisterHypervService())
            {
                throw new Exception("Failed to register AF_HYPERV service");
            }

            if (!InitializeWinsock())
            {
                throw new Exception("Failed to initialize Winsock");
            }

            Console.WriteLine("Prerequisites check passed");
            Console.WriteLine();

            // Start pure VSOCK components
            var hypervTask = StartPureHypervServerAsync();
            var namedPipeTask = StartNamedPipeServerAsync();

            Console.WriteLine("Pure VSOCK bridge is running...");
            Console.WriteLine("Connection Info:");
            Console.WriteLine("   AF_HYPERV Service GUID: " + WMUX_SERVICE_GUID);
            Console.WriteLine("   Named Pipe: \\\\.\\pipe\\" + WMUX_PIPE_NAME);
            Console.WriteLine("   Transport: Pure AF_HYPERV (NO TCP)");
            Console.WriteLine();
            Console.WriteLine("Test from WSL2 (pure VSOCK only):");
            Console.WriteLine("   node wsl-vsock-pure.js --message \"Pure VSOCK test\"");
            Console.WriteLine();
            Console.WriteLine("Press Ctrl+C to stop");

            // Handle Ctrl+C gracefully
            Console.CancelKeyPress += (sender, e) =>
            {
                e.Cancel = true;
                Console.WriteLine();
                Console.WriteLine("Shutting down pure VSOCK bridge...");
                _cancellationTokenSource.Cancel();
            };

            // Wait for shutdown
            try
            {
                Task.WaitAll(hypervTask, namedPipeTask);
            }
            catch (AggregateException)
            {
                Console.WriteLine("Pure VSOCK bridge stopped gracefully");
            }
            finally
            {
                Cleanup();
            }

            return Task.FromResult(0);
        }

        private bool CheckHypervSupport()
        {
            try
            {
                var hypervKey = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization");
                if (hypervKey == null)
                {
                    Console.WriteLine("Hyper-V not available (registry key missing)");
                    return false;
                }

                Console.WriteLine("Hyper-V registry keys found");
                return true;
            }
            catch (Exception ex)
            {
                Console.WriteLine("Hyper-V check failed: " + ex.Message);
                return false;
            }
        }

        private bool RegisterHypervService()
        {
            try
            {
                var servicePath = string.Format(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\{0}", WMUX_SERVICE_GUID);

                using (var key = Registry.LocalMachine.CreateSubKey(servicePath))
                {
                    key.SetValue("ElementName", "wmux Pure VSOCK Bridge Service");
                    Console.WriteLine("AF_HYPERV service registered: " + WMUX_SERVICE_GUID);
                    return true;
                }
            }
            catch (UnauthorizedAccessException)
            {
                Console.WriteLine("Access denied - run as Administrator");
                return false;
            }
            catch (Exception ex)
            {
                Console.WriteLine("Service registration failed: " + ex.Message);
                return false;
            }
        }

        private bool InitializeWinsock()
        {
            try
            {
                WSAData wsaData;
                int result = WSAStartup(0x0202, out wsaData); // Request Winsock 2.2

                if (result != 0)
                {
                    Console.WriteLine("WSAStartup failed: " + result);
                    return false;
                }

                Console.WriteLine("Winsock initialized (version " + wsaData.wVersion + ")");
                return true;
            }
            catch (Exception ex)
            {
                Console.WriteLine("Winsock initialization failed: " + ex.Message);
                return false;
            }
        }

        private async Task StartPureHypervServerAsync()
        {
            try
            {
                Console.WriteLine("Creating pure AF_HYPERV socket...");

                // Create AF_HYPERV socket
                _hypervSocket = socket(AF_HYPERV, SOCK_STREAM, 0);
                if (_hypervSocket == IntPtr.Zero || _hypervSocket == new IntPtr(-1))
                {
                    throw new Exception("Failed to create AF_HYPERV socket. Error: " + WSAGetLastError());
                }

                Console.WriteLine("AF_HYPERV socket created");

                // Prepare SOCKADDR_HV structure
                var addr = new SOCKADDR_HV
                {
                    Family = AF_HYPERV,
                    Reserved = 0,
                    VmId = VMADDR_CID_ANY,  // Accept from any VM
                    ServiceId = new Guid(WMUX_SERVICE_GUID)
                };

                // Convert to byte array
                int addrSize = Marshal.SizeOf(typeof(SOCKADDR_HV));
                byte[] addrBytes = new byte[addrSize];
                IntPtr ptr = Marshal.AllocHGlobal(addrSize);
                try
                {
                    Marshal.StructureToPtr(addr, ptr, false);
                    Marshal.Copy(ptr, addrBytes, 0, addrSize);
                }
                finally
                {
                    Marshal.FreeHGlobal(ptr);
                }

                // Bind socket
                if (bind(_hypervSocket, addrBytes, addrSize) != 0)
                {
                    throw new Exception("Failed to bind AF_HYPERV socket. Error: " + WSAGetLastError());
                }

                Console.WriteLine("AF_HYPERV socket bound to service GUID");

                // Listen for connections
                if (listen(_hypervSocket, 5) != 0)
                {
                    throw new Exception("Failed to listen on AF_HYPERV socket. Error: " + WSAGetLastError());
                }

                Console.WriteLine("Pure AF_HYPERV server listening (NO TCP)");

                // Accept connections loop
                while (!_cancellationTokenSource.Token.IsCancellationRequested)
                {
                    await Task.Run(() =>
                    {
                        try
                        {
                            int clientAddrSize = Marshal.SizeOf(typeof(SOCKADDR_HV));
                            byte[] clientAddr = new byte[clientAddrSize];

                            IntPtr clientSocket = accept(_hypervSocket, clientAddr, ref clientAddrSize);
                            if (clientSocket != IntPtr.Zero && clientSocket != new IntPtr(-1))
                            {
                                Console.WriteLine("Pure VSOCK client connected");
                                // Handle client in background
                                Task.Run(() => HandlePureHypervClientAsync(clientSocket));
                            }
                        }
                        catch (Exception ex)
                        {
                            if (!_cancellationTokenSource.Token.IsCancellationRequested)
                            {
                                Console.WriteLine("Accept error: " + ex.Message);
                            }
                        }
                    }, _cancellationTokenSource.Token);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Pure AF_HYPERV server error: " + ex.Message);
                Console.WriteLine("Note: This requires real AF_HYPERV implementation");
                Console.WriteLine("Current status: Proof of concept - may need native implementation");
            }
        }

        private async Task HandlePureHypervClientAsync(IntPtr clientSocket)
        {
            var clientId = Guid.NewGuid().ToString("N").Substring(0, 8);
            Console.WriteLine("Handling pure VSOCK client: " + clientId);

            try
            {
                byte[] buffer = new byte[4096];

                while (!_cancellationTokenSource.Token.IsCancellationRequested)
                {
                    int bytesRead = recv(clientSocket, buffer, buffer.Length, 0);
                    if (bytesRead <= 0) break;

                    string message = Encoding.UTF8.GetString(buffer, 0, bytesRead).Trim();
                    Console.WriteLine("Pure VSOCK received from " + clientId + ": " + message);

                    // Relay to named pipe
                    await RelayToNamedPipeAsync(message, clientId);

                    // Send response back via pure VSOCK
                    string response = string.Format("{{\"status\":\"pure-vsock-relayed\",\"client\":\"{0}\",\"transport\":\"AF_HYPERV\"}}",
                        clientId);
                    byte[] responseBytes = Encoding.UTF8.GetBytes(response + "\n");
                    send(clientSocket, responseBytes, responseBytes.Length, 0);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Pure VSOCK client error " + clientId + ": " + ex.Message);
            }
            finally
            {
                closesocket(clientSocket);
                Console.WriteLine("Pure VSOCK client disconnected: " + clientId);
            }
        }

        private async Task RelayToNamedPipeAsync(string message, string clientId)
        {
            try
            {
                using (var pipeClient = new NamedPipeClientStream(".", WMUX_PIPE_NAME, PipeDirection.InOut))
                {
                    await pipeClient.ConnectAsync(1000);

                    using (var writer = new StreamWriter(pipeClient, Encoding.UTF8))
                    {
                        var relayMessage = string.Format("[PURE-VSOCK:{0}] {1}", clientId, message);
                        await writer.WriteLineAsync(relayMessage);
                        await writer.FlushAsync();
                    }

                    Console.WriteLine("Relayed pure VSOCK message to named pipe: " + message);
                }
            }
            catch (TimeoutException)
            {
                Console.WriteLine("Named pipe connection timeout - no wmux server running?");
            }
            catch (Exception ex)
            {
                Console.WriteLine("Named pipe relay failed: " + ex.Message);
            }
        }

        private async Task StartNamedPipeServerAsync()
        {
            try
            {
                Console.WriteLine("Named pipe server starting: \\\\.\\pipe\\" + WMUX_PIPE_NAME);

                while (!_cancellationTokenSource.Token.IsCancellationRequested)
                {
                    using (var pipeServer = new NamedPipeServerStream(
                        WMUX_PIPE_NAME,
                        PipeDirection.InOut,
                        NamedPipeServerStream.MaxAllowedServerInstances,
                        PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous))
                    {
                        Console.WriteLine("Named pipe waiting for connection...");

                        await pipeServer.WaitForConnectionAsync(_cancellationTokenSource.Token);
                        Console.WriteLine("Named pipe client connected");

                        var clientTask = HandleNamedPipeClientAsync(pipeServer);
                    }
                }
            }
            catch (Exception ex)
            {
                if (!(ex is OperationCanceledException))
                {
                    Console.WriteLine("Named pipe server error: " + ex.Message);
                }
            }
        }

        private async Task HandleNamedPipeClientAsync(NamedPipeServerStream pipeServer)
        {
            try
            {
                using (var reader = new StreamReader(pipeServer, Encoding.UTF8))
                {
                    string line;
                    while ((line = await reader.ReadLineAsync()) != null && !_cancellationTokenSource.Token.IsCancellationRequested)
                    {
                        Console.WriteLine("Named pipe received: " + line);
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Named pipe client error: " + ex.Message);
            }
            finally
            {
                Console.WriteLine("Named pipe client disconnected");
            }
        }

        private void Cleanup()
        {
            if (_hypervSocket != IntPtr.Zero)
            {
                closesocket(_hypervSocket);
                _hypervSocket = IntPtr.Zero;
            }

            WSACleanup();
            Console.WriteLine("Pure VSOCK bridge cleanup completed");
        }
    }
}