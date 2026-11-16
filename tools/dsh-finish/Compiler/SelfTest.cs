using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Locus.DshFinish.Compiler;

/// <summary>
/// In-process self-test, run by <c>dotnet run --project tools/dsh-finish/Compiler -- --selftest</c>.
///
/// It exists because this machine (and CI, and a fresh checkout) has no Unity
/// editor: without a self-test, the only way to learn whether the sidecar works
/// would be to start a full Unity session. Everything here runs against the
/// host .NET reference set, so it proves Roslyn is wired up, the wrappers and
/// <c>#line</c> mapping behave, the loop guard injects, and the JSON-RPC loop
/// answers — none of which needs the editor.
///
/// Attribution note: the <c>#line</c>-mapping assertion shape (a diagnostic at
/// snippet line N, not wrapper line N+k) mirrors how upstream Locus' compile
/// server verifies its own snippet wrapper in its tests.
///
/// Exit code 0 means every check passed; 1 means at least one failed and the
/// failing check names were printed.
/// </summary>
public static class SelfTest
{
    private static int _passed;
    private static readonly List<string> Failures = new();

    public static int Run()
    {
        Console.WriteLine("dsh-finish compile server self-test");
        Console.WriteLine("  roslyn:  " + DshFinishServer.RoslynVersion);
        Console.WriteLine("  runtime: " + Environment.Version);
        Console.WriteLine();

        var stopwatch = Stopwatch.StartNew();
        try
        {
            CheckStatementSnippetCompiles();
            CheckExpressionSnippetCompiles();
            CheckDiagnosticMapsToSnippetLine();
            CheckUnresolvedTypeIsReported();
            CheckLeadingUsingsAreHoisted();
            CheckLoopGuardInjects();
            CheckRunStatesValidation();
            CheckRunStatesSourceGeneration();
            CheckRpcLoop();
        }
        catch (Exception ex)
        {
            Failures.Add("self-test threw: " + ex);
        }

        stopwatch.Stop();
        Console.WriteLine();
        Console.WriteLine($"  {_passed} passed, {Failures.Count} failed, {stopwatch.ElapsedMilliseconds} ms");

        if (Failures.Count == 0)
        {
            Console.WriteLine("SELFTEST OK");
            return 0;
        }

        foreach (string failure in Failures)
            Console.WriteLine("  FAILED: " + failure);
        Console.WriteLine("SELFTEST FAILED");
        return 1;
    }

