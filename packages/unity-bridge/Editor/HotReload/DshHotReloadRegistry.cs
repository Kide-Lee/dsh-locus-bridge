using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

using UnityEditor;
using UnityEngine;

namespace DshBridge.HotReload
{
    /// <summary>
    /// 本包自己的 detour 台账——这是本功能最关键的一条设计决定。
    ///
    /// payload（<c>payload/locus_unity/Editor/LocusBridge.HotReload.cs</c>）已经有一条
    /// 热重载路径：桌面端编译补丁程序集后发 <c>hot_patch_loaded</c>，payload 把方法
    /// 记进它私有的 <c>_hotMethodDetours</c>。那条路径属于桌面客户端，本包**绝不**
    /// 复用它，也**绝不**发送 <c>hot_patch_loaded</c>：
    ///   • payload 的台账是桌面端的收敛依据（重编译闸门、会话丢失闸门都按它记账），
    ///     让别人往里塞条目会让桌面端记错账；
    ///   • 同一个原方法上挂两条 detour，谁覆盖谁取决于挂载顺序，拆除时也无法判断
    ///     该恢复哪一版；
    ///   • payload 的补丁缓存按 <c>MethodKey|程序集</c> 键控，DSH 的补丁有自己的
    ///     生命周期（dispose 按 patch_id），混在一起谁都不能独立拆除。
    ///
    /// 所以这里自己维护 <c>Dictionary&lt;MethodBase, Entry&gt;</c>，直接调 MonoMod。
    /// MonoMod 通过反射从 payload 的 Locus.Detour.dll 加载，原因见
    /// <see cref="DetourEngine"/>：asmdef 可以引用它，但只有 payload 真的装在工程
    /// 里时文件才存在，反射能让「缺 payload 文件」退化成一句可读的报错，而不是一
    /// 个用户无从修复的编译失败。
    /// </summary>
    internal static class DshHotReloadRegistry
    {
        internal sealed class Entry
        {
            public IDisposable Detour;
            public string PatchId;
            public string MethodKey;
            public string Engine;
            public MethodBase Original;
            public MethodBase Patch;
            public string OriginalAssembly;
            public DshHotReloadClassifier.MethodIdentity Identity;
        }

        private static readonly object Gate = new object();

        /// <summary>
        /// 补丁类型所在的命名空间（<c>tools/dsh-finish/Compiler/PatchCompiler.cs</c>
        /// 生成源码时写死的）。补丁类型名本身经 <c>PatchTypeName</c> 摊平、不带命名
        /// 空间，所以查找时要先试原名、再试这个前缀。
        /// </summary>
        private const string PatchNamespace = "Locus.DshHotPatch";

        /// <summary>按原方法键控的台账：同一个原方法永远只有一条活跃 detour。</summary>
        private static readonly Dictionary<MethodBase, Entry> Detours = new Dictionary<MethodBase, Entry>();

        private static string _lastError;

        /// <summary>当前域的代次，格式与 payload 的 <c>_compileDomainGeneration</c> 一致（32 位十六进制）。</summary>
        internal static readonly string DomainGeneration = Guid.NewGuid().ToString("N");

        /// <summary>
        /// 本域里最后一次在分类时读到的源文本，按资产路径索引。
        ///
        /// 用途只有一个：热补丁要的是「域里的代码 → 磁盘上的文本」这个差分，而
        /// 差分的前一侧编辑器从来不保存。分类是编辑器侧唯一读文件的时刻，所以把它
        /// 读到的那份文本记下来，就是「域编译时用到的文本」最接近的证据——只要两
        /// 次分类之间没人改过文件。它不是“当前文本”：当前文本永远从磁盘读。
        /// 域重载时随旧域一起丢弃（见 <see cref="OnDomainLoaded"/>）。
        /// </summary>
        private static readonly Dictionary<string, string> CompiledTexts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        internal static void RecordCompiledText(string path, string text)
        {
            if (string.IsNullOrEmpty(path) || text == null)
                return;
            lock (Gate)
            {
                CompiledTexts[path] = text;
            }
        }

