// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/*
 * Windows AF_HYPERV to Named Pipe Bridge - C# 5 Compatible PoC
 *
 * Compatible with .NET Framework 4.0+ / C# 5
 * No string interpolation or modern C# features
 *
 * Compile: csc /out:wmux-hyperv-bridge.exe windows-hyperv-bridge-cs5.cs
 * Run: .\wmux-hyperv-bridge.exe
 */

using System;
using System.IO;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace WmuxHypervBridge
{
    class HypervBridge
    {
        // Constants for AF_HYPERV
        private const int AF_HYPERV = 34;
        private const string WMUX_SERVICE_GUID = "3049197C-FACB-11E6-BD58-64006A7986D3";
        private const string WMUX_PIPE_NAME = "wmux-bridge-poc";

        private CancellationTokenSource _cancellationTokenSource;
        private bool _isRunning = false;

        static void Main(string[] args)
        {
            Console.WriteLine("wmux AF_HYPERV to Named Pipe Bridge - PoC (C# 5)");
            Console.WriteLine("=================================================");
            Console.WriteLine();

            var bridge = new HypervBridge();

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

            Console.WriteLine("Checking prerequisites...");

            if (!CheckHypervSupport())
            {
                throw new Exception("Hyper-V support not available");
            }

            if (!RegisterHypervService())
            {
                throw new Exception("Failed to register Hyper-V service");
            }

            Console.WriteLine("Prerequisites check passed");
            Console.WriteLine();

            // Start the bridge components
            var hypervTask = StartHypervServerAsync();
            var namedPipeTask = StartNamedPipeServerAsync();

            Console.WriteLine("Bridge is running...");
            Console.WriteLine("Connection Info:");
            Console.WriteLine("   AF_HYPERV Service GUID: " + WMUX_SERVICE_GUID);
            Console.WriteLine("   Named Pipe: \\\\.\\pipe\\" + WMUX_PIPE_NAME);
            Console.WriteLine();
            Console.WriteLine("Test from WSL2:");
            Console.WriteLine("   node wsl-vsock-client.js --message \"Hello Bridge!\"");
            Console.WriteLine();
            Console.WriteLine("Test named pipe (from Windows):");
            Console.WriteLine("   Use PowerShell named pipe client test");
            Console.WriteLine();
            Console.WriteLine("Press Ctrl+C to stop");

            // Handle Ctrl+C gracefully
            Console.CancelKeyPress += (sender, e) =>
            {
                e.Cancel = true;
                Console.WriteLine();
                Console.WriteLine("Shutting down bridge...");
                _cancellationTokenSource.Cancel();
            };

            _isRunning = true;

            // Wait for shutdown
            try
            {
                Task.WaitAll(hypervTask, namedPipeTask);
            }
            catch (AggregateException)
            {
                Console.WriteLine("Bridge stopped gracefully");
            }

            return Task.FromResult(0);
        }

        private bool CheckHypervSupport()
        {
            try
            {
                // Check if Hyper-V is available (simplified check)
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
                    key.SetValue("ElementName", "wmux Bridge PoC Service");
                    Console.WriteLine("AF_HYPERV service registered: " + WMUX_SERVICE_GUID);
                    return true;
                }
            }
            catch (UnauthorizedAccessException)
            {
                Console.WriteLine("Access denied - run as Administrator to register AF_HYPERV service");
                return false;
            }
            catch (Exception ex)
            {
                Console.WriteLine("Service registration failed: " + ex.Message);
                return false;
            }
        }

        private async Task StartHypervServerAsync()
        {
            try
            {
                Console.WriteLine("AF_HYPERV server: Using TCP simulation (real implementation needs native code)");

                // Simulate AF_HYPERV with TCP for PoC
                var tcpListener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 9787);
                tcpListener.Start();

                Console.WriteLine("AF_HYPERV server listening (TCP simulation on 127.0.0.1:9787)");

                while (!_cancellationTokenSource.Token.IsCancellationRequested)
                {
                    var tcpClient = await AcceptClientAsync(tcpListener, _cancellationTokenSource.Token);
                    if (tcpClient != null)
                    {
                        var clientTask = HandleHypervClientAsync(tcpClient);
                        // Don't await - handle clients concurrently
                    }
                }

                tcpListener.Stop();
            }
            catch (Exception ex)
            {
                if (!(ex is OperationCanceledException))
                {
                    Console.WriteLine("AF_HYPERV server error: " + ex.Message);
                }
                else
                {
                    Console.WriteLine("AF_HYPERV server stopped");
                }
            }
        }

        private async Task<System.Net.Sockets.TcpClient> AcceptClientAsync(System.Net.Sockets.TcpListener listener, CancellationToken cancellationToken)
        {
            try
            {
                var tcpClient = await listener.AcceptTcpClientAsync();
                return tcpClient;
            }
            catch (ObjectDisposedException)
            {
                return null; // Listener was stopped
            }
        }

        private async Task HandleHypervClientAsync(System.Net.Sockets.TcpClient hypervClient)
        {
            var clientId = Guid.NewGuid().ToString("N").Substring(0, 8);
            Console.WriteLine("AF_HYPERV client connected: " + clientId);

            try
            {
                using (hypervClient)
                {
                    var stream = hypervClient.GetStream();
                    var buffer = new byte[4096];

                    while (hypervClient.Connected && !_cancellationTokenSource.Token.IsCancellationRequested)
                    {
                        var bytesRead = await stream.ReadAsync(buffer, 0, buffer.Length, _cancellationTokenSource.Token);
                        if (bytesRead == 0) break;

                        var message = Encoding.UTF8.GetString(buffer, 0, bytesRead).Trim();
                        Console.WriteLine("Received from " + clientId + ": " + message);

                        // Relay to named pipe
                        await RelayToNamedPipeAsync(message, clientId);

                        // Echo response back to client
                        var response = string.Format("{{\"status\":\"relayed\",\"client\":\"{0}\",\"timestamp\":\"{1}\"}}",
                            clientId,
                            DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"));
                        var responseBytes = Encoding.UTF8.GetBytes(response + "\n");
                        await stream.WriteAsync(responseBytes, 0, responseBytes.Length, _cancellationTokenSource.Token);
                        await stream.FlushAsync(_cancellationTokenSource.Token);
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Error handling client " + clientId + ": " + ex.Message);
            }
            finally
            {
                Console.WriteLine("AF_HYPERV client disconnected: " + clientId);
            }
        }

        private async Task RelayToNamedPipeAsync(string message, string clientId)
        {
            try
            {
                using (var pipeClient = new NamedPipeClientStream(".", WMUX_PIPE_NAME, PipeDirection.InOut))
                {
                    await pipeClient.ConnectAsync(1000); // 1 second timeout

                    using (var writer = new StreamWriter(pipeClient, Encoding.UTF8))
                    {
                        var relayMessage = string.Format("[HYPERV:{0}] {1}", clientId, message);
                        await writer.WriteLineAsync(relayMessage);
                        await writer.FlushAsync();
                    }

                    Console.WriteLine("Relayed to named pipe: " + message);
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
                        // Don't await - handle clients concurrently
                    }
                }
            }
            catch (Exception ex)
            {
                if (!(ex is OperationCanceledException))
                {
                    Console.WriteLine("Named pipe server error: " + ex.Message);
                }
                else
                {
                    Console.WriteLine("Named pipe server stopped");
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

                        // In a real implementation, this would relay back to AF_HYPERV clients
                        // For PoC, we just log it
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
    }
}