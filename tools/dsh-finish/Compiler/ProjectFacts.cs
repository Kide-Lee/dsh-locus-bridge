using System.Collections.Immutable;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Locus.CompileServer;

namespace Locus.DshFinish.Compiler;

/// <summary>
/// Project-level compile facts and hot-diff analysis, without an editor.
///
/// Both requests exist because hot reload needs them *before* anything is
/// compiled: the parameters say which references/defines/langversion a
/// compilation would use, and the diff says whether an edit is small enough to
/// replace a method body. Upstream asks Unity for the parameters
/// (<c>get_compile_params</c> over the bridge); this server reads them off disk
/// instead, which is what lets the answer exist with the editor closed.
/// </summary>
public static class ProjectFacts
{
    /// <summary>Unity's default scripting language version for its Roslyn.</summary>
    private const string DefaultLangVersion = "9.0";

    /// <summary>
    /// The compile parameters this server would use for <paramref name="projectRoot"/>.
    ///
    /// <c>reference_paths</c> comes from the same resolver a compile goes
    /// through, so a snippet compiled with these parameters and a snippet
    /// compiled without them reach the same references. Defines are read from
    /// the player/editor scripting define symbols of the project settings, and
    /// the define list is the union of both because a snippet can reference
    /// types from either assembly.
    /// </summary>
    public static JsonObject CompileParams(string? projectRoot)
    {
        ReferenceSet.Resolved resolved = ReferenceSet.Resolve(projectRoot, null);
        List<string> defines = ReadDefines(projectRoot);
        return new JsonObject
        {
            ["reference_paths"] = new JsonArray(resolved.References
                .Select(reference => (JsonNode?)JsonValue.Create(reference.Display ?? string.Empty))
                .Where(node => node != null && node.GetValue<string>() != string.Empty)
                .ToArray()),
            ["defines"] = new JsonArray(defines.Select(define => (JsonNode?)JsonValue.Create(define)).ToArray()),
            ["lang_version"] = DefaultLangVersion,
            ["allow_unsafe"] = ReadAllowUnsafe(projectRoot),
            ["origin"] = "dsh-sidecar",
            ["missing_references"] = new JsonArray(resolved.Missing.Select(path => (JsonNode?)JsonValue.Create(path)).ToArray()),
            ["project_root"] = projectRoot,
        };
    }

    /// <summary>
    /// Classify a batch of edits as hot-patchable or not.
    ///
    /// The rule is the one upstream's <c>analyze/hotDiff</c> applies, reduced to
    /// what can be decided without Unity's serialized schema: an edit is hot
    /// when every change is inside a member body (method, constructor,
    /// accessor, field initializer) or adds a new member, and cold when it
    /// touches a type declaration, a field/property/event declaration, an
    /// attribute, the signature of an existing member, or adds a new type.
    /// Anything this cannot decide is cold: a wrong "hot" would patch the
    /// running editor with an assembly that cannot apply, which is worse than
    /// asking for a real recompile.
    /// </summary>
    public static JsonObject AnalyzeHotDiff(JsonArray? files, string? projectRoot)
    {
        var results = new JsonArray();
        bool allHot = files != null && files.Count > 0;
        if (files == null)
            return new JsonObject { ["hot"] = false, ["files"] = results };

        var parseOptions = new CSharpParseOptions(
            languageVersion: LanguageVersion.Latest,
            documentationMode: DocumentationMode.None);

        foreach (JsonNode? node in files)
        {
            if (node is not JsonObject file)
                throw new RpcInvalidParamsException("each files[] entry must be an object with path/oldText/newText");

            string path = file["path"]?.GetValue<string>() ?? string.Empty;
            string oldText = file["oldText"]?.GetValue<string>() ?? string.Empty;
            string newText = file["newText"]?.GetValue<string>() ?? string.Empty;

            FileDiff diff = DiffFile(oldText, newText, parseOptions);
            if (!diff.Hot)
                allHot = false;
            results.Add(new JsonObject
            {
                ["path"] = path,
                ["hot"] = diff.Hot,
                ["reason"] = diff.Reason,
                ["methods"] = new JsonArray(diff.Methods.Select(PatchMethodJson).ToArray()),
                ["added_types"] = new JsonArray(diff.AddedTypes.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()),
                ["added_fields"] = new JsonArray(diff.AddedFields.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()),
                ["added_members"] = new JsonArray(diff.AddedMembers.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()),
            });
        }

        return new JsonObject { ["hot"] = allHot, ["project_root"] = projectRoot, ["files"] = results };
    }

