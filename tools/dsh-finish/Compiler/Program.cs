using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Locus.CompileServer;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Locus.DshFinish.Compiler;

/// <summary>
/// Entry point of the dsh-finish compile sidecar.
///
/// Two run modes:
/// <list type="bullet">
/// <item><c>dotnet DshFinishCompileServer.dll</c> — Content-Length framed
/// JSON-RPC over stdin/stdout, the same framing upstream Locus uses, so the
/// Node side can reuse a single transport for both.</item>
/// <item><c>--selftest</c> — compile a snippet and assert its diagnostics
/// in-process, then exit. This is the only self-check that runs on a machine
/// without Unity, so it is what CI and a fresh checkout should call.</item>
/// </list>
///
/// Robustness rules inherited from upstream: a request never takes the loop
/// down (each is dispatched on its own task and every exception becomes a
/// -32603 response), responses and notifications from the peer are ignored,
/// and any malformed body is answered with -32700 instead of killing the pipe.
/// </summary>
public static class Program
{
    /// <summary>
    /// Bumped whenever the sidecar's request/response shapes change. The Node
    /// side refuses a server whose version it does not know, which turns a
    /// stale build on disk into one clear error instead of confusing results.
    /// </summary>
    public const int ProtocolVersion = 1;

    /// <summary>Name reported by <c>initialize</c>.</summary>
    public const string ServerName = "DshFinishCompileServer";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = false,
    };

    public static int Main(string[] args)
    {
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;

        foreach (string arg in args)
        {
            if (string.Equals(arg, "--selftest", StringComparison.OrdinalIgnoreCase))
            {
                return SelfTest.Run();
            }
        }

        using Stream input = Console.OpenStandardInput();
        using Stream output = Console.OpenStandardOutput();
        var transport = new StdioTransport(input, output);
        var server = new DshFinishServer(transport);
        server.Run();
        return 0;
    }
}

/// <summary>
/// The request loop. Split from <see cref="Program"/> so the loop can be
/// exercised by a self-test over in-memory streams without touching the
/// process's real stdin/stdout.
/// </summary>
public sealed class DshFinishServer
{
    /// <summary>Roslyn version, reported by <c>initialize</c> for diagnostics.</summary>
    public static readonly string RoslynVersion =
        typeof(CSharpCompilation).Assembly.GetName().Version?.ToString() ?? "unknown";

    private readonly StdioTransport _transport;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Dictionary<long, CancellationTokenSource> _inflight = new();
    private readonly object _inflightLock = new();
    private readonly object _dispatchLock = new();
    private readonly List<Task> _dispatches = new();
    private readonly JsonSerializerOptions _jsonOptions = new() { WriteIndented = false };
    private long _snippetCounter;

    public DshFinishServer(StdioTransport transport)
    {
        _transport = transport;
    }

    /// <summary>The server's own assembly path — used by the Node side to verify a build.</summary>
    public static string ServerAssemblyPath => typeof(Program).Assembly.Location;

    /// <summary>Read-dispatch-write until EOF, <c>shutdown</c>, or <c>exit</c>.</summary>
    public void Run()
    {
        while (true)
        {
            byte[]? body;
            try
            {
                body = _transport.ReadMessage();
            }
            catch (Exception ex)
            {
                // A broken frame is unrecoverable: the stream position is lost,
                // so report once and stop rather than emitting garbage forever.
                Console.Error.WriteLine("dsh-finish compile server: bad frame: " + ex.Message);
                return;
            }

            if (body == null)
                return; // EOF: the peer closed stdin.

            JsonNode? node;
            try
            {
                node = JsonNode.Parse(Encoding.UTF8.GetString(body));
            }
            catch (JsonException ex)
            {
                Console.Error.WriteLine("dsh-finish compile server: invalid JSON: " + ex.Message);
                Send(ErrorResponse(null, -32700, "parse error: " + ex.Message));
                continue;
            }

            if (node is not JsonObject message)
                continue;

            // Responses (`id` + `result`/`error`, no `method`) are not ours to
            // handle: this sidecar never sends requests, so they are dropped.
            string? method = message["method"]?.GetValue<string>();
            if (method == null)
                continue;

            JsonNode? idNode = message["id"];
            long id = idNode?.GetValue<long>() ?? 0;
            JsonObject? paramsNode = message["params"] as JsonObject;

            if (method == "exit")
            {
                // `exit` is a stop request, not a cancel: the peer expects the
                // answers to everything it already asked for, so the loop stops
                // reading and waits for those dispatches before returning.
                break;
            }

            if (method == "$/cancelRequest")
            {
                Cancel(id);
                continue;
            }

            Task dispatch = Task.Run(() => Dispatch(id, method, paramsNode));
            lock (_dispatchLock)
            {
                _dispatches.Add(dispatch);
            }

            _ = dispatch.ContinueWith(
                completed =>
                {
                    lock (_dispatchLock)
                    {
                        _dispatches.Remove(completed);
                    }
                },
                TaskScheduler.Default);
        }

        CancelAll();
        DrainDispatches();
    }