        /// <summary>该路径上次分类时的文本；本域没读过就返回 null（调用方据此要求重编译）。</summary>
        internal static string CompiledText(string path)
        {
            if (string.IsNullOrEmpty(path))
                return null;
            lock (Gate)
            {
                return CompiledTexts.TryGetValue(path, out string text) ? text : null;
            }
        }

        // 补丁程序集的加载代理：补丁引用 payload 的 Locus.HotReload.Runtime.dll 等
        // 预编译依赖，而 Assembly.Load(byte[]) 不会去 payload 目录里找它们。
        private static bool _resolverInstalled;
        private static readonly HashSet<string> ResolverDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        internal static void OnDomainLoaded()
        {
            lock (Gate)
            {
                Detours.Clear();
                // 新域编译的是新文本：上一域记下的“编译文本”对新域没有意义。
                CompiledTexts.Clear();
                _lastError = null;
            }
            // MonoMod 的动态方法/代码页在新域里不存在，状态全部重建。
            DetourEngine.Reset();
        }

        /// <summary>dsh_hot_reload_apply 的实现。整批要么全挂上，要么回滚。</summary>
        internal static string Apply(HotReloadDtos.ApplyRequest request)
        {
            if (request.methods == null || request.methods.Length == 0)
                return HotReloadDtos.Error("apply request has no methods");

            if (!string.IsNullOrEmpty(request.domain_generation) &&
                !string.Equals(request.domain_generation, DomainGeneration, StringComparison.Ordinal))
            {
                // 补丁是对着旧域里的方法体编译的；方法在旧域里的句柄已经失效。
                return HotReloadDtos.Error(
                    "hot patch was compiled for a different domain generation (requested " +
                    request.domain_generation + ", current " + DomainGeneration +
                    "); re-run the edit after the reload settles");
            }

            byte[] assemblyBytes;
            try
            {
                assemblyBytes = ReadAssembly(request, out string assemblySource);
                if (assemblyBytes == null)
                    return HotReloadDtos.Error(assemblySource);
            }
            catch (Exception ex)
            {
                return HotReloadDtos.Error("reading the patch assembly failed: " + ex.Message);
            }

            string patchId = string.IsNullOrEmpty(request.patch_id) ? Guid.NewGuid().ToString("N") : request.patch_id;

            Assembly patchAssembly;
            try
            {
                EnsureResolver();
                patchAssembly = Assembly.Load(assemblyBytes);
            }
            catch (Exception ex)
            {
                return HotReloadDtos.Error("loading the patch assembly failed: " + ex.Message);
            }

            List<HotReloadDtos.SkippedMethod> skipped = new List<HotReloadDtos.SkippedMethod>();
            List<Entry> applied = new List<Entry>();
            string engineSummary = null;

            lock (Gate)
            {
                foreach (HotReloadDtos.ApplyMethod method in request.methods)
                {
                    if (method == null)
                        continue;
                    string methodKey = MethodKey(method);

                    MethodBase original = ResolveOriginal(method, out string error);
                    if (original == null)
                    {
                        skipped.Add(new HotReloadDtos.SkippedMethod { method_key = methodKey, reason = error });
                        continue;
                    }

                    MethodBase patch = ResolvePatch(patchAssembly, method, out error);
                    if (patch == null)
                    {
                        skipped.Add(new HotReloadDtos.SkippedMethod { method_key = methodKey, reason = error });
                        continue;
                    }

                    if (!ValidateSignature(original, patch, out error))
                    {
                        skipped.Add(new HotReloadDtos.SkippedMethod { method_key = methodKey, reason = error });
                        continue;
                    }

                    // 同一个原方法重新打补丁：先摘旧的，再挂新的。摘失败就整批回滚，
                    // 否则会留下「旧 detour 还在、台账却写着新补丁」的状态。
                    Entry previous;
                    Detours.TryGetValue(original, out previous);
                    if (previous != null)
                    {
                        try
                        {
                            previous.Detour.Dispose();
                        }
                        catch (Exception ex)
                        {
                            SkippedAll(method, skipped, "replacing the previous detour failed: " + ex.Message);
                            Rollback(applied, previous, false);
                            return HotReloadDtos.Error("hot patch apply failed (rolled back): " +
                                "disposing the previous detour for " + methodKey + " failed: " + ex.Message);
                        }
                        Detours.Remove(original);
                    }

                    Entry entry;
                    try
                    {
                        IDisposable detour = DetourEngine.Create(original, patch, out string engine);
                        entry = new Entry
                        {
                            Detour = detour,
                            PatchId = patchId,
                            MethodKey = methodKey,
                            Engine = engine,
                            Original = original,
                            Patch = patch,
                            OriginalAssembly = SafeAssemblyName(original),
                        };
                    }
                    catch (Exception ex)
                    {
                        SkippedAll(method, skipped, "creating the detour failed: " + ex.Message);
                        if (previous != null)
                            Rollback(applied, previous, true);
                        return HotReloadDtos.Error("hot patch apply failed (rolled back): " +
                            "creating the detour for " + methodKey + " failed: " + ex.Message);
                    }

                    Detours[original] = entry;
                    applied.Add(entry);
                    engineSummary = engineSummary == null || engineSummary == entry.Engine ? entry.Engine : "mixed";
                    _lastError = null;
                }
            }

            HotReloadDtos.ApplyResponse response = new HotReloadDtos.ApplyResponse
            {
                applied = applied.Count,
                skipped = skipped.ToArray(),
                detour_engine = engineSummary ?? "none",
                domain_generation = DomainGeneration,
            };
            Debug.Log("[dsh-bridge] hot patch " + patchId + ": " + applied.Count + " method(s) detoured, " +
                skipped.Count + " skipped");
            return HotReloadDtos.ToJson(response);
        }