    private static JsonObject PatchMethodJson(PatchMethod method) => new()
    {
        ["declaring_type"] = method.DeclaringType,
        ["patch_declaring_type"] = method.PatchDeclaringType,
        ["name"] = method.Name,
        ["param_type_names"] = new JsonArray(method.ParamTypes.Select(type => (JsonNode?)JsonValue.Create(type)).ToArray()),
        ["is_static"] = method.IsStatic,
        ["is_ctor"] = method.IsCtor,
        ["original_assembly"] = method.OriginalAssembly,
    };

    /// <summary>A method whose body may be replaced, with the type that carries the fix.</summary>
    public sealed class PatchMethod
    {
        public string DeclaringType { get; init; } = string.Empty;
        public string PatchDeclaringType { get; init; } = string.Empty;
        public string Name { get; init; } = string.Empty;
        public List<string> ParamTypes { get; init; } = new();
        public bool IsStatic { get; init; }
        public bool IsCtor { get; init; }
        public string? OriginalAssembly { get; init; }
    }

    /// <summary>The classification of one file.</summary>
    public sealed class FileDiff
    {
        public bool Hot { get; init; }
        public string? Reason { get; init; }
        public List<PatchMethod> Methods { get; } = new();
        public List<string> AddedTypes { get; } = new();
        public List<string> AddedFields { get; } = new();
        public List<string> AddedMembers { get; } = new();
    }

    /// <summary>
    /// Compare two revisions of one file and decide whether the change is hot.
    ///
    /// Comparison happens at the member level rather than at the text level:
    /// whitespace, comments and using order are irrelevant, while a changed
    /// signature or attribute is decisive. Every type that exists in both
    /// revisions is walked member by member.
    /// </summary>
    public static FileDiff DiffFile(string oldText, string newText, CSharpParseOptions parseOptions)
    {
        SyntaxTree oldTree = CSharpSyntaxTree.ParseText(oldText, parseOptions);
        SyntaxTree newTree = CSharpSyntaxTree.ParseText(newText, parseOptions);

        var oldTypes = TypeIndex.Build(oldTree);
        var newTypes = TypeIndex.Build(newTree);
        var diff = new FileDiffBuilder();

        foreach (string name in newTypes.Keys)
        {
            if (!oldTypes.ContainsKey(name))
            {
                // A brand-new type is not hot: the original assembly has no
                // counterpart to patch, so the running domain has nowhere to put it.
                diff.AddedTypes.Add(name);
                diff.Cold("adds type " + name);
            }
        }

        foreach ((string name, TypeShape oldShape) in oldTypes)
        {
            if (!newTypes.TryGetValue(name, out TypeShape? newShape))
            {
                diff.Cold("removes type " + name);
                continue;
            }

            if (oldShape.Kind != newShape.Kind)
            {
                diff.Cold("changes the kind of " + name);
                continue;
            }

            if (!oldShape.BaseList.Equals(newShape.BaseList, StringComparison.Ordinal))
            {
                diff.Cold("changes the base list of " + name);
                continue;
            }

            CompareMembers(name, oldShape, newShape, diff);
        }

        FileDiff result = diff.Build();
        return result;
    }

