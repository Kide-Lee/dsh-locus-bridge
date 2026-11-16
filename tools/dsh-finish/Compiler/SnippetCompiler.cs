using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;

namespace Locus.DshFinish.Compiler;

/// <summary>
/// One snippet compilation: wrap the body, compile it, and hand back either
/// the diagnostics or the assembly bytes.
///
/// The wire shape is fixed by docs/internal/contracts.md §3.1:
/// <c>{ok, diagnostics:[{severity,id,message,line,column}], assembly_b64?, error?}</c>.
/// Line/column are 1-based and taken from the <c>#line</c>-mapped span, so they
/// point at the line of the snippet the caller wrote rather than at the
/// generated wrapper — without that mapping every diagnostic of a hoisted-using
/// snippet would be off by the size of the boilerplate.
/// </summary>
public static class SnippetCompiler
{
    /// <summary>Port of upstream <c>CompileService.SnippetCompilationOptions</c>.</summary>
    private static readonly CSharpCompilationOptions SnippetCompilationOptions = new(
        outputKind: OutputKind.DynamicallyLinkedLibrary,
        optimizationLevel: OptimizationLevel.Release,
        allowUnsafe: false,
        assemblyIdentityComparer: DesktopAssemblyIdentityComparer.Default);

    private static readonly EmitOptions LightweightEmitOptions = new();

    /// <summary>Whether the request asks for the Unity-hosted wrapper.</summary>
    public static bool IsUnityMode(string? mode) =>
        string.Equals(mode, "unity", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Compile one snippet.
    /// </summary>
    /// <param name="code">The snippet body as written by the agent.</param>
    /// <param name="mode">"csharp" (default) or "unity".</param>
    /// <param name="projectRoot">Unity project root, or null.</param>
    /// <param name="extraReferences">Request-supplied reference paths.</param>
    /// <param name="loopGuard">Insert the upstream loop-cancellation guard.</param>
    /// <param name="assemblyName">Emitted assembly name.</param>
    public static JsonObject Compile(
        string code,
        string? mode,
        string? projectRoot,
        IEnumerable<string>? extraReferences,
        bool loopGuard,
        string assemblyName)
    {
        long startedAt = Environment.TickCount64;
        bool unityMode = IsUnityMode(mode);

        var parseOptions = new CSharpParseOptions(
            languageVersion: LanguageVersion.Latest,
            documentationMode: DocumentationMode.None,
            kind: SourceCodeKind.Regular);

        SnippetSource.SplitLeadingUsings(code, out string leadingUsings, out string bodyCode);
        bool expressionMode = SnippetSource.IsExpressionMode(bodyCode, parseOptions);
        bool asyncWrapper = unityMode && SnippetSource.RequiresAsyncWrapper(bodyCode, parseOptions);

        string source = unityMode
            ? SnippetSource.BuildUnitySource(leadingUsings, bodyCode, expressionMode, asyncWrapper)
            : SnippetSource.BuildStandaloneSource(leadingUsings, bodyCode, expressionMode);
        string sourcePath = unityMode ? SnippetSource.SourcePath : SnippetSource.PlainSourcePath;

        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: sourcePath);
        if (loopGuard)
        {
            // The upstream shared source rewrites the tree in place; it looks
            // the host class up by name, so the name must match the wrapper.
            string host = unityMode ? SnippetSource.HostTypeName : SnippetSource.PlainHostTypeName;
            tree = Locus.LocusSnippetLoopGuard.Apply(tree, host);
        }

        return Emit(tree, projectRoot, extraReferences, startedAt, unityMode, expressionMode, asyncWrapper, assemblyName);
    }

