using System.Collections.Immutable;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System.Reflection.PortableExecutable;

namespace Locus.DshFinish.Compiler;

/// <summary>One file's before/after text, as sent by <c>compile/hotPatch</c>.</summary>
public sealed record PatchEdit(string Path, string OldText, string NewText);

/// <summary>
/// Builds a patch assembly out of body-level edits.
///
/// The shape of the output is what makes it patchable: for every member whose
/// body changed, the new body is re-emitted in a type named
/// <c>__DshPatch_&lt;Original_Type&gt;</c>, with the original signature and
/// modifiers. The patcher on the Unity side looks that type up by name and
/// replaces the body of the method with the same signature on the original type.
/// Nothing here touches object layout — no fields, no new types, no changed
/// signatures — because a running domain has already laid those out.
///
/// Qualification matters for exactly that reason: the patch type lives in a
/// generated assembly, so a parameter typed <c>Player</c> in the original file
/// must be emitted as the original <c>Player</c> (a <c>global::</c>-qualified
/// name), or the signature will not match and the patch would silently not apply.
/// </summary>
public static class PatchCompiler
{
    private sealed class PatchUnit
    {
        public string Path = string.Empty;
        public SyntaxTree NewTree = null!;
        public SyntaxTree OldTree = null!;
        public SemanticModel NewModel = null!;
        public SemanticModel OldModel = null!;
        public Compilation NewCompilation = null!;
        public readonly List<(string DeclaringType, string PatchType, MemberDeclarationSyntax Updated)> Members = new();
        public readonly HashSet<string> NeededTypes = new(StringComparer.Ordinal);
    }

    /// <summary>
    /// Compile a patch assembly for <paramref name="edits"/>.
    ///
    /// Returns the JSON shape <c>compile/hotPatch</c> promises: `ok`,
    /// `assembly_b64`, `methods` (what the Unity side must register) and the
    /// diagnostics that stopped it, if any.
    /// </summary>
    public static JsonObject Compile(IReadOnlyList<PatchEdit> edits, string? projectRoot, string assemblyName)
    {
        long startedAt = Environment.TickCount64;
        var parseOptions = new CSharpParseOptions(
            languageVersion: LanguageVersion.Latest,
            documentationMode: DocumentationMode.None);

        ReferenceSet.Resolved references = PatchReferences(projectRoot);
        // A patch body refers to Unity types (`GameObject`, `Debug`) and to the
        // project's own types. Neither lives in a metadata reference when the
        // project has not been compiled yet, so the changed file is analysed
        // against the whole project source: the same world the editor sees.
        List<SyntaxTree> projectTrees = LoadProjectTrees(projectRoot, edits, parseOptions);
        var units = new List<PatchUnit>();
        var diagnostics = new List<JsonObject>();

        // Pass 1: find what changed and in which type it lives. The *old*
        // compilation is the one that knows the original assembly identity, so
        // every symbol is resolved there.
        foreach (PatchEdit edit in edits)
        {
            SyntaxTree newTree = CSharpSyntaxTree.ParseText(edit.NewText, parseOptions, path: edit.Path);
            SyntaxTree oldTree = CSharpSyntaxTree.ParseText(edit.OldText, parseOptions, path: edit.Path);
            CSharpCompilation newCompilation = CSharpCompilation.Create(
                assemblyName + "_new",
                WithEdited(projectTrees, edit.Path, newTree),
                references.References,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true));
            CSharpCompilation oldCompilation = CSharpCompilation.Create(
                assemblyName + "_old",
                WithEdited(projectTrees, edit.Path, oldTree),
                references.References,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true));

            var unit = new PatchUnit
            {
                Path = edit.Path,
                NewTree = newTree,
                OldTree = oldTree,
                NewModel = newCompilation.GetSemanticModel(newTree),
                OldModel = oldCompilation.GetSemanticModel(oldTree),
                NewCompilation = newCompilation,
            };

