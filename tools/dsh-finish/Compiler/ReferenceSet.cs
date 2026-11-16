using System.Collections.Immutable;
using System.Reflection.PortableExecutable;
using Microsoft.CodeAnalysis;

namespace Locus.DshFinish.Compiler;

/// <summary>
/// Where a compilation's metadata references come from.
///
/// Three tiers, in the order <see cref="Resolve"/> prefers them:
///
///   1. <c>references</c> from the request — explicit <c>{path}</c> entries.
///      Missing files are skipped silently (the caller sees the resulting
///      missing-symbol diagnostics, which name the type, not the DLL).
///   2. The project's Unity reference set: <c>Library/ScriptAssemblies/*.dll</c>
///      when the project has compiled at least once, otherwise the editor's
///      managed assemblies. This is what makes a snippet able to type-check
///      <c>GameObject</c> / <c>EditorUtility</c> calls without an editor.
///   3. The host .NET reference set (<c>TRUSTED_PLATFORM_ASSEMBLIES</c>), so
///      <c>compile/snippet</c> always works even with no Unity project at all.
///
/// Ported from upstream <c>ReferenceCache</c>'s loading strategy
/// (<c>ModuleMetadata</c> + <c>PEStreamOptions.PrefetchMetadata</c>, so no file
/// handle outlives the load — Unity rewrites <c>ScriptAssemblies</c> on every
/// recompile). Unlike upstream this class caches nothing: one sidecar process
/// handles a handful of requests per session, and a stale cache is a worse
/// failure than a re-read.
/// </summary>
public static class ReferenceSet
{
    /// <summary>A compilation's references plus the paths that failed to load.</summary>
    public sealed class Resolved
    {
        public ImmutableArray<MetadataReference> References { get; init; } = ImmutableArray<MetadataReference>.Empty;
        public List<string> Missing { get; } = new();
        public string Origin { get; init; } = "host";
        public int Count => References.Length;
    }

    /// <summary>
    /// Resolve the reference set for one compilation.
    /// </summary>
    /// <param name="projectRoot">Unity project root, or null for none.</param>
    /// <param name="explicitPaths">Request-supplied <c>references[].path</c> values.</param>
        public static Resolved Resolve(string? projectRoot, IEnumerable<string>? explicitPaths)
    {
        var resolved = new Resolved();

        var explicitRefs = new List<MetadataReference>();
        if (explicitPaths != null)
        {
            foreach (string path in explicitPaths)
            {
                if (string.IsNullOrWhiteSpace(path))
                    continue;
                PortableExecutableReference? reference = TryLoad(path, resolved.Missing);
                if (reference != null)
                    explicitRefs.Add(reference);
            }
        }

        // An explicit Unity set (ScriptAssemblies, or the engine modules from
        // an editor install) does not carry the BCL: Unity compiles against
        // Mono's profile, and those assemblies are reference-only. Pairing such
        // a set with the host's .NET 10 runtime assemblies is invalid — the
        // runtime versions of System.Private.CoreLib have no metadata for
        // Roslyn to resolve System.Object through — so the reference pack is
        // used instead, which is exactly what those profile assemblies expect.
        if (explicitRefs.Count > 0)
        {
            string? facadePath = PackFile("netstandard.library.ref", "netstandard2.1", "ref", "netstandard.dll");
            if (facadePath != null &&
                TryLoad(facadePath, resolved.Missing) is { } facade)
            {
                explicitRefs.Add(facade);
            }

            if (ReferencePackPaths() is { Count: > 0 } packPaths && ExplicitSetIsUnity(explicitRefs, explicitPaths))
            {
                foreach (string path in packPaths)
                {
                    PortableExecutableReference? reference = TryLoad(path, resolved.Missing);
                    if (reference != null)
                        explicitRefs.Add(reference);
                }
            }

            return new Resolved { References = explicitRefs.ToImmutableArray(), Origin = "explicit" };
        }

        List<string>? unityPaths = UnityReferencePaths(projectRoot);
        if (unityPaths != null && unityPaths.Count > 0)
        {
            var builder = ImmutableArray.CreateBuilder<MetadataReference>(unityPaths.Count);
            foreach (string path in unityPaths)
            {
                PortableExecutableReference? reference = TryLoad(path, resolved.Missing);
                if (reference != null)
                    builder.Add(reference);
            }
            if (builder.Count > 0)
                return new Resolved { References = builder.ToImmutable(), Origin = "unity" };
        }

        var host = ImmutableArray.CreateBuilder<MetadataReference>();
        if (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is string tpa)
        {
            foreach (string path in tpa.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                PortableExecutableReference? reference = TryLoad(path, resolved.Missing);
                if (reference != null)
                    host.Add(reference);
            }
        }
        return new Resolved { References = host.ToImmutable(), Origin = "host" };
    }

