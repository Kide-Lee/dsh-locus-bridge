#nullable disable
// Derived from upstream Locus:
// Locus/locus_unity/Editor/ExecuteCodeAsync/LocusSnippetExpressionMode.cs
// (https://github.com/r1n7aro/Locus, commit 4ee37ed0, v0.9.3).
//
// Copyright (c) the Locus authors. Licensed under the GNU General Public
// License, version 3 or later — the same license as dsh-locus-bridge. Copied
// **unmodified** apart from this header so a bare-expression snippet is
// classified exactly as the Unity plugin classifies it. See NOTICE
// ("Files derived from Locus") for the attribution record.
//
// Shared source: compiled into the Unity plugin (in-Unity snippet compile
// path) and linked into the Locus compile server (LocusCompileServer.csproj),
// so both compile paths decide the expression-mode retry the same way. Keep it
// valid for Unity's C# 9 compiler and Roslyn 3.8 (Locus.Roslyn.dll) as well as
// the compile server's current Roslyn.

using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Locus
{
    /// <summary>
    /// A snippet compiles as statements first; a body that is one bare
    /// expression (<c>Selection.activeObject.name</c>) is retried as
    /// <c>return (object)(...)</c> so its value prints. Only such a body can
    /// succeed that way, so statement bodies skip the retry and report their
    /// own compile errors without unrelated expression-mode diagnostics.
    /// </summary>
    public static class LocusSnippetExpressionMode
    {
        public static bool Applies(string bodyCode, CSharpParseOptions parseOptions)
        {
            if (string.IsNullOrWhiteSpace(bodyCode))
                return false;

            ExpressionSyntax expression = SyntaxFactory.ParseExpression(
                bodyCode,
                0,
                parseOptions,
                true);
            return !expression.ContainsDiagnostics;
        }
    }
}
