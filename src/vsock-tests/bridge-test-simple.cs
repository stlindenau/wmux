// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/*
 * Simple Bridge Test - Fixed Named Pipe Issue
 * Just focus on getting the named pipe working correctly
 */

using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace WmuxBridgeTest
{
    class SimpleBridge
    {
        private const string PIPE_NAME = "wmux-bridge-poc";
        private CancellationTokenSource _cancellationTokenSource;
        private NamedPipeServerStream _pipeServer;

        static void Main(string[] args)
        {
            Console.WriteLine("Simple Named Pipe Test Bridge");
            Console.WriteLine("============================");
            Console.WriteLine();

            var bridge = new SimpleBridge();
            bridge.Start();
        }

        public void Start()
        {
            _cancellationTokenSource = new CancellationTokenSource();

            Console.WriteLine("Starting named pipe server...");
            Console.WriteLine("Pipe name: \\\\.\\pipe\\" + PIPE_NAME);
            Console.WriteLine();

            // Handle Ctrl+C
            Console.CancelKeyPress += (sender, e) =>
            {
                e.Cancel = true;
                Console.WriteLine();
                Console.WriteLine("Shutting down...");
                _cancellationTokenSource.Cancel();
            };

            try
            {
                StartNamedPipeServer();
            }
            catch (Exception ex)
            {
                Console.WriteLine("Error: " + ex.Message);
            }
            finally
            {
                Cleanup();
            }
        }

        private void StartNamedPipeServer()
        {
            while (!_cancellationTokenSource.Token.IsCancellationRequested)
            {
                try
                {
                    Console.WriteLine("[INFO] Creating named pipe server...");

                    // Create named pipe server that stays open
                    _pipeServer = new NamedPipeServerStream(
                        PIPE_NAME,
                        PipeDirection.InOut,
                        1, // Only 1 instance for now
                        PipeTransmissionMode.Byte,
                        PipeOptions.None); // Use blocking mode for simplicity

                    Console.WriteLine("[INFO] Waiting for client connection...");

                    // Wait for client connection
                    _pipeServer.WaitForConnection();

                    Console.WriteLine("[OK] Client connected!");
                    Console.WriteLine();
                    Console.WriteLine("Listening for data... (Ctrl+C to stop)");

                    // Handle the connected client
                    HandlePipeClient();

                    Console.WriteLine("[INFO] Client disconnected");

                }
                catch (Exception ex)
                {
                    if (!_cancellationTokenSource.Token.IsCancellationRequested)
                    {
                        Console.WriteLine("[ERROR] Pipe server error: " + ex.Message);
                        Thread.Sleep(1000); // Wait before retrying
                    }
                }
                finally
                {
                    if (_pipeServer != null)
                    {
                        _pipeServer.Dispose();
                        _pipeServer = null;
                    }
                }
            }
        }

        private void HandlePipeClient()
        {
            try
            {
                using (var reader = new StreamReader(_pipeServer, Encoding.UTF8, false, 4096, true))
                using (var writer = new StreamWriter(_pipeServer, Encoding.UTF8, 4096, true))
                {
                    writer.AutoFlush = true;

                    // Send welcome message
                    writer.WriteLine("BRIDGE: Connected to simple bridge");

                    while (_pipeServer.IsConnected && !_cancellationTokenSource.Token.IsCancellationRequested)
                    {
                        // Read data from pipe client
                        string line = reader.ReadLine();
                        if (line == null) break; // Client disconnected

                        // Log received data with timestamp
                        string timestamp = DateTime.Now.ToString("HH:mm:ss.fff");
                        Console.WriteLine("[" + timestamp + "] RECEIVED: " + line);

                        // Echo back with processing info
                        string response = "[BRIDGE-ECHO] " + line + " (processed at " + timestamp + ")";
                        writer.WriteLine(response);

                        // Also log our response
                        Console.WriteLine("[" + timestamp + "] SENT BACK: " + response);
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("[ERROR] Client handling error: " + ex.Message);
            }
        }

        private void Cleanup()
        {
            if (_pipeServer != null)
            {
                _pipeServer.Dispose();
                _pipeServer = null;
            }

            Console.WriteLine("Bridge stopped.");
        }
    }
}