    private static void Check(string name, Action body)
    {
        try
        {
            body();
            _passed++;
            Console.WriteLine("  ok    " + name);
        }
        catch (Exception ex)
        {
            Failures.Add(name + ": " + ex.Message);
            Console.WriteLine("  FAIL  " + name + ": " + ex.Message);
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }

    private static JsonObject Compile(string code, string? mode = null, bool loopGuard = false) =>
        SnippetCompiler.Compile(code, mode, projectRoot: null, extraReferences: null, loopGuard, "__SelfTestSnippet");

    private static JsonObject? FirstDiagnostic(JsonObject result, string severity)
    {
        if (result["diagnostics"] is not JsonArray diagnostics)
            return null;
        foreach (JsonNode? item in diagnostics)
        {
            if (item?["severity"]?.GetValue<string>() == severity)
                return item!.AsObject();
        }
        return null;
    }

    private static void CheckStatementSnippetCompiles() => Check("compile: statement snippet", () =>
    {
        JsonObject result = Compile("var total = 1 + 2;\nprint(total);");
        Assert(result["ok"]?.GetValue<bool>() == true, "expected ok=true, got " + result.ToJsonString());
        Assert(FirstDiagnostic(result, "error") == null, "expected no error diagnostics");
        string? assembly = result["assembly_b64"]?.GetValue<string>();
        Assert(!string.IsNullOrEmpty(assembly), "expected assembly_b64");
        byte[] bytes = Convert.FromBase64String(assembly!);
        Assert(bytes.Length > 2 && bytes[0] == (byte)'M' && bytes[1] == (byte)'Z', "expected a PE image");
        Assert(result["expression_mode"]?.GetValue<bool>() == false, "expected expression_mode=false");
    });

    private static void CheckExpressionSnippetCompiles() => Check("compile: expression snippet", () =>
    {
        JsonObject result = Compile("40 + 2");
        Assert(result["ok"]?.GetValue<bool>() == true, "expected ok=true, got " + result.ToJsonString());
        Assert(result["expression_mode"]?.GetValue<bool>() == true, "expected expression_mode=true");
    });

    private static void CheckDiagnosticMapsToSnippetLine() => Check("diagnostics: #line maps to the snippet, not the wrapper", () =>
    {
        // Line 1 is fine, line 2 references an undefined name.
        JsonObject result = Compile("var first = 1;\nvar second = undefinedName;");
        Assert(result["ok"]?.GetValue<bool>() == false, "expected ok=false");
        JsonObject? error = FirstDiagnostic(result, "error");
        Assert(error != null, "expected an error diagnostic");
        Assert(error!["id"]?.GetValue<string>() == "CS0103", "expected CS0103, got " + error["id"]);
        Assert(error["line"]?.GetValue<int>() == 2, "expected line 2, got " + error["line"]);
        Assert(error["message"]?.GetValue<string>()?.Contains("undefinedName") == true, "message should name the identifier");
        Assert(result["error"]?.GetValue<string>()?.StartsWith("compilation failed:") == true, "expected the shared error framing");
    });

    private static void CheckUnresolvedTypeIsReported() => Check("diagnostics: unknown namespace is reported", () =>
    {
        JsonObject result = Compile("var x = UnityEditor.EditorApplication.isPlaying;");
        Assert(result["ok"]?.GetValue<bool>() == false, "expected ok=false");
        JsonObject? error = FirstDiagnostic(result, "error");
        Assert(error != null, "expected an error diagnostic");
        string id = error!["id"]?.GetValue<string>() ?? "";
        Assert(id is "CS0103" or "CS0246", "expected CS0103/CS0246, got " + id);
        Assert(error["line"]?.GetValue<int>() == 1, "expected line 1, got " + error["line"]);
    });

    private static void CheckLeadingUsingsAreHoisted() => Check("compile: leading usings are hoisted", () =>
    {
        JsonObject result = Compile("using System.Text;\nvar sb = new StringBuilder();\nsb.Append(\"hi\");\nprint(sb.ToString());");
        Assert(result["ok"]?.GetValue<bool>() == true, "expected ok=true, got " + result.ToJsonString());
    });

    private static void CheckLoopGuardInjects() => Check("loop guard: applied without changing the snippet's lines", () =>
    {
        JsonObject plain = Compile("for (var i = 0; i < 3; i++) { }\nprint(42);");
        JsonObject guarded = Compile("for (var i = 0; i < 3; i++) { }\nprint(42);", loopGuard: true);
        Assert(guarded["ok"]?.GetValue<bool>() == plain["ok"]?.GetValue<bool>(), "loop guard changed the compile outcome");
        Assert(guarded["ok"]?.GetValue<bool>() == true, "guarded snippet should compile, got " + guarded.ToJsonString());

        string host = SnippetSource.PlainHostTypeName;
        string source = SnippetSource.BuildStandaloneSource("", "for (var i = 0; i < 3; i++) { }", false);
        Microsoft.CodeAnalysis.SyntaxTree tree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(source);
        Microsoft.CodeAnalysis.SyntaxTree applied = Locus.LocusSnippetLoopGuard.Apply(tree, host);
        Assert(applied != tree, "loop guard should return a guarded tree");
        string text = applied.ToString();
        Assert(text.Contains("__locusLoopCancel"), "guarded source should reference the cancel field");
        Assert(text.Contains("public static volatile int __locusLoopCancel;"), "guarded source should declare the cancel field");
    });

    private static void CheckRunStatesValidation() => Check("run_states: validation messages", () =>
    {
        Assert(RunStatesSource.ValidateRunStatesRequest(null) == "run_states request is empty", "empty request");

        var missingStatus = new RunStatesRequest { InitialState = "a", States = new[] { State("a", "print(1);") } };
        Assert(RunStatesSource.ValidateRunStatesRequest(missingStatus) == "request_editor_status is required", "required status");

        var badStatus = new RunStatesRequest { RequestEditorStatus = "paused", InitialState = "a", States = new[] { State("a", "print(1);") } };
        Assert(RunStatesSource.ValidateRunStatesRequest(badStatus) == "unsupported request_editor_status: paused", "unsupported status");

        var badInitial = new RunStatesRequest { RequestEditorStatus = "playing", InitialState = "zzz", States = new[] { State("a", "print(1);") } };
        Assert(RunStatesSource.ValidateRunStatesRequest(badInitial) == "initial_state not found in states: zzz", "initial state");

        var duplicate = new RunStatesRequest
        {
            RequestEditorStatus = "playing",
            InitialState = "a",
            States = new[] { State("a", "print(1);"), State("a", "print(2);") },
        };
        Assert(RunStatesSource.ValidateRunStatesRequest(duplicate) == "duplicate state name: a", "duplicate name");

        var noUpdate = new RunStatesRequest { RequestEditorStatus = "playing", InitialState = "a", States = new[] { State("a", null) } };
        Assert(RunStatesSource.ValidateRunStatesRequest(noUpdate) == "state 'a' requires update code", "update required");

        var valid = new RunStatesRequest { RequestEditorStatus = "editing", InitialState = "a", States = new[] { State("a", "print(1);") } };
        Assert(RunStatesSource.ValidateRunStatesRequest(valid) == null, "valid request should pass");
    });

    private static void CheckRunStatesSourceGeneration() => Check("run_states: generated source shape", () =>
    {
        var request = new RunStatesRequest
        {
            RequestEditorStatus = "playing",
            InitialState = "idle",
            States = new[] { State("idle", "var t = 0;"), State("busy", "print(t);") },
            AutoUsings = new[] { "System.Linq", "bad namespace; rm -rf /" },
        };

        string source = RunStatesSource.BuildRunStatesSource(request);
        Assert(source.Contains("namespace Locus.RuntimeStateMachines"), "expected the host namespace");
        Assert(source.Contains("class __LocusRunStatesHost"), "expected the host class");
        Assert(source.Contains("machine.AddState(\"idle\""), "expected the idle state");
        Assert(source.Contains("machine.AddState(\"busy\""), "expected the busy state");
        Assert(source.Contains("unity_run_states:busy:update"), "expected an update #line marker");
        Assert(source.Contains("#line 1"), "expected a #line marker");
        // The auto-usings table comes from JSON: only identifier-safe names are
        // allowed through, everything else is dropped rather than spliced in.
        Assert(source.Contains("using System.Linq;"), "a valid auto-using should be kept");
        Assert(!source.Contains("rm -rf"), "an invalid auto-using must be dropped");
    });

    private static void CheckRpcLoop() => Check("json-rpc: initialize + compile/snippet + unknown method", () =>
    {
        using var toServer = new MemoryStream();
        using var fromServer = new MemoryStream();

        void WriteFrame(JsonObject message)
        {
            byte[] body = Encoding.UTF8.GetBytes(message.ToJsonString());
            byte[] header = Encoding.ASCII.GetBytes("Content-Length: " + body.Length + "\r\n\r\n");
            toServer.Write(header, 0, header.Length);
            toServer.Write(body, 0, body.Length);
            toServer.Flush();
        }

        WriteFrame(new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = 1,
            ["method"] = "initialize",
            ["params"] = new JsonObject(),
        });
        WriteFrame(new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = 2,
            ["method"] = "compile/snippet",
            ["params"] = new JsonObject { ["code"] = "print(1);" },
        });
        WriteFrame(new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = 3,
            ["method"] = "compile/nope",
            ["params"] = new JsonObject(),
        });
        WriteFrame(new JsonObject { ["jsonrpc"] = "2.0", ["method"] = "exit" });
        toServer.Position = 0;