        internal static string Status()
        {
            lock (Gate)
            {
                List<HotReloadDtos.DetourEntry> entries = new List<HotReloadDtos.DetourEntry>(Detours.Count);
                List<string> keys = new List<string>(Detours.Count);
                foreach (KeyValuePair<MethodBase, Entry> pair in Detours)
                {
                    keys.Add(pair.Value.MethodKey);
                    entries.Add(new HotReloadDtos.DetourEntry
                    {
                        method_key = pair.Value.MethodKey,
                        patch_id = pair.Value.PatchId,
                        engine = pair.Value.Engine,
                        declaring_type = pair.Key.DeclaringType != null ? pair.Key.DeclaringType.FullName : "",
                        name = pair.Key.Name,
                        assembly = pair.Value.OriginalAssembly,
                    });
                }

                HotReloadDtos.StatusResponse response = new HotReloadDtos.StatusResponse
                {
                    detours = Detours.Count,
                    patched_methods = keys.ToArray(),
                    entries = entries.ToArray(),
                    domain_generation = DomainGeneration,
                };
                if (!string.IsNullOrEmpty(_lastError))
                    response.last_error = _lastError;
                return HotReloadDtos.ToJson(response);
            }
        }

        /// <summary>dsh_hot_reload_dispose：按补丁拆除，或（patch_id 为空）全部拆除。</summary>
        internal static string Dispose(string patchId)
        {
            int disposed = 0;
            List<string> failures = new List<string>();
            lock (Gate)
            {
                List<MethodBase> targets = new List<MethodBase>();
                foreach (KeyValuePair<MethodBase, Entry> pair in Detours)
                {
                    if (string.IsNullOrEmpty(patchId) || string.Equals(pair.Value.PatchId, patchId, StringComparison.Ordinal))
                        targets.Add(pair.Key);
                }

                foreach (MethodBase original in targets)
                {
                    Entry entry = Detours[original];
                    try
                    {
                        entry.Detour.Dispose();
                        Detours.Remove(original);
                        disposed++;
                    }
                    catch (Exception ex)
                    {
                        failures.Add(entry.MethodKey + ": " + ex.Message);
                    }
                }

                if (failures.Count > 0)
                {
                    // 拆不掉的 detour 仍指向补丁程序集里的方法：程序集一卸载调用就会
                    // 崩，所以这个错误必须留在台账上，不能吞掉。
                    _lastError = "disposing detours failed for " + string.Join("; ", failures);
                    Debug.LogError("[dsh-bridge] " + _lastError);
                }
            }

            HotReloadDtos.DisposeResponse response = new HotReloadDtos.DisposeResponse { disposed = disposed };
            return HotReloadDtos.ToJson(response);
        }

        // ───────────────── 方法解析 ─────────────────

