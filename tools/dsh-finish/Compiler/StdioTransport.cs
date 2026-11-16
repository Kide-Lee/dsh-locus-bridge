// Derived from upstream Locus: Locus/locus_compile_server/StdioTransport.cs
// (https://github.com/r1n7aro/Locus, commit 4ee37ed0, v0.9.3).
//
// Copyright (c) the Locus authors. Licensed under the GNU General Public
// License, version 3 or later — the same license as dsh-locus-bridge. This
// copy is **unmodified** apart from this header: the Content-Length framing is
// a wire contract with src/csharp/sidecar.js, which reuses the `LspReader` /
// `encodeLspMessage` helpers from src/csharp/lsp-protocol.js to speak it.
//
// See NOTICE ("Files derived from Locus") for the attribution record.

using System.Text;

namespace Locus.CompileServer;

/// <summary>
/// Content-Length framed message transport over raw stdio streams, the same
/// framing the LSP (and Locus' csharp_lsp client) uses.
/// </summary>
public sealed class StdioTransport
{
    private readonly Stream _input;
    private readonly Stream _output;
    private readonly object _writeLock = new();
    private readonly object _readLock = new();

    public StdioTransport(Stream input, Stream output)
    {
        _input = input;
        _output = output;
    }

    /// <summary>
    /// Read one framed message body; null when the stream ends.
    ///
    /// The lock is not upstream's: upstream only ever reads from the single
    /// loop, while this sidecar also drives the transport from a self-test
    /// harness. Framing is stateful, so two concurrent readers would split one
    /// body between them and corrupt the stream.
    /// </summary>
    public byte[]? ReadMessage()
    {
        lock (_readLock)
        {
            return ReadMessageCore();
        }
    }

    private byte[]? ReadMessageCore()
    {
        int contentLength = -1;
        while (true)
        {
            string? line = ReadHeaderLine();
            if (line == null)
                return null;
            if (line.Length == 0)
                break;
            int colon = line.IndexOf(':');
            if (colon <= 0)
                continue;
            string name = line[..colon].Trim();
            if (name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase) &&
                int.TryParse(line[(colon + 1)..].Trim(), out int parsed))
            {
                contentLength = parsed;
            }
        }

        if (contentLength < 0)
            return null;

        var body = new byte[contentLength];
        int read = 0;
        while (read < contentLength)
        {
            int n = _input.Read(body, read, contentLength - read);
            if (n <= 0)
                return null;
            read += n;
        }
        return body;
    }

    public void WriteMessage(byte[] body)
    {
        var header = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n");
        lock (_writeLock)
        {
            _output.Write(header, 0, header.Length);
            _output.Write(body, 0, body.Length);
            _output.Flush();
        }
    }

    private string? ReadHeaderLine()
    {
        var sb = new StringBuilder(32);
        while (true)
        {
            int b = _input.ReadByte();
            if (b < 0)
                return sb.Length == 0 ? null : sb.ToString();
            if (b == '\n')
                return sb.ToString().TrimEnd('\r');
            sb.Append((char)b);
        }
    }
}

/// <summary>Thrown by handlers when the request payload is malformed.</summary>
public sealed class RpcInvalidParamsException : Exception
{
    public RpcInvalidParamsException(string message) : base(message) { }
}