    /// <summary>Wait (bounded) for in-flight requests so their answers are written.</summary>
    private void DrainDispatches()
    {
        Task[] pending;
        lock (_dispatchLock)
        {
            pending = _dispatches.ToArray();
        }

        if (pending.Length == 0)
            return;

        try
        {
            Task.WaitAll(pending, TimeSpan.FromSeconds(30));
        }
        catch (AggregateException)
        {
            // Dispatch already turned every failure into an error response.
        }
    }

    private void Dispatch(long id, string method, JsonObject? parameters)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
        lock (_inflightLock)
        {
            _inflight[id] = cts;
        }

        try
        {
            JsonNode? result = method switch
            {
                "initialize" => HandleInitialize(),
                "shutdown" => HandleShutdown(),
                "compile/snippet" => HandleCompileSnippet(parameters),
                "compile/runStates" => HandleCompileRunStates(parameters),
                "compile/params" => HandleCompileParams(parameters),
                "analyze/hotDiff" => HandleAnalyzeHotDiff(parameters),
                "compile/hotPatch" => HandleCompileHotPatch(parameters),
                _ => throw new RpcMethodNotFoundException("method not found: " + method),
            };

            Send(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = result });
        }
        catch (RpcMethodNotFoundException ex)
        {
            Send(ErrorResponse(id, -32601, ex.Message));
        }
        catch (RpcInvalidParamsException ex)
        {
            Send(ErrorResponse(id, -32602, ex.Message));
        }
        catch (OperationCanceledException)
        {
            if (!cts.IsCancellationRequested)
                Send(ErrorResponse(id, -32603, "internal error in " + method + ": cancelled"));
        }
        catch (Exception ex)
        {
            Send(ErrorResponse(id, -32603, "internal error in " + method + ": " + ex.Message));
        }
        finally
        {
            lock (_inflightLock)
            {
                _inflight.Remove(id);
            }

            cts.Dispose();
        }
    }

    private JsonObject HandleInitialize() => new()
    {
        ["serverName"] = Program.ServerName,
        ["protocolVersion"] = Program.ProtocolVersion,
        ["roslynVersion"] = DshFinishServer.RoslynVersion,
        ["targetFramework"] = "net10.0",
        ["pid"] = Environment.ProcessId,
        ["capabilities"] = new JsonArray(
            "compile/snippet",
            "compile/runStates",
            "compile/params",
            "analyze/hotDiff",
            "compile/hotPatch"),
    };

    private JsonNode HandleShutdown()
    {
        CancelAll();
        return new JsonObject { ["ok"] = true };
    }

    private JsonObject HandleCompileSnippet(JsonObject? parameters)
    {
        string? code = RequiredString(parameters, "code");
        string? mode = OptionalString(parameters, "mode");
        string? projectRoot = OptionalString(parameters, "project_root");

        var references = new List<string>();
        if (parameters?["references"] is JsonArray referenceArray)
        {
            foreach (JsonNode? item in referenceArray)
            {
                if (item is JsonObject referenceObject)
                {
                    string? path = referenceObject["path"]?.GetValue<string>();
                    if (!string.IsNullOrWhiteSpace(path))
                        references.Add(path);
                }
                else if (item != null)
                {
                    string? path = item.GetValue<string>();
                    if (!string.IsNullOrWhiteSpace(path))
                        references.Add(path);
                }
            }
        }

        bool loopGuard = OptionalBool(parameters, "loop_guard") ?? false;
        string assemblyName = "__DshSnippet_" + Interlocked.Increment(ref _snippetCounter);

        return SnippetCompiler.Compile(code!, mode, projectRoot, references, loopGuard, assemblyName);
    }

    private JsonObject HandleCompileRunStates(JsonObject? parameters)
    {
        RunStatesRequest? request;
        try
        {
            request = parameters == null
                ? null
                : parameters.Deserialize<RunStatesRequest>(_jsonOptions);
        }
        catch (JsonException ex)
        {
            throw new RpcInvalidParamsException("invalid run_states request: " + ex.Message);
        }

        string? validationError = RunStatesSource.ValidateRunStatesRequest(request);
        if (validationError != null)
            throw new RpcInvalidParamsException(validationError);

        string source = RunStatesSource.BuildRunStatesSource(request!);
        string? projectRoot = OptionalString(parameters, "project_root");

        // The host already has the external state-machine wrapper, so it is
        // compiled directly instead of being wrapped again as a snippet body.
        JsonObject result = SnippetCompiler.CompileUnit(
            source,
            RunStatesSource.SourcePath,
            projectRoot,
            extraReferences: null,
            assemblyName: "__DshRunStates_" + Interlocked.Increment(ref _snippetCounter));

        result["source_kind"] = "run_states";
        result["initial_state"] = request!.InitialState;
        result["state_count"] = request.States?.Length ?? 0;
        return result;
    }

    /// <summary>
    /// The references/defines/langversion a compile of this project would use.
    /// Served from disk, so it answers with the editor closed.
    /// </summary>
    private JsonNode HandleCompileParams(JsonObject? parameters) =>
        ProjectFacts.CompileParams(OptionalString(parameters, "project_root"));

    /// <summary>
    /// Classify a batch of edits as hot-patchable. Analysis only: nothing is
    /// compiled, so a cold verdict costs no memory in the running editor.
    /// </summary>
    private JsonNode HandleAnalyzeHotDiff(JsonObject? parameters)
    {
        JsonArray? files = parameters?["files"] as JsonArray;
        if (files == null)
            throw new RpcInvalidParamsException("analyze/hotDiff needs a files array");
        return ProjectFacts.AnalyzeHotDiff(files, OptionalString(parameters, "project_root"));
    }

    /// <summary>
    /// Compile a patch assembly for the given edits.
    ///
    /// The patch is compiled body-only: each changed member is re-emitted under
    /// a <c>__DshPatch_*</c> type with the original signature, so the patcher can
    /// swap the method body at runtime without touching object layouts. What it
    /// cannot do — add types or fields to the running domain — is refused here
    /// rather than half-applied in Unity.
    /// </summary>
    private JsonNode HandleCompileHotPatch(JsonObject? parameters)
    {
        JsonArray? files = parameters?["files"] as JsonArray;
        if (files == null || files.Count == 0)
            throw new RpcInvalidParamsException("compile/hotPatch needs a non-empty files array");

        string? projectRoot = OptionalString(parameters, "project_root");
        JsonObject analysis = ProjectFacts.AnalyzeHotDiff(files, projectRoot);
        if (analysis["hot"]?.GetValue<bool>() != true)
        {
            return new JsonObject
            {
                ["ok"] = false,
                ["error"] = "the edits are not all hot-patchable; a recompile is required",
                ["diagnostics"] = new JsonArray(),
                ["methods"] = new JsonArray(),
                ["analysis"] = analysis,
            };
        }

        var edits = new List<PatchEdit>();
        foreach (JsonNode? node in files)
        {
            if (node is not JsonObject file)
                throw new RpcInvalidParamsException("each files[] entry must be an object");
            edits.Add(new PatchEdit(
                file["path"]?.GetValue<string>() ?? string.Empty,
                file["oldText"]?.GetValue<string>() ?? string.Empty,
                file["newText"]?.GetValue<string>() ?? string.Empty));
        }

        string assemblyName = "__DshPatch_" + Interlocked.Increment(ref _snippetCounter);
        JsonObject result = PatchCompiler.Compile(edits, projectRoot, assemblyName);
        result["analysis"] = analysis;
        return result;
    }

    private static string? RequiredString(JsonObject? parameters, string name)
    {
        JsonNode? node = parameters?[name];
        if (node == null)
            throw new RpcInvalidParamsException("missing required parameter: " + name);

        string? value = node.GetValue<string>();
        if (value == null)
            throw new RpcInvalidParamsException("parameter must be a string: " + name);
        return value;
    }

    private static string? OptionalString(JsonObject? parameters, string name)
    {
        JsonNode? node = parameters?[name];
        if (node == null)
            return null;
        return node.GetValue<string>();
    }

    private static bool? OptionalBool(JsonObject? parameters, string name)
    {
        JsonNode? node = parameters?[name];
        if (node == null)
            return null;
        return node.GetValue<bool>();
    }

    private void Cancel(long id)
    {
        CancellationTokenSource? cts;
        lock (_inflightLock)
        {
            _inflight.TryGetValue(id, out cts);
        }

        try
        {
            cts?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The request finished between the lookup and the cancel.
        }
    }

    private void CancelAll()
    {
        CancellationTokenSource[] pending;
        lock (_inflightLock)
        {
            pending = _inflight.Values.ToArray();
        }

        foreach (CancellationTokenSource cts in pending)
        {
            try
            {
                cts.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // Already completed.
            }
        }

        try
        {
            _shutdown.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Already disposed.
        }
    }

    private void Send(JsonObject message)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(message.ToJsonString(_jsonOptions));
        _transport.WriteMessage(bytes);
    }

    private static JsonObject ErrorResponse(long? id, int code, string message) => new()
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id,
        ["error"] = new JsonObject
        {
            ["code"] = code,
            ["message"] = message,
        },
    };
}

/// <summary>Raised for an unknown method; maps to JSON-RPC -32601.</summary>
public sealed class RpcMethodNotFoundException : Exception
{
    public RpcMethodNotFoundException(string message) : base(message)
    {
    }
}