    /// <summary>
    /// The project's Unity assemblies, or null when the project has none.
    /// </summary>
    public static List<string>? UnityReferencePaths(string? projectRoot)
    {
        if (string.IsNullOrWhiteSpace(projectRoot))
            return null;

        string root;
        try
        {
            root = Path.GetFullPath(projectRoot);
        }
        catch
        {
            return null;
        }

        // ScriptAssemblies first: the project's own compiled types, which is
        // what a snippet most often touches. It does NOT contain the engine
        // itself, though — `UnityEngine.CoreModule` and friends live in the
        // editor install — so the editor's managed assemblies are appended
        // after it. Returning ScriptAssemblies alone compiled every snippet
        // against a world with no `GameObject` in it.
        var paths = new List<string>();
        string scriptAssemblies = Path.Combine(root, "Library", "ScriptAssemblies");
        paths.AddRange(DllsIn(scriptAssemblies));
        string versionFile = Path.Combine(root, "ProjectSettings", "ProjectVersion.txt");
        if (File.Exists(versionFile))
        {
            try
            {
                foreach (string line in File.ReadLines(versionFile))
                {
                    string trimmed = line.Trim();
                    if (!trimmed.StartsWith("m_EditorVersion:", StringComparison.Ordinal))
                        continue;
                    string? version = trimmed["m_EditorVersion:".Length..].Trim();
                    if (string.IsNullOrEmpty(version))
                        break;
                    foreach (string editorRoot in EditorInstallRoots())
                    {
                        string managed = Path.Combine(editorRoot, version, "Editor", "Data", "Managed", "UnityEngine");
                        paths.AddRange(DllsIn(managed));
                        if (paths.Count > 0 && Directory.Exists(managed))
                            break;
                    }
                    break;
                }
            }
            catch
            {
                // An unreadable version file just means tier 2 stays project-only.
            }
        }

        return paths.Count > 0 ? paths : null;
    }

    /// <summary>
    /// Candidate roots that hold Unity editor installs, in the order Unity Hub
    /// looks: the per-user Hub location first, then the platform defaults and
    /// finally `UNITY_EDITOR_PATH`.
    /// </summary>
    private static IEnumerable<string> EditorInstallRoots()
    {
        string? explicitPath = Environment.GetEnvironmentVariable("UNITY_EDITOR_PATH");
        if (!string.IsNullOrWhiteSpace(explicitPath))
        {
            // Pointing at one editor install: its parent is the version root.
            yield return Path.GetFullPath(Path.Combine(explicitPath, "..", ".."));
        }

        string? home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrEmpty(home))
        {
            string hub = Path.Combine(home, "Unity", "Hub", "Editor");
            if (OperatingSystem.IsMacOS())
                yield return Path.Combine(home, "Applications", "Unity", "Hub", "Editor");
            else
                yield return hub;
        }