        var transport = new Locus.CompileServer.StdioTransport(toServer, fromServer);
        var server = new DshFinishServer(transport);
        server.Run();

        fromServer.Position = 0;
        var reader = new Locus.CompileServer.StdioTransport(fromServer, Stream.Null);
        var responses = new Dictionary<long, JsonObject>();
        byte[]? frame;
        while (true)
        {
            frame = reader.ReadMessage();
            if (frame == null)
                break;
            JsonObject? message = JsonNode.Parse(Encoding.UTF8.GetString(frame))?.AsObject();
            if (message?["id"] != null)
                responses[message["id"]!.GetValue<long>()] = message;
        }

        Assert(responses.ContainsKey(1), "initialize should answer");
        Assert(responses.ContainsKey(2), "compile/snippet should answer");
        Assert(responses[1]["result"]?["serverName"]?.GetValue<string>() == Program.ServerName, "serverName mismatch");
        Assert(responses[1]["result"]?["protocolVersion"]?.GetValue<int>() == Program.ProtocolVersion, "protocolVersion mismatch");
        Assert(responses[2]["result"]?["ok"]?.GetValue<bool>() == true, "compile/snippet result should be ok");
        Assert(responses.ContainsKey(3), "unknown method should answer");
        Assert(responses[3]["error"]?["code"]?.GetValue<int>() == -32601, "unknown method should be -32601");
    });

    private static RunStatesStateRequest State(string name, string? update) => new()
    {
        Name = name,
        Update = update,
    };
}