    private static void CompareMembers(string typeName, TypeShape oldShape, TypeShape newShape, FileDiffBuilder diff)
    {
        foreach ((string key, MemberShape member) in oldShape.Members)
        {
            if (!newShape.Members.TryGetValue(key, out MemberShape? updated))
            {
                diff.Cold("removes member " + key + " of " + typeName);
                continue;
            }

            if (updated.Fingerprint != member.Fingerprint)
            {
                diff.Cold("changes the signature of " + key + " in " + typeName);
                continue;
            }

            if (member.Body != updated.Body)
            {
                diff.Methods.Add(new PatchMethod
                {
                    DeclaringType = typeName,
                    PatchDeclaringType = PatchTypeName(typeName),
                    Name = member.Name,
                    ParamTypes = member.ParamTypes,
                    IsStatic = member.IsStatic,
                    IsCtor = member.IsCtor,
                    OriginalAssembly = null,
                });
            }
        }

        foreach (string key in newShape.Members.Keys)
        {
            if (oldShape.Members.ContainsKey(key))
                continue;
            // Adding a member is hot for a method (a new overload), cold for a
            // field: the object layout is already fixed in the running domain.
            if (newShape.Members[key].IsFieldLike)
            {
                diff.AddedFields.Add(key);
                diff.Cold("adds field " + key + " to " + typeName);
            }
            else
            {
                diff.AddedMembers.Add(key);
            }
        }
    }

    /// <summary>
    /// The name of the patch type that shadows <paramref name="declaringType"/>.
    ///
    /// Deterministic and reversible: the patcher looks the type up by name, so
    /// two builds of the same edit must produce the same string.
    /// </summary>
    public static string PatchTypeName(string declaringType)
    {
        string flat = declaringType.Replace('+', '.').Replace('.', '_');
        return "__DshPatch_" + flat;
    }

    /// <summary>All type declarations in one tree, keyed by their full name.</summary>
    private sealed class TypeIndex
    {
        private readonly Dictionary<string, TypeShape> _types = new(StringComparer.Ordinal);

        public IReadOnlyDictionary<string, TypeShape> Types => _types;

        public static SortedDictionary<string, TypeShape> Build(SyntaxTree tree)
        {
            var index = new SortedDictionary<string, TypeShape>(StringComparer.Ordinal);
            foreach (BaseTypeDeclarationSyntax type in tree.GetRoot().DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
            {
                List<string> parts = new();
                for (SyntaxNode? parent = type.Parent; parent != null; parent = parent.Parent)
                {
                    if (parent is BaseTypeDeclarationSyntax container)
                        parts.Insert(0, container.Identifier.Text);
                }
                string name = parts.Count == 0 ? type.Identifier.Text : string.Join(".", parts) + "." + type.Identifier.Text;
                if (index.ContainsKey(name))
                {
                    // Partial declarations merge in the runtime, but re-deriving
                    // one shape from two files is not something this can decide,
                    // so the second declaration just gets a distinct key.
                    int suffix = 2;
                    while (index.ContainsKey(name + "#" + suffix))
                        suffix++;
                    name = name + "#" + suffix;
                }
                index[name] = TypeShape.From(type);
            }
            return index;
        }
    }

    /// <summary>What a type looked like in one revision, at member granularity.</summary>
    private sealed class TypeShape
    {
        public string Kind { get; private init; } = string.Empty;
        public string BaseList { get; private init; } = string.Empty;
        public SortedDictionary<string, MemberShape> Members { get; } = new(StringComparer.Ordinal);

        public static TypeShape From(BaseTypeDeclarationSyntax type)
        {
            var shape = new TypeShape
            {
                Kind = type switch
                {
                    ClassDeclarationSyntax => "class",
                    StructDeclarationSyntax => "struct",
                    InterfaceDeclarationSyntax => "interface",
                    RecordDeclarationSyntax => "record",
                    _ => "enum",
                },
                BaseList = type.BaseList?.ToString() ?? string.Empty,
            };

            foreach (MemberDeclarationSyntax member in DeclaredMembers(type))
            {
                MemberShape? declared = MemberShape.From(member);
                if (declared == null)
                    continue;
                shape.Members[declared.Key] = declared;
            }
            return shape;
        }