            ProjectFacts.FileDiff diff = ProjectFacts.DiffFile(edit.OldText, edit.NewText, parseOptions);
            if (!diff.Hot)
            {
                diagnostics.Add(new JsonObject
                {
                    ["path"] = edit.Path,
                    ["severity"] = "error",
                    ["id"] = "HOTPATCH0001",
                    ["message"] = diff.Reason ?? "edit is not hot-patchable",
                    ["line"] = 0,
                    ["column"] = 0,
                });
                continue;
            }

            var wanted = new HashSet<string>(diff.Methods.Select(method => method.DeclaringType + "|" + method.Name + "|" + string.Join(",", method.ParamTypes)), StringComparer.Ordinal);
            CollectChangedMembers(unit, wanted, diagnostics);
            units.Add(unit);
        }

        if (diagnostics.Any(diagnostic => diagnostic["severity"]?.GetValue<string>() == "error"))
            return Failure(diagnostics, startedAt);

        // Pass 2: emit the patch types. Everything a patch body references by
        // simple name has to survive the move into a different assembly, so the
        // source is rewritten with fully-qualified names first.
        // One source file per patched type: every method of `Player` goes into the
        // same `__DshPatch_Player`, or the type would be declared twice.
        var byType = new SortedDictionary<string, (string DeclaringType, List<SyntaxNode> Members)>(StringComparer.Ordinal);
        var methodRows = new List<JsonObject>();
        foreach (PatchUnit unit in units)
        {
            foreach ((string declaringType, string patchType, MemberDeclarationSyntax updated) in unit.Members)
            {
                SyntaxNode qualified = Qualify(updated, unit);
                if (!byType.TryGetValue(patchType, out var bucket))
                    bucket = (declaringType, new List<SyntaxNode>());
                bucket.Members.Add(qualified);
                byType[patchType] = bucket;
                methodRows.Add(MethodRow(declaringType, patchType, updated));
            }
        }

        var patchTrees = new List<SyntaxTree>();
        foreach ((string patchType, (string declaringType, List<SyntaxNode> members)) in byType)
        {
            string source = BuildPatchSource(patchType, declaringType, members);
            patchTrees.Add(CSharpSyntaxTree.ParseText(source, parseOptions, path: patchType + ".g.cs"));
        }

        if (patchTrees.Count == 0)
        {
            // Nothing to patch is not an error: an edit that only touched
            // comments or whitespace produces an empty patch.
            return new JsonObject
            {
                ["ok"] = true,
                ["assembly_b64"] = null,
                ["assembly_name"] = null,
                ["methods"] = new JsonArray(),
                ["diagnostics"] = new JsonArray(),
                ["duration_ms"] = Environment.TickCount64 - startedAt,
            };
        }

        CSharpCompilation patch = CSharpCompilation.Create(
            assemblyName,
            patchTrees,
            references.References,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true));

        using var stream = new MemoryStream();
        var emitResult = patch.Emit(stream);
        if (!emitResult.Success)
        {
            JsonArray errors = SnippetCompiler.Diagnostics(
                emitResult.Diagnostics.Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).ToImmutableArray());
            return new JsonObject
            {
                ["ok"] = false,
                ["error"] = "the patch assembly did not compile",
                ["diagnostics"] = errors,
                ["methods"] = new JsonArray(),
                ["duration_ms"] = Environment.TickCount64 - startedAt,
            };
        }

        return new JsonObject
        {
            ["ok"] = true,
            ["assembly_name"] = assemblyName,
            ["assembly_b64"] = Convert.ToBase64String(stream.ToArray()),
            ["methods"] = new JsonArray(methodRows.ToArray()),
            ["diagnostics"] = new JsonArray(),
            ["duration_ms"] = Environment.TickCount64 - startedAt,
        };
    }


    /// <summary>
    /// Every C# file under the project's <c>Assets/</c> and <c>Packages/</c>.
    ///
    /// The patch is analysed against this set so a body can resolve the names it
    /// uses. A file that will not parse is skipped: it cannot be the file being
    /// patched (that one is substituted in), and one broken script elsewhere must
    /// not make every hot reload impossible.
    /// </summary>
    private static List<SyntaxTree> LoadProjectTrees(string? projectRoot, IReadOnlyList<PatchEdit> edits, CSharpParseOptions parseOptions)
    {
        var trees = new List<SyntaxTree>();
        if (projectRoot == null)
            return trees;
        var edited = new HashSet<string>(edits.Select(edit => Path.GetFullPath(edit.Path)), StringComparer.Ordinal);
        foreach (string folder in new[] { "Assets", "Packages" })
        {
            string directory = Path.Combine(projectRoot, folder);
            if (!Directory.Exists(directory))
                continue;
            foreach (string path in EnumerateCs(directory))
            {
                string full;
                try
                {
                    full = Path.GetFullPath(path);
                }
                catch
                {
                    continue;
                }
                if (edited.Contains(full))
                    continue;
                try
                {
                    string text = File.ReadAllText(full);
                    trees.Add(CSharpSyntaxTree.ParseText(text, parseOptions, path: full));
                }
                catch
                {
                    // Unreadable or unparseable: skipped, see the summary above.
                }
            }
        }
        return trees;
    }

    /// <summary><paramref name="trees"/> with the file at <paramref name="editedPath"/> replaced.</summary>
    private static List<SyntaxTree> WithEdited(List<SyntaxTree> trees, string editedPath, SyntaxTree replacement)
    {
        string full;
        try
        {
            full = Path.GetFullPath(editedPath);
        }
        catch
        {
            full = editedPath;
        }
        var kept = trees.Where(tree => !string.Equals(tree.FilePath, full, StringComparison.Ordinal)).ToList();
        kept.Add(replacement);
        return kept;
    }

    private static IEnumerable<string> EnumerateCs(string directory)
    {
        IEnumerable<string> files;
        try
        {
            files = Directory.EnumerateFiles(directory, "*.cs", SearchOption.AllDirectories);
        }
        catch
        {
            yield break;
        }
        foreach (string file in files)
            yield return file;
    }

    /// <summary>
    /// References for a patch compilation.
    ///
    /// <see cref="ReferenceSet.Resolve"/> hands back the project's Unity
    /// assemblies, and those do not include a usable `System.Object` — Unity
    /// compiles against Mono's profile, whose BCL assemblies are reference-only.
    /// Left alone the patch would fail with `CS0518 Predefined type
    /// 'System.Object' is not defined`. Pairing the same reference pack the
    /// explicit-reference tier uses is exactly what those profile assemblies
    /// expect.
    /// </summary>
    private static ReferenceSet.Resolved PatchReferences(string? projectRoot)
    {
        ReferenceSet.Resolved resolved = ReferenceSet.Resolve(projectRoot, null);
        if (resolved.Origin is "host" or "explicit")
            return resolved;
        List<string>? pack = ReferenceSet.ReferencePackPaths();
        if (pack == null || pack.Count == 0)
            return resolved;

        var builder = ImmutableArray.CreateBuilder<MetadataReference>();
        builder.AddRange(resolved.References);
        foreach (string path in pack)
        {
            try
            {
                // Same load strategy as ReferenceSet: prefetch the metadata so no
                // file handle outlives the load (Unity rewrites these files).
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var module = ModuleMetadata.CreateFromStream(stream, PEStreamOptions.PrefetchMetadata);
                builder.Add(AssemblyMetadata.Create(module).GetReference(filePath: path));
            }
            catch
            {
                // A reference pack entry that will not load is not fatal: the
                // compilation diagnostics will name whatever actually went missing.
            }
        }
        return new ReferenceSet.Resolved { References = builder.ToImmutable(), Origin = "unity+pack" };
    }

    private static JsonObject Failure(List<JsonObject> diagnostics, long startedAt) => new()
    {
        ["ok"] = false,
        ["error"] = "the edits are not all hot-patchable",
        ["diagnostics"] = new JsonArray(diagnostics.ToArray()),
        ["methods"] = new JsonArray(),
        ["duration_ms"] = Environment.TickCount64 - startedAt,
    };

    /// <summary>
    /// Find the new declaration of each changed member and record it against the
    /// type that owns it in the *old* source.
    /// </summary>
    private static void CollectChangedMembers(PatchUnit unit, HashSet<string> wanted, List<JsonObject> diagnostics)
    {
        foreach (BaseTypeDeclarationSyntax type in unit.NewTree.GetRoot().DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
        {
            TypeDeclarationSyntax? declaration = type as TypeDeclarationSyntax;
            if (declaration == null)
                continue;
            string declaringType = FullName(declaration, unit.NewModel);
            string patchType = ProjectFacts.PatchTypeName(declaringType);
            foreach (MemberDeclarationSyntax member in declaration.Members)
            {
                string name = member switch
                {
                    MethodDeclarationSyntax method => method.Identifier.Text,
                    ConstructorDeclarationSyntax => ".ctor",
                    PropertyDeclarationSyntax property => property.Identifier.Text,
                    _ => string.Empty,
                };
                if (name.Length == 0)
                    continue;
                // FileDiff derives a type's name from the file alone (no
                // namespace), the patch source needs the namespaced one. Match
                // on the simple name so both stay in step.
                string simpleType = SimpleName(declaringType);
                bool wantedHere = wanted.Any(key =>
                {
                    string[] parts = key.Split('|');
                    return parts.Length >= 2 && parts[1] == name
                        && (parts[0] == declaringType || SimpleName(parts[0]) == simpleType);
                });
                if (!wantedHere)
                    continue;
                unit.Members.Add((declaringType, patchType, member));
            }
        }
    }

    /// <summary>The name without its namespace: <c>Ns.Outer.Inner</c> → <c>Outer.Inner</c>.</summary>
    private static string SimpleName(string typeName)
    {
        int withNamespace = typeName.LastIndexOf('.');
        return withNamespace < 0 ? typeName : typeName.Substring(withNamespace + 1);
    }

    /// <summary>The metadata-ish name used in the patch type: <c>Ns.Outer.Inner</c>.</summary>
    private static string FullName(TypeDeclarationSyntax declaration, SemanticModel model)
    {
        if (model.GetDeclaredSymbol(declaration) is INamedTypeSymbol symbol)
        {
            var parts = new List<string>();
            for (INamedTypeSymbol? current = symbol; current != null; current = current.ContainingType)
                parts.Insert(0, current.Name);
            return symbol.ContainingNamespace is { IsGlobalNamespace: false } ns
                ? ns.ToDisplayString() + "." + string.Join(".", parts)
                : string.Join(".", parts);
        }
        return declaration.Identifier.Text;
    }

    /// <summary>
    /// Rewrite every identifier in <paramref name="node"/> that resolves to a
    /// type as its fully-qualified name.
    ///
    /// Without this, a patch body referring to `Player` or `Rigidbody` would be
    /// emitted into `__DshPatch_…`, where neither name exists — the patch would
    /// fail to compile, or worse, bind to a same-named type from another
    /// assembly. Names that already carry a `global::`, or that are member
    /// accesses qualified by an expression, are left alone.
    /// </summary>
    private static SyntaxNode Qualify(SyntaxNode node, PatchUnit unit)
    {
        var identifiers = node.DescendantNodes()
            .OfType<IdentifierNameSyntax>()
            .Where(identifier => !IsQualifiedByMemberAccess(identifier))
            .ToList();

        var replacements = new Dictionary<SyntaxNode, SyntaxNode>();
        foreach (IdentifierNameSyntax identifier in identifiers)
        {
            if (replacements.ContainsKey(identifier))
                continue;
            SymbolInfo info = unit.NewModel.GetSymbolInfo(identifier);
            ITypeSymbol? type = info.Symbol as ITypeSymbol ?? info.CandidateSymbols.OfType<ITypeSymbol>().FirstOrDefault();
            if (type == null)
            {
                // Not a type — a local, a parameter, a field. Leave it: locals are
                // carried over by the rewritten member itself.
                continue;
            }
            string display = type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            if (display.StartsWith("global::", StringComparison.Ordinal))
            {
                // Names are emitted as `global::A.B`, not as an expression: in a
                // member access like `Debug.Log` the `Debug` position must be a
                // name, and parsing the qualified form as an expression yields a
                // member access that Roslyn then rejects there.
                string name = display["global::".Length..];
                replacements[identifier] = SyntaxFactory.ParseName("global::" + name).WithTriviaFrom(identifier);
                unit.NeededTypes.Add(display);
            }
        }

        return node.ReplaceNodes(replacements.Keys, (original, _) => replacements.TryGetValue(original, out SyntaxNode? replacement) ? replacement : original);
    }

    private static bool IsQualifiedByMemberAccess(IdentifierNameSyntax identifier) =>
        identifier.Parent is MemberAccessExpressionSyntax access && access.Name == identifier;

    /// <summary>
    /// Wrap one rewritten member in its patch type.
    ///
    /// The member keeps its modifiers and attributes; a constructor is renamed to
    /// the patch type's own constructor so it still compiles, while the recorded
    /// method row keeps `.ctor` as the name the Unity side has to replace.
    /// </summary>
    private static string BuildPatchSource(string patchType, string declaringType, IReadOnlyList<SyntaxNode> members)
    {
        // The class is declared with the full patch name (spaces flattened, each
        // segment 31 characters or fewer, so every segment is a legal identifier).
        // Trimming to the last underscore used to turn __DshPatch_LiveProbe_Probe
        // into `Probe`, which then did not match the patch_declaring_type row the
        // editor was told to look up.
        string shortName = patchType;
        var bodies = new List<string>();
        foreach (SyntaxNode member in members)
        {
            bodies.Add(member is ConstructorDeclarationSyntax constructor
                ? constructor.WithIdentifier(SyntaxFactory.Identifier(shortName)).NormalizeWhitespace(elasticTrivia: true).ToFullString()
                : member.NormalizeWhitespace(elasticTrivia: true).ToFullString());
        }
        string body = string.Join(Environment.NewLine, bodies);

        var builder = new StringBuilder();
        builder.AppendLine("// generated: hot-patch bodies for " + declaringType);
        builder.AppendLine("#nullable disable");
        builder.AppendLine("namespace Locus.DshHotPatch");
        builder.AppendLine("{");
        builder.AppendLine("internal static class __DshPatchMarker_" + Sanitize(declaringType));
        builder.AppendLine("{");
        builder.AppendLine("    internal const string OriginalType = \"" + Escape(declaringType) + "\";");
        builder.AppendLine("}");
        builder.AppendLine("internal class " + shortName);
        builder.AppendLine("{");
        builder.AppendLine(body);
        builder.AppendLine("}");
        builder.AppendLine("}");
        return builder.ToString();
    }

    private static string Sanitize(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (char character in value)
            builder.Append(char.IsLetterOrDigit(character) ? character : '_');
        return builder.ToString();
    }

    private static string Escape(string value) => value.Replace("\\", "\\\\").Replace("\"", "\\\"");

    /// <summary>One row the Unity side uses to match a patch method to its original.</summary>
    private static JsonObject MethodRow(string declaringType, string patchType, MemberDeclarationSyntax member)
    {
        string name;
        List<string> parameters = new();
        switch (member)
        {
            case MethodDeclarationSyntax method:
                name = method.Identifier.Text;
                parameters.AddRange(method.ParameterList.Parameters.Select(parameter => parameter.Type?.ToString() ?? string.Empty));
                break;
            case ConstructorDeclarationSyntax constructor:
                name = ".ctor";
                parameters.AddRange(constructor.ParameterList.Parameters.Select(parameter => parameter.Type?.ToString() ?? string.Empty));
                break;
            case PropertyDeclarationSyntax property:
                name = property.Identifier.Text;
                break;
            default:
                name = string.Empty;
                break;
        }
        return new JsonObject
        {
            ["declaring_type"] = declaringType,
            ["patch_declaring_type"] = patchType,
            ["name"] = name,
            ["param_type_names"] = new JsonArray(parameters.Select(parameter => (JsonNode?)JsonValue.Create(parameter)).ToArray()),
            ["is_static"] = member.Modifiers.Any(SyntaxKind.StaticKeyword),
            ["is_ctor"] = member is ConstructorDeclarationSyntax,
            ["original_assembly"] = null,
        };
    }
}