        /// <summary>与 payload 的 <c>MethodKey(dto)</c> 逐字节一致。</summary>
        internal static string MethodKey(HotReloadDtos.ApplyMethod method)
        {
            return (method.declaring_type ?? "") + "|" + (method.name ?? "") + "|" +
                string.Join(",", method.param_type_names ?? new string[0]) + (method.is_static ? "|s" : "|i");
        }

        private static MethodBase ResolveOriginal(HotReloadDtos.ApplyMethod method, out string error)
        {
            error = null;
            Type type = null;
            if (!string.IsNullOrEmpty(method.original_assembly))
            {
                // 目标解析：原方法可能是上一次补丁的 shim，只在其所属程序集里找。
                foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    if (!string.Equals(SafeAssemblyName(assembly), method.original_assembly, StringComparison.Ordinal))
                        continue;
                    type = assembly.GetType(method.declaring_type, false);
                    if (type != null)
                        break;
                }
                if (type == null)
                {
                    error = "type " + method.declaring_type + " not found in assembly " + method.original_assembly;
                    return null;
                }
            }
            else
            {
                type = ResolveType(method.declaring_type);
                if (type == null)
                {
                    error = "type " + method.declaring_type + " is not loaded in this domain";
                    return null;
                }
            }

            return ResolveMethodOnType(type, method, out error);
        }