        /// <summary>The members of any type declaration, enums included.</summary>
        private static SyntaxList<MemberDeclarationSyntax> DeclaredMembers(BaseTypeDeclarationSyntax type) =>
            type is TypeDeclarationSyntax declaration
                ? declaration.Members
                : default;
    }

    /// <summary>What one member looked like, split into signature and body.</summary>
    private sealed class MemberShape
    {
        public string Key { get; private init; } = string.Empty;
        public string Name { get; private init; } = string.Empty;
        public string Fingerprint { get; private init; } = string.Empty;
        public string Body { get; private init; } = string.Empty;
        public List<string> ParamTypes { get; private init; } = new();
        public bool IsStatic { get; private init; }
        public bool IsCtor { get; private init; }
        public bool IsFieldLike { get; private init; }

        public static MemberShape? From(MemberDeclarationSyntax member)
        {
            switch (member)
            {
                case FieldDeclarationSyntax field:
                {
                    string key = "field:" + string.Join(",", field.Declaration.Variables.Select(v => v.Identifier.Text));
                    string body = string.Join(",", field.Declaration.Variables.Select(v => v.Initializer?.Value.ToString() ?? string.Empty));
                    return new MemberShape
                    {
                        Key = key,
                        Name = field.Declaration.Variables.FirstOrDefault()?.Identifier.Text ?? key,
                        Fingerprint = Signature(field) + "|" + field.Modifiers,
                        Body = body,
                        IsStatic = field.Modifiers.Any(SyntaxKind.StaticKeyword),
                        IsFieldLike = true,
                    };
                }
                case PropertyDeclarationSyntax property:
                {
                    string accessors = string.Join(",", property.AccessorList?.Accessors.Select(a => a.Keyword.Text + (a.Body != null ? "{}" : ";") + (a.ExpressionBody != null ? "=>" : string.Empty)) ?? Enumerable.Empty<string>());
                    string body = string.Join("|",
                        property.AccessorList?.Accessors.Select(a => a.Body?.ToString() ?? a.ExpressionBody?.Expression.ToString() ?? string.Empty)
                        ?? Enumerable.Empty<string>());
                    return new MemberShape
                    {
                        Key = "property:" + property.Identifier.Text,
                        Name = property.Identifier.Text,
                        Fingerprint = Signature(property) + "|" + accessors + "|" + property.Modifiers,
                        Body = body,
                        IsStatic = property.Modifiers.Any(SyntaxKind.StaticKeyword),
                        IsFieldLike = true,
                    };
                }
                case EventDeclarationSyntax customEvent:
                    return new MemberShape
                    {
                        Key = "event:" + customEvent.Identifier.Text,
                        Name = customEvent.Identifier.Text,
                        Fingerprint = Signature(customEvent) + "|" + customEvent.Modifiers,
                        Body = string.Empty,
                        IsStatic = customEvent.Modifiers.Any(SyntaxKind.StaticKeyword),
                        IsFieldLike = true,
                    };
                case EventFieldDeclarationSyntax eventField:
                    return new MemberShape
                    {
                        Key = "event:" + string.Join(",", eventField.Declaration.Variables.Select(v => v.Identifier.Text)),
                        Name = eventField.Declaration.Variables.FirstOrDefault()?.Identifier.Text ?? "event",
                        Fingerprint = Signature(eventField) + "|" + eventField.Modifiers,
                        Body = eventField.Declaration.Variables.FirstOrDefault()?.Initializer?.Value.ToString() ?? string.Empty,
                        IsStatic = eventField.Modifiers.Any(SyntaxKind.StaticKeyword),
                        IsFieldLike = true,
                    };
                case MethodDeclarationSyntax method:
                    return new MemberShape
                    {
                        Key = "method:" + method.Identifier.Text + "(" + string.Join(",", method.ParameterList.Parameters.Select(ParameterKey)) + ")",
                        Name = method.Identifier.Text,
                        Fingerprint = Signature(method) + "|" + method.Modifiers + "|" + method.TypeParameterList,
                        Body = method.Body?.ToString() ?? method.ExpressionBody?.Expression.ToString() ?? string.Empty,
                        ParamTypes = method.ParameterList.Parameters.Select(ParameterType).ToList(),
                        IsStatic = method.Modifiers.Any(SyntaxKind.StaticKeyword),
                    };
                case ConstructorDeclarationSyntax constructor:
                    return new MemberShape
                    {
                        Key = "ctor(" + string.Join(",", constructor.ParameterList.Parameters.Select(ParameterKey)) + ")",
                        Name = ".ctor",
                        Fingerprint = Signature(constructor) + "|" + constructor.Modifiers,
                        Body = constructor.Body?.ToString() ?? constructor.ExpressionBody?.Expression.ToString() ?? string.Empty,
                        ParamTypes = constructor.ParameterList.Parameters.Select(ParameterType).ToList(),
                        IsStatic = constructor.Modifiers.Any(SyntaxKind.StaticKeyword),
                        IsCtor = true,
                    };
                case IndexerDeclarationSyntax indexer:
                    return new MemberShape
                    {
                        Key = "indexer(" + string.Join(",", indexer.ParameterList.Parameters.Select(ParameterKey)) + ")",
                        Name = "Item",
                        Fingerprint = Signature(indexer) + "|" + indexer.Modifiers,
                        Body = string.Join("|", indexer.AccessorList?.Accessors.Select(a => a.Body?.ToString() ?? a.ExpressionBody?.Expression.ToString() ?? string.Empty) ?? Enumerable.Empty<string>()),
                        ParamTypes = indexer.ParameterList.Parameters.Select(ParameterType).ToList(),
                        IsStatic = indexer.Modifiers.Any(SyntaxKind.StaticKeyword),
                    };
                case OperatorDeclarationSyntax op:
                    return new MemberShape
                    {
                        Key = "operator:" + op.OperatorToken.Text + "(" + string.Join(",", op.ParameterList.Parameters.Select(ParameterKey)) + ")",
                        Name = "op_" + op.OperatorToken.Text,
                        Fingerprint = Signature(op) + "|" + op.Modifiers,
                        Body = op.Body?.ToString() ?? op.ExpressionBody?.Expression.ToString() ?? string.Empty,
                        ParamTypes = op.ParameterList.Parameters.Select(ParameterType).ToList(),
                        IsStatic = true,
                    };
                case TypeDeclarationSyntax nested:
                {
                    string key = "type:" + nested.Identifier.Text;
                    return new MemberShape
                    {
                        Key = key,
                        Name = nested.Identifier.Text,
                        // A nested type's own members are walked on their own key
                        // in TypeIndex; here only its declaration matters.
                        Fingerprint = "type|" + Signature(nested),
                        Body = nested.ToFullString(),
                        IsFieldLike = true,
                    };
                }
                default:
                    return null;
            }
        }