        if (OperatingSystem.IsWindows())
        {
            yield return @"C:\Program Files\Unity\Hub\Editor";
            yield return @"C:\Program Files\Unity\Editor";
            yield return @"C:\Program Files (x86)\Unity\Hub\Editor";
        }
        else if (OperatingSystem.IsMacOS())
        {
            yield return "/Applications/Unity/Hub/Editor";
        }
        else
        {
            string? opt = "/opt/unity/editors";
            if (Directory.Exists(opt))
                yield return opt;
        }
    }


    /// <summary>
    /// Whether an explicit set looks like Unity's: any engine or project
    /// assembly is a strong enough signal, since a host-set caller never passes
    /// those.
    /// </summary>
    private static bool ExplicitSetIsUnity(List<MetadataReference> references, IEnumerable<string>? paths)
    {
        if (paths == null)
            return false;
        foreach (string path in paths)
        {
            string name = Path.GetFileNameWithoutExtension(path);
            if (name.StartsWith("UnityEngine", StringComparison.Ordinal) ||
                name.StartsWith("UnityEditor", StringComparison.Ordinal) ||
                name.StartsWith("Unity.", StringComparison.Ordinal) ||
                name == "Assembly-CSharp" ||
                name == "Assembly-CSharp-Editor")
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// The reference assemblies of whatever .NET framework flavour this sidecar
    /// itself was built for (<c>Microsoft.NETCore.App.Ref</c>, or
    /// <c>NETStandard.Library.Ref</c> for a netstandard2.1 target). They are
    /// reference-only, so they can share a compilation with Unity's assemblies
    /// without the CS1703 duplicate-identity errors the runtime copies produce.
    /// </summary>
    public static List<string>? ReferencePackPaths()
    {
        const string framework = "Microsoft.NETCore.App.Ref";
        foreach (string baseDir in PackRoots())
        {
            string root = Path.Combine(baseDir, framework);
            if (!Directory.Exists(root))
                continue;

            // Newest pack version; the pack version and target version differ,
            // so pick the newest of the matching target-framework folders.
            string? refDir = null;
            foreach (string version in Directory.EnumerateDirectories(root).OrderByDescending(d => d, StringComparer.Ordinal))
            {
                string candidate = Path.Combine(version, "ref", TargetMoniker);
                if (Directory.Exists(candidate))
                {
                    refDir = candidate;
                    break;
                }
            }

            if (refDir != null)
                return DllsIn(refDir);
        }

        return null;
    }

    /// <summary>Target-framework moniker this sidecar was built for.</summary>
    private static string TargetMoniker
    {
        get
        {
            string version = Environment.Version.Major + "." + Environment.Version.Minor;
            return "net" + version;
        }
    }

    /// <summary>
    /// Every <c>packs</c> directory that could hold a reference pack: the
    /// runtime's own (<c>DOTNET_ROOT/packs</c>), and the location relative to
    /// this assembly, which is the same layout a self-contained publish uses.
    /// </summary>
    private static IEnumerable<string> PackRoots()
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (string candidate in CandidatePackRoots())
        {
            string full;
            try
            {
                full = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar);
            }
            catch
            {
                continue;
            }

            if (!Directory.Exists(full) || !seen.Add(full))
                continue;
            yield return full;
        }
    }

    private static IEnumerable<string> CandidatePackRoots()
    {
        string? runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (!string.IsNullOrEmpty(runtimeDir))
        {
            // <dotnet>/shared/Microsoft.NETCore.App/<version>/ -> <dotnet>/packs
            string? dotnetRoot = Path.GetFullPath(Path.Combine(runtimeDir, "..", "..", ".."));
            yield return Path.Combine(dotnetRoot, "packs");
        }

        string? envRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        if (!string.IsNullOrEmpty(envRoot))
            yield return Path.Combine(envRoot, "packs");

        string? assemblyDir = Path.GetDirectoryName(typeof(ReferenceSet).Assembly.Location);
        if (!string.IsNullOrEmpty(assemblyDir))
        {
            yield return Path.Combine(assemblyDir, "packs");
            yield return Path.Combine(assemblyDir, "ref");
        }
    }

    /// <summary>
    /// A pack file by pack id and relative path, or null when that pack is not
    /// installed on this machine.
    /// </summary>
    private static string? PackFile(string packId, string version, string kind, string fileName)
    {
        foreach (string root in PackRoots())
        {
            string candidate = Path.Combine(root, packId, version, kind, fileName);
            if (File.Exists(candidate))
                return candidate;
        }
        return null;
    }

    private static List<string> DllsIn(string dir)
    {
        var found = new List<string>();
        if (!Directory.Exists(dir))
            return found;
        try
        {
            foreach (string path in Directory.EnumerateFiles(dir, "*.dll", SearchOption.TopDirectoryOnly))
                found.Add(path);
        }
        catch
        {
            // An unreadable directory is the same as an empty one here: the
            // caller falls back to the next tier.
        }
        found.Sort(StringComparer.Ordinal);
        return found;
    }

    private static PortableExecutableReference? TryLoad(string path, List<string> missing)
    {
        try
        {
            if (!File.Exists(path))
            {
                missing.Add(path);
                return null;
            }
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            var module = ModuleMetadata.CreateFromStream(stream, PEStreamOptions.PrefetchMetadata);
            return AssemblyMetadata.Create(module).GetReference(filePath: path);
        }
        catch
        {
            missing.Add(path);
            return null;
        }
    }
}