        private static Type ResolveType(string metadataName)
        {
            if (string.IsNullOrEmpty(metadataName))
                return null;
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (assembly == null || assembly.IsDynamic)
                    continue;
                // 跳过本包自己挂补丁用的影子程序集，避免解析到补丁里的方法。
                if (assembly.GetName().Name != null && assembly.GetName().Name.StartsWith("LocusDshHotPatch_", StringComparison.Ordinal))
                    continue;
                Type type = null;
                try
                {
                    type = assembly.GetType(metadataName, false);
                }
                catch (Exception)
                {
                    // 程序集里的类型反射异常（罕见）：跳过。
                }
                if (type != null)
                    return type;
            }
            return null;
        }

        private static MethodBase ResolveMethodOnType(Type type, HotReloadDtos.ApplyMethod method, out string error)
        {
            error = null;
            const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance |
                                       BindingFlags.Static | BindingFlags.DeclaredOnly;
            IEnumerable<MethodBase> candidates;
            if (method.is_ctor || method.name == ".ctor")
                candidates = type.GetConstructors(Flags).Cast<MethodBase>();
            else
                candidates = type.GetMethods(Flags).Cast<MethodBase>();

            List<MethodBase> matchingName = new List<MethodBase>();
            foreach (MethodBase candidate in candidates)
            {
                if (method.is_ctor)
                {
                    if (candidate is ConstructorInfo && candidate.IsStatic == method.is_static)
                        matchingName.Add(candidate);
                }
                else if (candidate.Name == method.name && candidate.IsStatic == method.is_static && !candidate.IsGenericMethodDefinition)
                {
                    matchingName.Add(candidate);
                }
            }
            if (matchingName.Count == 0)
            {
                error = "no " + (method.is_ctor ? "constructor" : "method") + " " + method.name +
                    " on " + type.FullName + (method.is_static ? " (static)" : " (instance)");
                return null;
            }

            string[] wantedNames = method.param_type_names ?? new string[0];
            if (wantedNames.Length <= 1)
                return matchingName[0];

            // 重载歧义：先用反射名比参数个数，再用源码里写的限定名比。仍然多于
            // 一个就拒绝——挂错重载比不挂更糟。
            List<MethodBase> byArity = new List<MethodBase>();
            foreach (MethodBase candidate in matchingName)
            {
                if (candidate.GetParameters().Length == wantedNames.Length)
                    byArity.Add(candidate);
            }
            if (byArity.Count == 1)
                return byArity[0];
            if (byArity.Count == 0)
            {
                error = "no overload of " + type.FullName + "." + method.name + " takes " + wantedNames.Length + " argument(s)";
                return null;
            }

            string[] wantedSigs = method.param_type_sigs;
            if (wantedSigs != null && wantedSigs.Length == wantedNames.Length)
            {
                List<MethodBase> bySignature = new List<MethodBase>();
                foreach (MethodBase candidate in byArity)
                {
                    ParameterInfo[] parameters = candidate.GetParameters();
                    bool matches = true;
                    for (int i = 0; i < parameters.Length && matches; i++)
                    {
                        string actual = ReflectionSignature(parameters[i].ParameterType);
                        string wanted = wantedSigs[i] ?? "";
                        matches = actual == wanted;
                    }
                    if (matches)
                        bySignature.Add(candidate);
                }
                if (bySignature.Count == 1)
                    return bySignature[0];
            }

            error = "overload of " + type.FullName + "." + method.name + "(" + string.Join(",", wantedNames) +
                ") is ambiguous in this domain; recompile instead";
            return null;
        }

        private static MethodBase ResolvePatch(Assembly patchAssembly, HotReloadDtos.ApplyMethod method, out string error)
        {
            error = null;
            string typeName = string.IsNullOrEmpty(method.patch_declaring_type) ? method.declaring_type : method.patch_declaring_type;
            Type patchType = patchAssembly.GetType(typeName, false) ?? patchAssembly.GetType(PatchNamespace + "." + typeName, false);
            if (patchType == null)
            {
                error = "patch type " + typeName + " is missing from the patch assembly";
                return null;
            }

            const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance |
                                       BindingFlags.Static | BindingFlags.DeclaredOnly;
            string wanted = string.IsNullOrEmpty(method.patch_name) ? method.name : method.patch_name;
            List<MethodBase> candidates = new List<MethodBase>();
            if (method.is_ctor || wanted == ".ctor")
            {
                foreach (ConstructorInfo ctor in patchType.GetConstructors(Flags))
                    candidates.Add(ctor);
            }
            else
            {
                foreach (MethodInfo candidate in patchType.GetMethods(Flags))
                {
                    if (candidate.Name == wanted && !candidate.IsGenericMethodDefinition)
                        candidates.Add(candidate);
                }
                if (candidates.Count == 0)
                {
                    foreach (MethodInfo candidate in patchType.GetMethods(Flags))
                    {
                        if (candidate.IsStatic && candidate.Name.IndexOf(wanted, StringComparison.Ordinal) >= 0)
                            candidates.Add(candidate);
                    }
                }
            }

            if (candidates.Count == 0)
            {
                error = "patch method " + patchType.FullName + "." + wanted + " is missing";
                return null;
            }
            if (candidates.Count == 1)
                return candidates[0];

            // 多个同名：用参数个数挑，仍不唯一就拒绝。
            List<MethodBase> byArity = new List<MethodBase>();
            int arity = method.param_type_names != null ? method.param_type_names.Length : -1;
            foreach (MethodBase candidate in candidates)
            {
                if (candidate.GetParameters().Length == arity || arity < 0)
                    byArity.Add(candidate);
            }
            if (byArity.Count == 1)
                return byArity[0];
            error = "patch method " + patchType.FullName + "." + wanted + " is ambiguous";
            return null;
        }

        /// <summary>
        /// detour 要求补丁方法的参数表与被补方法完全一致（MonoMod 把原方法的参数
        /// 原样传进去）。这里只比类型，不比返回类型：MonoMod 允许补丁用更宽的返回
        /// 类型，统一按参数表判定。
        /// </summary>
        private static bool ValidateSignature(MethodBase original, MethodBase patch, out string error)
        {
            error = null;
            ParameterInfo[] originalParams = original.GetParameters();
            ParameterInfo[] patchParams = patch.GetParameters();
            bool originalHasThis = !original.IsStatic && !(original is ConstructorInfo);
            int offset = patchParams.Length - originalParams.Length;
            if (originalHasThis && offset == 1)
            {
                // payload 生成的 patch 常带一个 self 参数；多出的第一个参数必须是
                // 声明类型本身。
                if (patchParams[0].ParameterType != original.DeclaringType &&
                    patchParams[0].ParameterType != typeof(object))
                {
                    error = "patch has an unexpected leading parameter " + patchParams[0].ParameterType.Name;
                    return false;
                }
            }
            else if (offset != 0)
            {
                error = "patch parameter count differs from the original (" + originalParams.Length + " vs " + patchParams.Length + ")";
                return false;
            }

            for (int i = 0; i < originalParams.Length; i++)
            {
                Type expected = originalParams[i].ParameterType;
                Type actual = patchParams[i + (originalHasThis && offset == 1 ? 1 : 0)].ParameterType;
                if (expected == actual)
                    continue;
                if (expected.IsByRef && actual.IsByRef && expected.GetElementType() == actual.GetElementType())
                    continue;
                error = "patch parameter " + i + " differs: " + expected.Name + " vs " + actual.Name;
                return false;
            }
            return true;
        }

        private static string ReflectionSignature(Type type)
        {
            if (type.IsByRef)
                return ReflectionSignature(type.GetElementType()) + "&";
            if (type.IsArray)
                return ReflectionSignature(type.GetElementType()) + "[]";
            if (type.IsGenericType)
            {
                string name = type.GetGenericTypeDefinition().FullName ?? type.Name;
                int tick = name.IndexOf('`');
                if (tick >= 0)
                    name = name.Substring(0, tick);
                string arguments = string.Join(",", type.GetGenericArguments().Select(ReflectionSignature));
                return name + "<" + arguments + ">";
            }
            return type.FullName ?? type.Name;
        }

        // ───────────────── 程序集读取与解析 ─────────────────

        private static byte[] ReadAssembly(HotReloadDtos.ApplyRequest request, out string error)
        {
            error = null;
            if (!string.IsNullOrEmpty(request.assembly_b64))
            {
                try
                {
                    return Convert.FromBase64String(request.assembly_b64);
                }
                catch (FormatException ex)
                {
                    error = "assembly_b64 is not valid base64: " + ex.Message;
                    return null;
                }
            }
            if (!string.IsNullOrEmpty(request.assembly_path))
            {
                // 只允许读取项目目录内的文件：这条路径来自工具参数，不能变成
                // 任意文件读取的入口。
                string absolute = Path.GetFullPath(request.assembly_path);
                string root = Path.GetFullPath(Path.Combine(UnityEngine.Application.dataPath, ".."));
                if (!absolute.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                {
                    error = "assembly_path must be inside the project: " + request.assembly_path;
                    return null;
                }
                if (!File.Exists(absolute))
                {
                    error = "assembly_path does not exist: " + request.assembly_path;
                    return null;
                }
                return File.ReadAllBytes(absolute);
            }
            error = "apply request has neither assembly_b64 nor assembly_path";
            return null;
        }

        /// <summary>
        /// 让补丁程序集能解析 payload 的预编译依赖（Locus.HotReload.Runtime.dll 等）。
        /// <c>Assembly.Load(byte[])</c> 的依赖查找走域的探测路径，不包含 payload 的
        /// Roslyn 目录，所以缺了这一步会在加载补丁时抛 FileNotFoundException。
        /// </summary>
        private static void EnsureResolver()
        {
            if (_resolverInstalled)
                return;
            _resolverInstalled = true;

            List<string> directories = DetourEngine.CandidateDirectories();
            if (directories.Count == 0)
                return;

            foreach (string directory in directories)
                ResolverDirectories.Add(directory);

            AppDomain.CurrentDomain.AssemblyResolve += ResolveFromPayload;
        }

        private static Assembly ResolveFromPayload(object sender, ResolveEventArgs args)
        {
            string simpleName = new AssemblyName(args.Name).Name;
            if (string.IsNullOrEmpty(simpleName))
                return null;
            foreach (string directory in ResolverDirectories)
            {
                string candidate = Path.Combine(directory, simpleName + ".dll");
                if (!File.Exists(candidate))
                    continue;
                try
                {
                    return Assembly.LoadFrom(candidate);
                }
                catch (Exception ex)
                {
                    _lastError = "loading " + candidate + " failed: " + ex.Message;
                }
            }
            return null;
        }

        private static string SafeAssemblyName(MethodBase method)
        {
            return method.DeclaringType != null ? SafeAssemblyName(method.DeclaringType.Assembly) : null;
        }

        private static string SafeAssemblyName(Assembly assembly)
        {
            try
            {
                return assembly != null && !assembly.IsDynamic ? assembly.GetName().Name : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void SkippedAll(HotReloadDtos.ApplyMethod method, List<HotReloadDtos.SkippedMethod> skipped, string reason)
        {
            skipped.Add(new HotReloadDtos.SkippedMethod { method_key = MethodKey(method), reason = reason });
        }

        private static void Rollback(List<Entry> applied, Entry previous, bool restorePrevious)
        {
            for (int i = applied.Count - 1; i >= 0; i--)
            {
                Entry entry = applied[i];
                try
                {
                    entry.Detour.Dispose();
                }
                catch (Exception ex)
                {
                    _lastError = "rolling back the detour for " + entry.MethodKey + " failed: " + ex.Message;
                    Debug.LogError("[dsh-bridge] " + _lastError);
                    continue;
                }
                Detours.Remove(entry.Original);
            }
            applied.Clear();

            if (restorePrevious && previous != null)
            {
                // 旧 detour 已被 dispose，无法原地恢复：把它从台账里清掉，让下一次
                // status 如实报告「这个补丁没了」。
                Detours.Remove(previous.Original);
                _lastError = "the detour for " + previous.MethodKey +
                    " was replaced and could not be restored; re-apply the patch";
            }
        }
    }

    /// <summary>
    /// MonoMod 的反射入口。只用到两个类型：
    ///   <c>MonoMod.RuntimeDetour.Detour(MethodBase original, MethodBase replacement)</c>
    ///   <c>MonoMod.RuntimeDetour.NativeDetour(MethodBase from, MethodBase to)</c>
    /// 二者都实现 <see cref="IDisposable"/>，Dispose 即恢复原方法。
    ///
    /// 先试 <c>Detour</c>（托管层替换，兼容性最好），它抛异常再退到
    /// <c>NativeDetour</c>（直接改原生代码头，Mono 某些版本上唯一可行的路径）——
    /// 与 payload 的 <c>CreateMethodDetour</c> 顺序一致，这样两个实现的失败面相同。
    /// </summary>
    internal static class DetourEngine
    {
        private const string RuntimeDetourNamespace = "MonoMod.RuntimeDetour";

        private static ConstructorInfo _detourCtor;
        private static ConstructorInfo _nativeDetourCtor;
        private static bool _probed;
        private static string _unavailable;

        internal static void Reset()
        {
            _detourCtor = null;
            _nativeDetourCtor = null;
            _probed = false;
            _unavailable = null;
        }

        internal static IDisposable Create(MethodBase original, MethodBase replacement, out string engine)
        {
            Probe();
            if (_detourCtor == null && _nativeDetourCtor == null)
                throw new InvalidOperationException(_unavailable ?? "MonoMod is unavailable");

            if (_detourCtor != null)
            {
                try
                {
                    engine = "detour";
                    return (IDisposable)Construct(_detourCtor, original, replacement);
                }
                catch (Exception first)
                {
                    Exception inner = first.InnerException ?? first;
                    if (_nativeDetourCtor == null)
                        throw new InvalidOperationException("Detour failed: " + inner.Message, inner);
                    try
                    {
                        engine = "native_detour";
                        return (IDisposable)Construct(_nativeDetourCtor, original, replacement);
                    }
                    catch (Exception second)
                    {
                        throw new InvalidOperationException(
                            "both detour engines failed: Described by Detour = " + inner.Message +
                            "; NativeDetour = " + (second.InnerException ?? second).Message, second);
                    }
                }
            }

            engine = "native_detour";
            return (IDisposable)Construct(_nativeDetourCtor, original, replacement);
        }

        private static object Construct(ConstructorInfo ctor, MethodBase original, MethodBase replacement)
        {
            try
            {
                return ctor.Invoke(new object[] { original, replacement });
            }
            catch (TargetInvocationException ex)
            {
                throw ex.InnerException ?? ex;
            }
        }

        /// <summary>可以在哪些目录里找 Locus.Detour.dll（也用作补丁程序集的解析目录）。</summary>
        internal static List<string> CandidateDirectories()
        {
            List<string> directories = new List<string>();
            void AddLocal(string directory)
            {
                if (string.IsNullOrEmpty(directory))
                    return;
                try
                {
                    string full = Path.GetFullPath(directory);
                    if (Directory.Exists(full) && !directories.Contains(full))
                        directories.Add(full);
                }
                catch (Exception)
                {
                    // 路径非法：跳过。
                }
            }

            // 1) Locus.Editor 已加载：它的位置就是 payload/Editor。
            try
            {
                Type bridge = Type.GetType("Locus.LocusBridge, Locus.Editor", throwOnError: false);
                if (bridge != null && !bridge.Assembly.IsDynamic && !string.IsNullOrEmpty(bridge.Assembly.Location))
                {
                    string editorDirectory = Path.GetDirectoryName(bridge.Assembly.Location);
                    AddLocal(editorDirectory);
                    // 2) 预编译依赖住在它的 Roslyn 子目录里。
                    AddLocal(Path.Combine(editorDirectory ?? "", "Roslyn"));
                }
            }
            catch (Exception)
            {
                // 反射失败就走下面的目录枚举。
            }

            // 3) Locus 包可能装在 Packages/（内置包）或 Library/PackageCache/（缓存包）。
            string root = Path.GetFullPath(Path.Combine(UnityEngine.Application.dataPath, ".."));
            AddLocal(Path.Combine(root, "Packages", "com.farlocus.locus", "Editor"));
            AddLocal(Path.Combine(root, "Packages", "com.farlocus.locus", "Editor", "Roslyn"));
            try
            {
                string packageCache = Path.Combine(root, "Library", "PackageCache");
                if (Directory.Exists(packageCache))
                {
                    foreach (string directory in Directory.GetDirectories(packageCache, "com.farlocus.locus*"))
                    {
                        AddLocal(Path.Combine(directory, "Editor"));
                        AddLocal(Path.Combine(directory, "Editor", "Roslyn"));
                    }
                }
            }
            catch (Exception)
            {
                // 缓存目录读不了：忽略，前面的候选已经足够。
            }

            return directories;
        }

        private static void Probe()
        {
            if (_probed)
                return;
            _probed = true;

            Assembly detourAssembly = FindDetourAssembly(out string problem);
            if (detourAssembly == null)
            {
                _unavailable = problem;
                return;
            }

            Type detour = detourAssembly.GetType(RuntimeDetourNamespace + ".Detour", false);
            Type nativeDetour = detourAssembly.GetType(RuntimeDetourNamespace + ".NativeDetour", false);
            _detourCtor = PickCtor(detour);
            _nativeDetourCtor = PickCtor(nativeDetour);

            if (_detourCtor == null && _nativeDetourCtor == null)
                _unavailable = "Locus.Detour.dll does not expose a usable Detour/NativeDetour(MethodBase, MethodBase) constructor";
        }

        private static ConstructorInfo PickCtor(Type type)
        {
            if (type == null || !typeof(IDisposable).IsAssignableFrom(type))
                return null;
            foreach (ConstructorInfo ctor in type.GetConstructors(BindingFlags.Public | BindingFlags.Instance))
            {
                ParameterInfo[] parameters = ctor.GetParameters();
                if (parameters.Length == 2 && parameters[0].ParameterType == typeof(MethodBase) &&
                    parameters[1].ParameterType == typeof(MethodBase))
                    return ctor;
            }
            return null;
        }

        private static Assembly FindDetourAssembly(out string problem)
        {
            problem = null;

            // 已经加载过（payload 自己会用），直接复用，绝不重复加载同一份托管代码。
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                string name = assembly.IsDynamic ? null : assembly.GetName().Name;
                if (name == "Locus.Detour" || name == "MonoMod.RuntimeDetour")
                    return assembly;
            }

            List<string> directories = CandidateDirectories();
            foreach (string directory in directories)
            {
                string candidate = Path.Combine(directory, "Locus.Detour.dll");
                if (!File.Exists(candidate))
                    continue;
                try
                {
                    return Assembly.LoadFrom(candidate);
                }
                catch (Exception ex)
                {
                    problem = "loading " + candidate + " failed: " + ex.Message;
                }
            }

            problem = "Locus.Detour.dll was not found next to the Locus payload (looked in: " +
                (directories.Count == 0 ? "no candidate directory" : string.Join(", ", directories)) +
                "); install Packages/com.farlocus.locus in this project";
            return null;
        }
    }
}