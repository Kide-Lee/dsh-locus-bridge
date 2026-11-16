using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Locus.DshFinish.Compiler;

/// <summary>
/// Snippet source generation for this sidecar.
///
/// A **stripped port** of upstream <c>Locus.CompileServer.UnitySnippetSource</c>,
/// not a verbatim one. Upstream wraps the body in
/// <c>__LocusAsyncSnippetHost.ExecuteAsync(ScriptGlobals, ExecuteCodeContext,
/// CancellationToken)</c> because it compiles against live Unity assemblies.
/// This sidecar is used two ways, and the host signature that is right for one
/// is wrong for the other:
///
///   * <c>compile/snippet</c> with <c>mode:"csharp"</c> (the default) wraps the
///     body in a plain <c>object Run()</c> method compiled against whatever
///     references the caller supplied — typically the project's
///     <c>Library/ScriptAssemblies</c> plus the .NET ref pack, which is enough
///     to type-check real Unity API calls without an editor running.
///   * <c>compile/snippet</c> with <c>mode:"unity"</c> reproduces the exact
///     upstream wrapper (same host name, same usings, same <c>#line</c> map) so
///     the emitted IL can be handed to Unity and loaded there, where
///     <c>Locus.LocusBridge.ScriptGlobals</c> exists.
///
/// Both modes hoist leading <c>using</c> directives the way upstream does and
/// keep line slots, so a diagnostic on line N is line N of the snippet the
/// agent wrote — the property the tool surface depends on.
/// </summary>
public static class SnippetSource
{
    public const string HostTypeName = "__LocusAsyncSnippetHost";
    public const string FullHostTypeName = "Locus.RuntimeSnippets.__LocusAsyncSnippetHost";
    public const string SourcePath = "LocusRuntimeAsyncSnippet.cs";

    /// <summary>Host type for the standalone (no-Unity) mode.</summary>
    public const string PlainHostTypeName = "__DshSnippetHost";
    public const string PlainFullHostTypeName = "Dsh.RuntimeSnippets.__DshSnippetHost";
    public const string PlainSourcePath = "DshRuntimeSnippet.cs";

    /// <summary>
    /// Keep common IO names convenient without importing the whole System.IO
    /// namespace (verbatim from upstream: Unity's Mono mscorlib contains an
    /// internal <c>System.IO.MonoLinqHelper.ToArray</c> that becomes ambiguous
    /// with LINQ <c>ToArray</c> once accessibility checks are relaxed).
    /// </summary>
    internal static void AppendCommonIoAliases(System.Text.StringBuilder sb)
    {
        sb.AppendLine("using BinaryReader = global::System.IO.BinaryReader;");
        sb.AppendLine("using BinaryWriter = global::System.IO.BinaryWriter;");
        sb.AppendLine("using BufferedStream = global::System.IO.BufferedStream;");
        sb.AppendLine("using Directory = global::System.IO.Directory;");
        sb.AppendLine("using DirectoryInfo = global::System.IO.DirectoryInfo;");
        sb.AppendLine("using DirectoryNotFoundException = global::System.IO.DirectoryNotFoundException;");
        sb.AppendLine("using EndOfStreamException = global::System.IO.EndOfStreamException;");
        sb.AppendLine("using File = global::System.IO.File;");
        sb.AppendLine("using FileAccess = global::System.IO.FileAccess;");
        sb.AppendLine("using FileAttributes = global::System.IO.FileAttributes;");
        sb.AppendLine("using FileInfo = global::System.IO.FileInfo;");
        sb.AppendLine("using FileMode = global::System.IO.FileMode;");
        sb.AppendLine("using FileNotFoundException = global::System.IO.FileNotFoundException;");
        sb.AppendLine("using FileOptions = global::System.IO.FileOptions;");
        sb.AppendLine("using FileShare = global::System.IO.FileShare;");
        sb.AppendLine("using FileStream = global::System.IO.FileStream;");
        sb.AppendLine("using FileSystemInfo = global::System.IO.FileSystemInfo;");
        sb.AppendLine("using IOException = global::System.IO.IOException;");
        sb.AppendLine("using MemoryStream = global::System.IO.MemoryStream;");
        sb.AppendLine("using Path = global::System.IO.Path;");
        sb.AppendLine("using SearchOption = global::System.IO.SearchOption;");
        sb.AppendLine("using SeekOrigin = global::System.IO.SeekOrigin;");
        sb.AppendLine("using Stream = global::System.IO.Stream;");
        sb.AppendLine("using StreamReader = global::System.IO.StreamReader;");
        sb.AppendLine("using StreamWriter = global::System.IO.StreamWriter;");
        sb.AppendLine("using StringReader = global::System.IO.StringReader;");
        sb.AppendLine("using StringWriter = global::System.IO.StringWriter;");
        sb.AppendLine("using TextReader = global::System.IO.TextReader;");
        sb.AppendLine("using TextWriter = global::System.IO.TextWriter;");
    }