        private static string Signature(MemberDeclarationSyntax member) =>
            string.Join(" ", member.ChildNodes().OfType<TypeSyntax>().Select(type => type.ToString())) +
            " " + (member.AttributeLists.ToString());

        private static string ParameterKey(ParameterSyntax parameter) =>
            (parameter.Type?.ToString() ?? string.Empty) + " " + (parameter.Identifier.Text);

        private static string ParameterType(ParameterSyntax parameter) =>
            parameter.Type?.ToString() ?? string.Empty;
    }

    /// <summary>Accumulates the cold reasons for one file.</summary>
    private sealed class FileDiffBuilder
    {
        private readonly List<string> _reasons = new();

        public List<PatchMethod> Methods { get; } = new();
        public List<string> AddedTypes { get; } = new();
        public List<string> AddedFields { get; } = new();
        public List<string> AddedMembers { get; } = new();

        public void Cold(string reason)
        {
            if (!_reasons.Contains(reason))
                _reasons.Add(reason);
        }

        public FileDiff Build()
        {
            bool hot = _reasons.Count == 0;
            FileDiff result = new()
            {
                Hot = hot,
                Reason = hot ? null : string.Join("; ", _reasons),
            };
            foreach (PatchMethod method in Methods)
                result.Methods.Add(method);
            foreach (string name in AddedTypes)
                result.AddedTypes.Add(name);
            foreach (string name in AddedFields)
                result.AddedFields.Add(name);
            foreach (string name in AddedMembers)
                result.AddedMembers.Add(name);
            return result;
        }
    }