    /// <summary>
    /// Compile a complete source file that already contains its own host
    /// class — no snippet wrapping, no expression mode, no loop guard.
    ///
    /// <c>compile/runStates</c> needs this: its generated source is a whole
    /// <c>Locus.RuntimeStateMachines.__LocusRunStatesHost</c> type, and pushing
    /// that through the snippet wrapper would nest one host inside another.
    /// </summary>
    public static JsonObject CompileUnit(
        string source,
        string sourcePath,
        string? projectRoot,
        IEnumerable<string>? extraReferences,
        string assemblyName)
    {
        long startedAt = Environment.TickCount64;
        var parseOptions = new CSharpParseOptions(
            languageVersion: LanguageVersion.Latest,
            documentationMode: DocumentationMode.None,
            kind: SourceCodeKind.Regular);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: sourcePath);
        return Emit(tree, projectRoot, extraReferences, startedAt, unityMode: true, expressionMode: false, asyncWrapper: false, assemblyName);
    }

    private static JsonObject Emit(
        SyntaxTree tree,
        string? projectRoot,
        IEnumerable<string>? extraReferences,
        long startedAt,
        bool unityMode,
        bool expressionMode,
        bool asyncWrapper,
        string assemblyName)
    {
        ReferenceSet.Resolved references = ReferenceSet.Resolve(projectRoot, extraReferences);

        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName: assemblyName,
            syntaxTrees: new[] { tree },
            references: references.References,
            options: SnippetCompilationOptions);

        using var peStream = new MemoryStream(128 * 1024);
        EmitResult emitResult;
        try
        {
            emitResult = compilation.Emit(peStream, options: LightweightEmitOptions);
        }
        catch (Exception ex)
        {
            return Failure("emit failed: " + ex.Message, startedAt, references.Origin);
        }

        JsonArray diagnostics = Diagnostics(emitResult.Diagnostics);
        bool hasError = false;
        foreach (Diagnostic diagnostic in emitResult.Diagnostics)
        {
            if (diagnostic.Severity == DiagnosticSeverity.Error)
            {
                hasError = true;
                break;
            }
        }

        var result = new JsonObject
        {
            ["ok"] = !hasError && emitResult.Success,
            ["diagnostics"] = diagnostics,
            ["mode"] = unityMode ? "unity" : "csharp",
            ["expression_mode"] = expressionMode,
            ["async_wrapper"] = asyncWrapper,
            ["reference_origin"] = references.Origin,
            ["reference_count"] = references.Count,
            ["duration_ms"] = Environment.TickCount64 - startedAt,
        };

        if (!emitResult.Success || hasError)
        {
            // `error` carries the same "compilation failed:\n  ID at L:C: msg"
            // framing the Unity-side path produces, so the tool surface can
            // show one shape regardless of which compile path answered.
            result["error"] = DiagnosticText.BuildDiagnosticErrorText(emitResult.Diagnostics) ?? "compilation failed";
            return result;
        }

        result["assembly_b64"] = Convert.ToBase64String(peStream.ToArray());
        return result;
    }

    /// <summary>Wire form of one diagnostic list (1-based line/column).</summary>
    public static JsonArray Diagnostics(ImmutableArray<Diagnostic> diagnostics)
    {
        var items = new JsonArray();
        foreach (Diagnostic diagnostic in diagnostics)
        {
            FileLinePositionSpan span = default;
            try
            {
                span = diagnostic.Location.GetMappedLineSpan();
            }
            catch
            {
                // A diagnostic without a location (e.g. an emit-level one)
                // reports 0:0 rather than dropping the message.
            }

            items.Add(new JsonObject
            {
                ["severity"] = SeverityName(diagnostic.Severity),
                ["id"] = diagnostic.Id,
                ["message"] = diagnostic.GetMessage(),
                ["line"] = span.StartLinePosition.Line + 1,
                ["column"] = span.StartLinePosition.Character + 1,
            });
        }
        return items;
    }

    private static string SeverityName(DiagnosticSeverity severity) => severity switch
    {
        DiagnosticSeverity.Error => "error",
        DiagnosticSeverity.Warning => "warning",
        DiagnosticSeverity.Info => "info",
        DiagnosticSeverity.Hidden => "hidden",
        _ => "unknown",
    };

    private static JsonObject Failure(string error, long startedAt, string origin) => new()
    {
        ["ok"] = false,
        ["diagnostics"] = new JsonArray(),
        ["error"] = error,
        ["reference_origin"] = origin,
        ["duration_ms"] = Environment.TickCount64 - startedAt,
    };
}