    /// <summary>
    /// Port of upstream <c>SplitLeadingUsings</c>: hoist the leading block of
    /// blank lines and <c>using …;</c> directives, blanking their slots in the
    /// body so line N stays line N on both sides.
    /// </summary>
    public static void SplitLeadingUsings(string? code, out string leadingUsings, out string bodyCode)
    {
        if (string.IsNullOrEmpty(code))
        {
            leadingUsings = "";
            bodyCode = "";
            return;
        }

        string normalized = code.Replace("\r\n", "\n");
        string[] lines = normalized.Split('\n');

        var usingSb = new System.Text.StringBuilder();
        var bodySb = new System.Text.StringBuilder();

        bool stillInUsingBlock = true;

        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i];
            string trimmed = line.Trim();

            if (stillInUsingBlock)
            {
                if (string.IsNullOrEmpty(trimmed) ||
                    (trimmed.StartsWith("using ", StringComparison.Ordinal) &&
                     trimmed.EndsWith(";", StringComparison.Ordinal) &&
                     IsUsingDirectiveLine(trimmed)))
                {
                    usingSb.AppendLine(line);
                    bodySb.AppendLine();
                    continue;
                }

                stillInUsingBlock = false;
            }

            bodySb.AppendLine(line);
        }

        leadingUsings = usingSb.ToString().TrimEnd();
        bodyCode = bodySb.ToString().TrimEnd();
    }

    // Unity's SnippetParseOptions minus preprocessor symbols, which a single
    // line starting with "using" cannot observe.
    private static readonly CSharpParseOptions UsingDirectiveParseOptions = new(
        languageVersion: LanguageVersion.CSharp9,
        documentationMode: DocumentationMode.None,
        kind: SourceCodeKind.Regular);

    /// <summary>Port of upstream <c>IsUsingDirectiveLine</c>.</summary>
    private static bool IsUsingDirectiveLine(string trimmedLine)
    {
        var unit = SyntaxFactory.ParseCompilationUnit(trimmedLine, options: UsingDirectiveParseOptions);
        return unit.Usings.Count > 0 && unit.Members.Count == 0;
    }

    /// <summary>
    /// Whether the body awaits at its own top level (and therefore needs an
    /// <c>async</c> host method). Await inside a lambda or local function has
    /// its own async context and does not. Verbose C# 9 -compatible port of
    /// upstream <c>RequiresAsyncWrapper</c>; the shared sources in this project
    /// still build with Unity's older compiler, so no `is … or …` patterns.
    /// </summary>
    public static bool RequiresAsyncWrapper(string bodyCode, CSharpParseOptions parseOptions)
    {
        if (string.IsNullOrWhiteSpace(bodyCode))
            return false;

        StatementSyntax body = SyntaxFactory.ParseStatement(
            "{\n" + bodyCode + "\n}",
            options: parseOptions,
            consumeFullText: true);
        return ContainsTopLevelAwait(body);
    }

    private static bool ContainsTopLevelAwait(SyntaxNode node)
    {
        if (node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax)
            return false;

        foreach (SyntaxToken token in node.ChildTokens())
        {
            if (token.IsKind(SyntaxKind.AwaitKeyword))
                return true;
        }

        foreach (SyntaxNode child in node.ChildNodes())
        {
            if (ContainsTopLevelAwait(child))
                return true;
        }

        return false;
    }

    /// <summary>
    /// True when a bare expression snippet (<c>Selection.activeObject.name</c>)
    /// should be retried as <c>return (object)(…)</c> so its value can be
    /// printed. Delegates to the copied upstream shared source.
    /// </summary>
    public static bool IsExpressionMode(string bodyCode, CSharpParseOptions parseOptions) =>
        Locus.LocusSnippetExpressionMode.Applies(bodyCode, parseOptions);

    /// <summary>
    /// Standalone wrapper (<c>mode:"csharp"</c>): references no Unity or Locus
    /// type, so the compilation only needs the references the caller supplied.
    /// </summary>
    public static string BuildStandaloneSource(string leadingUsings, string bodyCode, bool expressionMode)
    {
        var sb = new System.Text.StringBuilder(2048);

        sb.AppendLine("using System;");
        AppendCommonIoAliases(sb);
        sb.AppendLine("using System.Text;");
        sb.AppendLine("using System.Linq;");
        sb.AppendLine("using System.Reflection;");
        sb.AppendLine("using System.Threading;");
        sb.AppendLine("using System.Threading.Tasks;");
        sb.AppendLine("using System.Collections;");
        sb.AppendLine("using System.Collections.Generic;");

        if (!string.IsNullOrWhiteSpace(leadingUsings))
        {
            // Hoisted snippet usings keep their snippet line numbers. The
            // wrapper's own usings are switched off around them: the agent
            // cannot know which ones the wrapper already wrote, and a repeated
            // `using System.Text;` would surface as a CS0105 warning pointing
            // at a line of the snippet that is perfectly fine.
            sb.AppendLine("#pragma warning disable 0105");
            sb.AppendLine("#line 1");
            sb.AppendLine(leadingUsings);
            sb.AppendLine("#line default");
            sb.AppendLine("#pragma warning restore 0105");
        }

        // The wrapper owns no snippet line; hidden keeps its frames from
        // reporting generated line numbers.
        sb.AppendLine("#line hidden");
        sb.AppendLine("namespace Dsh.RuntimeSnippets");
        sb.AppendLine("{");
        sb.Append("    public static class ").AppendLine(PlainHostTypeName);
        sb.AppendLine("    {");
        sb.AppendLine("        public static object Run()");
        sb.AppendLine("        {");
        sb.AppendLine("            #line 1");

        AppendBody(sb, bodyCode, expressionMode, "            ");

        sb.AppendLine("            #line default");
        sb.AppendLine("        }");

        // `print` is the name the agent writes in the editor, where it is a
        // ScriptGlobals field. Without an editor there is no globals object, so
        // the standalone host defines the same name as a Console.WriteLine
        // shim: a snippet that compiles in the editor should also compile here.
        sb.AppendLine();
        sb.AppendLine("        public static void print(object value) =>");
        sb.AppendLine("            global::System.Console.WriteLine(value);");
        sb.AppendLine();
        sb.AppendLine("        public static void printJson(object value) =>");
        sb.AppendLine("            global::System.Console.WriteLine(value);");
        sb.AppendLine();
        sb.AppendLine("        public static void clear() { }");
        sb.AppendLine("    }");
        sb.AppendLine("}");

        return sb.ToString();
    }

    /// <summary>
    /// Upstream wrapper (<c>mode:"unity"</c>): byte-compatible with
    /// <c>UnitySnippetSource.BuildAsyncSnippetSource</c>, which is what the
    /// plugin's in-editor path produces for the same snippet.
    /// </summary>
    public static string BuildUnitySource(
        string leadingUsings,
        string bodyCode,
        bool expressionMode,
        bool useAsyncWrapper)
    {
        var sb = new System.Text.StringBuilder(4096);

        sb.AppendLine("using System;");
        AppendCommonIoAliases(sb);
        sb.AppendLine("using System.Text;");
        sb.AppendLine("using System.Linq;");
        sb.AppendLine("using System.Reflection;");
        sb.AppendLine("using System.Threading;");
        sb.AppendLine("using System.Threading.Tasks;");
        sb.AppendLine("using System.Collections;");
        sb.AppendLine("using System.Collections.Generic;");
        sb.AppendLine("using UnityEngine;");
        sb.AppendLine("using UnityEngine.SceneManagement;");
        sb.AppendLine("using UnityEditor;");
        sb.AppendLine("using UnityEditor.SceneManagement;");
        sb.AppendLine("using UnityEditor.Animations;");
        sb.AppendLine("using Locus;");
        sb.AppendLine("using static UnityEngine.Object;");
        sb.AppendLine("using Object = UnityEngine.Object;");

        if (!string.IsNullOrWhiteSpace(leadingUsings))
        {
            sb.AppendLine("#line 1");
            sb.AppendLine(leadingUsings);
            sb.AppendLine("#line default");
        }

        sb.AppendLine("#line hidden");
        sb.AppendLine("namespace Locus.RuntimeSnippets");
        sb.AppendLine("{");
        sb.Append("    public static class ").Append(HostTypeName).AppendLine();
        sb.AppendLine("    {");

        if (useAsyncWrapper)
        {
            sb.AppendLine("        public static async global::System.Threading.Tasks.Task<object> ExecuteAsync(global::Locus.LocusBridge.ScriptGlobals globals, global::Locus.LocusBridge.ExecuteCodeContext ctx, global::System.Threading.CancellationToken cancellationToken)");
        }
        else
        {
            sb.AppendLine("        public static global::System.Threading.Tasks.Task<object> ExecuteAsync(global::Locus.LocusBridge.ScriptGlobals globals, global::Locus.LocusBridge.ExecuteCodeContext ctx, global::System.Threading.CancellationToken cancellationToken)");
            sb.AppendLine("        {");
            sb.AppendLine("            return global::System.Threading.Tasks.Task.FromResult<object>(ExecuteSync(globals, ctx, cancellationToken));");
            sb.AppendLine("        }");
            sb.AppendLine();
            sb.AppendLine("        private static object ExecuteSync(global::Locus.LocusBridge.ScriptGlobals globals, global::Locus.LocusBridge.ExecuteCodeContext ctx, global::System.Threading.CancellationToken cancellationToken)");
        }

        sb.AppendLine("        {");
        sb.AppendLine("            var print = new global::System.Action<object>(globals.print);");
        sb.AppendLine("            var printJson = new global::System.Action<object>(globals.printJson);");
        sb.AppendLine("            var clear = new global::System.Action(globals.clear);");
        sb.AppendLine("            var ct = cancellationToken;");
        sb.AppendLine("            ctx.ThrowIfCancellationRequested();");
        sb.AppendLine("            #line 1");

        AppendBody(sb, bodyCode, expressionMode, "            ");

        sb.AppendLine("            #line default");
        sb.AppendLine("        }");
        sb.AppendLine("    }");
        sb.AppendLine("}");

        return sb.ToString();
    }

    /// <summary>
    /// The snippet body itself: an expression is returned, a statement block
    /// falls through to <c>return null</c> (matching upstream's tail).
    /// </summary>
    private static void AppendBody(
        System.Text.StringBuilder sb,
        string bodyCode,
        bool expressionMode,
        string indent)
    {
        if (expressionMode)
        {
            if (string.IsNullOrWhiteSpace(bodyCode))
            {
                sb.Append(indent).AppendLine("return null;");
                return;
            }

            sb.Append(indent).Append("return (object)(");
            sb.Append(bodyCode);
            sb.AppendLine(");");
            return;
        }

        if (!string.IsNullOrWhiteSpace(bodyCode))
            sb.AppendLine(bodyCode);

        sb.Append(indent).AppendLine("return null;");
    }
}