    /// <summary>Unity's scripting define symbols, both platforms, from ProjectSettings.</summary>
    private static List<string> ReadDefines(string? projectRoot)
    {
        var defines = new SortedSet<string>(StringComparer.Ordinal) { "UNITY_EDITOR" };
        foreach (string fileName in new[] { "ProjectSettings.asset", "ProjectSettings/ProjectSettings.asset" })
        {
            string path = projectRoot == null ? string.Empty : Path.Combine(projectRoot, fileName);
            if (path.Length == 0 || !File.Exists(path))
                continue;
            foreach (string key in new[] { "scriptingDefineSymbols" })
            {
                List<string>? found = ReadYamlList(path, key);
                if (found == null)
                    continue;
                foreach (string entry in found)
                {
                    // The value is `<<key>>: DEFINE;OTHER` — a per-platform map.
                    int colon = entry.IndexOf(':');
                    string list = colon >= 0 ? entry[(colon + 1)..] : entry;
                    foreach (string define in list.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                        defines.Add(define);
                }
            }
            break;
        }
        return defines.ToList();
    }

    /// <summary>Whether `allowUnsafeCode` is on for any player configuration.</summary>
    private static bool ReadAllowUnsafe(string? projectRoot)
    {
        if (projectRoot == null)
            return false;
        string path = Path.Combine(projectRoot, "ProjectSettings", "ProjectSettings.asset");
        if (!File.Exists(path))
            return false;
        try
        {
            foreach (string line in File.ReadLines(path))
            {
                string trimmed = line.TrimStart();
                if (trimmed.StartsWith("allowUnsafeCode:", StringComparison.Ordinal) &&
                    trimmed.EndsWith("1", StringComparison.Ordinal))
                {
                    return true;
                }
            }
        }
        catch
        {
            // An unreadable settings file is not a compile failure.
        }
        return false;
    }

    /// <summary>
    /// Every `- value` scalar nested under `key:` in a Unity YAML file.
    ///
    /// This is deliberately tiny: Unity settings are warm-upground for a full YAML
    /// parser (the file is 2000 lines of hand-indented mapping), and the only thing
    /// needed here is the list under <c>scriptingDefineSymbols</c>.
    /// </summary>
    private static List<string>? ReadYamlList(string path, string key)
    {
        try
        {
            string[] lines = File.ReadAllLines(path);
            List<string> values = new();
            int keyIndent = -1;
            for (int index = 0; index < lines.Length; index++)
            {
                string line = lines[index];
                string trimmed = line.TrimStart();
                int indent = line.Length - trimmed.Length;
                if (keyIndent < 0)
                {
                    if (!trimmed.StartsWith(key + ":", StringComparison.Ordinal))
                        continue;
                    keyIndent = indent;
                    continue;
                }
                if (trimmed.Length > 0 && indent <= keyIndent && !trimmed.StartsWith("- ", StringComparison.Ordinal))
                    break;
                if (trimmed.StartsWith("- ", StringComparison.Ordinal))
                    values.Add(trimmed[2..].Trim());
            }
            return values.Count == 0 ? null : values;
        }
        catch
        {
            return null;
        }
    }
}
