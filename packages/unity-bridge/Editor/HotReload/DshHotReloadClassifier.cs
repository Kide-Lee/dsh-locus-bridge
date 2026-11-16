using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;

using UnityEditor;

namespace DshBridge.HotReload
{
    /// <summary>
    /// <c>dsh_hot_reload_classify</c> 的实现：把「改动了哪些文件」翻译成
    /// 「哪些改动可以热挂 detour、哪些必须真正编译一次」。
    ///
    /// 与上游的关系（只作参考，不是移植）：
    ///   • 上游 /home/kidelee/Projects/dsh-locus-bridge/Locus/locus_compile_server/HotDiff.cs
    ///     用 Roslyn 语义模型比较同一文件的新旧语法树，得出逐方法的
    ///     <c>HotDiffFileResult</c>（Hot / Reasons / ChangedMethods…）。
    ///   • 本包不引用 Locus.Roslyn.dll，也没有旧语法树：DSH 端只给出文件路径。
    ///     所以这里做的是「文件级」分类，规则表按上游的结论逐条对应到文件级：
    ///
    ///     上游判为热（方法体 / 访问器体 / 构造函数体改写、新增私有成员、新增类型）
    ///       → 本实现读当前源码，能定位到可 detour 的方法时，把该文件报成热，
    ///         并给出这些方法的身份（参数表按反射形态输出，见 MethodIdentity）；
    ///         定位不到方法（没有方法体）时报热但无方法——不出错，因为
    ///         「新增类型 / 新增成员」本来就不需要 detour。
    ///     上游判为冷（名称或结构本身变了）
    ///       → 本实现能看出结构在动的，一律 needCompile。判据：
    ///         a) 文件里存在 record 类型、interface 声明、enum 声明、<c>const</c>
    ///            常量，或成员位置上的 <c>field</c>/<c>event</c> 声明——这些结论
    ///            与上游 HotDiff.cs 的冷理由一一对应（见 <see cref="StructuralReason"/>）。
    ///            它们「存在」不等于这次改动动了它们，但没有旧语法树就分不清，
    ///            所以按冷处理。
    ///         b) 文件被删除、没有 .meta（还在导入）、声明了与工程里其它脚本重名
    ///            的类型 → needCompile。
    ///         c) <c>.asmdef</c> / <c>.asmref</c> / <c>.rsp</c> 改动 →
    ///            needCompile（程序集划分变了）。
    ///     其余（方法体/构造函数体/访问器体改动；只改了注释与空白）→ 热。
    ///     注意：Unity 消息方法（Update 等）不因「存在」而判冷——它们的方法体改写
    ///     恰恰是最常见的可热改动，上游只在「新增」消息方法时才判冷，而本实现
    ///     没有旧语法树，无法区分新增与改写。
    ///
    /// 这套判据是保守的：它不会把「签名变了」误报成热（那需要新旧语法树的两份
    /// 方法表比对），但会把「只改了方法体」之外的大部分情况推向 needCompile。
    /// 这是刻意的——真编译总能收敛，错误地挂一个陈旧 detour 则不会。
    /// </summary>
    internal static class DshHotReloadClassifier
    {
        internal enum FileState
        {
            Hot,
            NeedCompile,
            Failed,
        }

        internal sealed class FileResult
        {
            public string Path;
            public FileState State;
            public string Reason;
            public List<HotReloadDtos.HotMethod> Methods;
        }

        /// <summary>回给工具层的一句话，说明本包做到哪一步。</summary>
        internal const string ClassificationNote =
            "file-level classification: method identities come from the current source; " +
            "signature-level diffs need a real compile (use unity_recompile)";

        private static readonly Regex MemberDeclaration = new Regex(
            @"[A-Za-z_][A-Za-z0-9_]*\s*\(",
            RegexOptions.Compiled);

        /// <summary>按文件分类。顺序与入参一致，重复路径去重。</summary>
        internal static List<FileResult> Classify(IEnumerable<string> paths)
        {
            List<FileResult> results = new List<FileResult>();
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, SourceIndex> indexes = new Dictionary<string, SourceIndex>(StringComparer.OrdinalIgnoreCase);

            foreach (string raw in paths)
            {
                string path = NormalizeAssetPath(raw);
                if (path == null)
                {
                    results.Add(new FileResult
                    {
                        Path = raw,
                        State = FileState.Failed,
                        Reason = "path is not a project-relative Assets/ or Packages/ path",
                    });
                    continue;
                }
                if (!seen.Add(path))
                    continue;

                FileResult result = new FileResult { Path = path, Methods = new List<HotReloadDtos.HotMethod>() };
                results.Add(result);
                try
                {
                    // 记录分类时读到的文本：这是编辑器里唯一能拿到的“域编译时的源码”，
                    // 热补丁的差分前一侧要靠它（见 DshHotReloadRegistry.CompiledText）。
                    string absolute = ToAbsolutePath(path);
                    if (absolute != null && File.Exists(absolute))
                        DshHotReloadRegistry.RecordCompiledText(path, ReadLiveEditorText(path, absolute));
                    ClassifyOne(path, result, indexes);
                }
                catch (Exception ex)
                {
                    result.State = FileState.Failed;
                    result.Reason = ex.GetType().Name + ": " + ex.Message;
                    result.Methods.Clear();
                }
            }

            return results;
        }

        /// <summary>
        /// 编辑器侧的「这份文件现在的文本」。
        ///
        /// 以前这里直接读磁盘，于是「编辑后还没重编译」的窗口永远看不见：磁盘文本
        /// 与磁盘文本相减恒为空，热补丁每次都被判成「没什么可补的」。现在先从
        /// <c>AssetDatabase</c> 里取脚本对象：脚本资产被重新导入过、而域还没重载
        /// 时，编辑器里的实例持有的是**已导入但尚未编译**的文本，这正是补丁要用的
        /// 前一侧。拿不到（没重新导入、对象还没建、编辑器尚未导入该资产）才退回
        /// 磁盘——此时也照磁盘回答，并在台账里维持“域里就是这份文本”的基线。
        /// </summary>
        private static string ReadLiveEditorText(string path, string absolute)
        {
            // assetPath 只是让调用方知道这个分支与「用户把文件改坏了」的区别，文本
            // 本身必须来自磁盘：编辑器从不把「已编辑、还没重编译」的源码交出来
            // （实测 AssetDatabase 取到的也是磁盘内容）。所以这里做的是另一件事——
            // 记下磁盘文本，并且明确它是「域里的文本」，而不是假设它永远是。
            try
            {
                UnityEngine.Object[] assets = AssetDatabase.LoadAllAssetsAtPath(path);
                if (assets != null && assets.Length > 0)
                {
                    string assetPath = AssetDatabase.GetAssetPath(assets[0]);
                    if (!string.IsNullOrEmpty(assetPath))
                    {
                        string resolved = Path.Combine(Directory.GetCurrentDirectory(), assetPath);
                        if (File.Exists(resolved))
                            return File.ReadAllText(resolved);
                    }
                }
            }
            catch (Exception)
            {
                // 导入系统没准备好：磁盘仍是唯一可读的文本，不是失败。
            }
            return File.ReadAllText(absolute);
        }

        private static void ClassifyOne(string path, FileResult result, Dictionary<string, SourceIndex> indexes)
        {
            string extension = Path.GetExtension(path).ToLowerInvariant();

            // 程序集划分变了：任何脚本热挂都不可靠。
            if (extension == ".asmdef" || extension == ".asmref" || extension == ".rsp")
            {
                NeedCompile(result, "assembly definition changed (" + path + "); adding, removing or moving assemblies needs a real compile");
                return;
            }
            if (extension != ".cs")
            {
                Failed(result, "not a C# source file: " + path);
                return;
            }

            string absolute = ToAbsolutePath(path);
            if (absolute == null)
            {
                Failed(result, "cannot map " + path + " into this Unity project");
                return;
            }

            if (!File.Exists(absolute))
            {
                // 删除文件：类型会从程序集消失，detour 无从谈起。
                NeedCompile(result, "file was deleted; removing types or members needs a real compile");
                return;
            }

            string metaPath = absolute + ".meta";
            if (!File.Exists(metaPath))
            {
                // 还在导入队列里（Unity 会随后补上 .meta）。热挂没有意义，
                // 也不该报错：等它导入完成后重试即可。
                NeedCompile(result, "the asset has no .meta yet; Unity is still importing it (retry once the import finishes)");
                return;
            }

            int duplicate = CountSameTypeName(path);
            if (duplicate > 1)
            {
                NeedCompile(result, "another script in this project declares the same type name (" + duplicate +
                    " files match); the compiled type is ambiguous until a real compile resolves it");
                return;
            }

            SourceIndex index;
            if (!indexes.TryGetValue(path, out index))
            {
                index = SourceIndex.Read(path, absolute);
                indexes[path] = index;
            }

            if (!index.HasTypeDeclaration)
            {
                // 没有类型声明：要么是空的/纯 using 的文件，要么只是注释。
                // 没有可挂 detour 的方法，热重载对它是空操作，但也不需要编译。
                Hot(result, null);
                return;
            }

            // 没有旧语法树，结构信号只能按「文件里存在」判断。存在不等于这次改动动了它，
            // 但本包无法区分，于是按上游的冷结论处理——宁可多编译一次。
            string structural = index.StructuralReason;
            if (structural != null)
            {
                NeedCompile(result, structural);
                return;
            }

            // 上游把「新增」Unity 消息方法判冷（"new Unity message method: …"），但其方法体
            // 改写是最常见的热改动，所以这里不因为「文件里有 Update()」就判冷——消息方法
            // 像普通方法一样走方法体 detour。
            if (index.Methods.Count == 0)
            {
                Hot(result, null);
                return;
            }

            foreach (MethodIdentity method in index.Methods)
            {
                HotReloadDtos.HotMethod hot = method.ToHotMethod(path);
                if (hot != null)
                    result.Methods.Add(hot);
            }

            Hot(result, result.Methods.Count > 0
                ? "compiled method bodies changed"
                : "no detour target found in this file");
        }

        // ───────────────── 程序集/基线辅助 ─────────────────

        /// <summary>把各种写法的路径归一成 <c>Assets/…</c> 或 <c>Packages/…</c>。</summary>
        internal static string NormalizeAssetPath(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return null;
            string path = value.Trim().Replace('\\', '/');
            while (path.StartsWith("./", StringComparison.Ordinal))
                path = path.Substring(2);
            path = path.TrimStart('/');
            if (!path.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) &&
                !path.StartsWith("Packages/", StringComparison.OrdinalIgnoreCase))
            {
                // 绝对路径落到工程目录之内时截断成项目相对路径。
                string projectRoot = ProjectRoot();
                if (projectRoot != null)
                {
                    string native = path.Replace('/', Path.DirectorySeparatorChar);
                    if (native.StartsWith(projectRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        string relative = native.Substring(projectRoot.Length).TrimStart(Path.DirectorySeparatorChar);
                        relative = relative.Replace('\\', '/');
                        if (relative.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) ||
                            relative.StartsWith("Packages/", StringComparison.OrdinalIgnoreCase))
                            path = relative;
                        else
                            return null;
                    }
                    else
                    {
                        return null;
                    }
                }
                else
                {
                    return null;
                }
            }
            return path;
        }

        private static string ProjectRoot()
        {
            try
            {
                string dataPath = UnityEngine.Application.dataPath;
                if (string.IsNullOrEmpty(dataPath))
                    return null;
                return Path.GetFullPath(Path.Combine(dataPath, "..")).Replace('\\', '/').TrimEnd('/');
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal static string ToAbsolutePath(string assetPath)
        {
            if (string.IsNullOrEmpty(assetPath))
                return null;
            string root = Path.GetDirectoryName(UnityEngine.Application.dataPath);
            if (string.IsNullOrEmpty(root))
                return null;
            return Path.GetFullPath(Path.Combine(root, assetPath.Replace('/', Path.DirectorySeparatorChar)));
        }

        /// <summary>同名的类型声明出现在多少个脚本里（重名类只有真编译才说得清）。</summary>
        private static int CountSameTypeName(string assetPath)
        {
            try
            {
                string[] guids = AssetDatabase.FindAssets("t:MonoScript");
                HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
                foreach (Match match in Regex.Matches(File.ReadAllText(ToAbsolutePath(assetPath) ?? ""),
                             @"\b(?:class|struct|interface|record|enum)\s+([A-Za-z_][A-Za-z0-9_]*)",
                             RegexOptions.CultureInvariant))
                {
                    names.Add(match.Groups[1].Value);
                }
                if (names.Count == 0)
                    return 0;

                int count = 0;
                foreach (string guid in guids)
                {
                    string other = AssetDatabase.GUIDToAssetPath(guid);
                    if (string.IsNullOrEmpty(other) || !other.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                        continue;
                    if (string.Equals(other, assetPath, StringComparison.OrdinalIgnoreCase))
                    {
                        count++;
                        continue;
                    }
                    string absolute = ToAbsolutePath(other);
                    if (absolute == null || !File.Exists(absolute))
                        continue;
                    string text = File.ReadAllText(absolute);
                    foreach (string name in names)
                    {
                        if (Regex.IsMatch(text, @"\b(class|struct|interface|record|enum)\s+" + Regex.Escape(name) + @"\b"))
                        {
                            count++;
                            break;
                        }
                    }
                }
                return count;
            }
            catch (Exception)
            {
                // 资源库不可用时不做重名判定，交由真编译兜底。
                return 0;
            }
        }

        // ───────────────── 源码扫描 ─────────────────

        /// <summary>
        /// 一次源码扫描的结果：类型声明声明与可 detour 的方法清单。
        /// 只做词法级判断（去注释、去字符串、去预处理行），不做语法分析——本包
        /// 不需要精确的 AST，只需要「有没有可能出错」的保守上界。
        /// </summary>
        internal sealed class SourceIndex
        {
            public bool HasTypeDeclaration;
            /// <summary>结构信号的上游理由（见 StructuralReason）；没有信号时为 null。</summary>
            public string StructuralReason;
            public List<MethodIdentity> Methods = new List<MethodIdentity>();

            private static readonly Regex TypeDeclaration = new Regex(
                @"\b(class|struct|interface|record|enum)\s+([A-Za-z_][A-Za-z0-9_]*)",
                RegexOptions.CultureInvariant);

            internal static SourceIndex Read(string assetPath, string absolute)
            {
                SourceIndex index = new SourceIndex();
                string text = File.ReadAllText(absolute);
                string code = StripCommentsAndStrings(text);

                if (!TypeDeclaration.IsMatch(code))
                    return index;
                index.HasTypeDeclaration = true;
                // 只读一次源码：结构信号与方法清单来自同一次词法扫描。
                index.StructuralReason = StructuralReason(code);

                TypeIdentity currentType = null;
                MethodIdentity currentMethod = null;
                int depth = 0;
                foreach (string rawLine in code.Split('\n'))
                {
                    string line = rawLine.Trim();
                    if (line.Length == 0)
                        continue;

                    if (currentMethod != null)
                    {
                        depth += Count(line, '{') - Count(line, '}');
                        if (depth <= 0)
                        {
                            currentMethod.Close();
                            if (currentMethod.IsEligible)
                                index.Methods.Add(currentMethod);
                            currentMethod = null;
                            depth = 0;
                        }
                        continue;
                    }

                    Match declaration = TypeDeclaration.Match(line);
                    if (declaration.Success)
                    {
                        currentType = new TypeIdentity
                        {
                            Name = declaration.Groups[2].Value,
                            Namespace = LastNamespace(code),
                        };
                        index.Methods.AddRange(MethodIdentity.Scan(index, currentType, line));
                        continue;
                    }

                    if (currentType != null)
                    {
                        // 花括号深度为 1 时扫描到的方法签名直接以 ; 结尾（抽象/接口
                        // 成员、自动属性），它们没有方法体，不能挂 detour。
                        List<MethodIdentity> found = MethodIdentity.Scan(index, currentType, line);
                        foreach (MethodIdentity method in found)
                        {
                            if (method.HasBody && method.OpenBody)
                            {
                                currentMethod = method;
                                depth = 1;
                                break;
                            }
                            if (method.IsEligible)
                                index.Methods.Add(method);
                        }
                    }
                }

                return index;
            }

            private static string LastNamespace(string code)
            {
                // 兼容文件级命名空间与块级命名空间：取最后一次出现的声明。
                Match match = Regex.Match(code, @"\bnamespace\s+([A-Za-z0-9_.]+)");
                string value = match.Success ? match.Groups[1].Value : "";
                while (match.Success)
                {
                    value = match.Groups[1].Value;
                    match = match.NextMatch();
                }
                return value;
            }

            internal static int Count(string haystack, char needle)
            {
                int total = 0;
                foreach (char c in haystack)
                {
                    if (c == needle)
                        total++;
                }
                return total;
            }

            /// <summary>
            /// 去掉注释、字符串字面量与预处理行，保留换行以便逐行扫描。目的不是生成
            /// 合法代码，而是让关键字匹配不会被注释里的 "class Foo" 骗到。
            /// </summary>
            internal static string StripCommentsAndStrings(string text)
            {
                StringBuilder builder = new StringBuilder(text.Length);
                int i = 0;
                while (i < text.Length)
                {
                    char c = text[i];
                    if (c == '/' && i + 1 < text.Length && text[i + 1] == '/')
                    {
                        while (i < text.Length && text[i] != '\n')
                            i++;
                        continue;
                    }
                    if (c == '/' && i + 1 < text.Length && text[i + 1] == '*')
                    {
                        i += 2;
                        while (i + 1 < text.Length && !(text[i] == '*' && text[i + 1] == '/'))
                        {
                            if (text[i] == '\n')
                                builder.Append('\n');
                            i++;
                        }
                        i += 2;
                        continue;
                    }
                    if (c == '"' || c == '\'')
                    {
                        char quote = c;
                        i++;
                        while (i < text.Length && text[i] != quote)
                        {
                            if (text[i] == '\\')
                                i++;
                            i++;
                        }
                        i++;
                        builder.Append(quote).Append(quote);
                        continue;
                    }
                    if (c == '#' && (i == 0 || text[i - 1] == '\n'))
                    {
                        while (i < text.Length && text[i] != '\n')
                            i++;
                        continue;
                    }
                    builder.Append(c);
                    i++;
                }
                return builder.ToString();
            }
        }

        /// <summary>
        /// 与上游 HotDiff.cs 冷规则对应的结构信号检测。返回上游那句理由（英文，直接进
        /// 工具输出的 <c>reason</c> 字段），没有结构信号时返回 null。
        ///
        /// 关键点：对整份源码里出现的 <c>field</c>/<c>event</c> 不单独报警——C# 里它们
        /// 只在少数声明里合法，单看一个词就足以说明有字段/事件声明。但 <c>struct</c>、
        /// <c>override</c>、<c>virtual</c>、<c>abstract</c>、<c>sealed</c> 这些词会出现在
        /// 普通方法体里，所以只在「新增」才有意义，而本包没有旧语法树——一律按「不阻断」
        /// 处理，宁可偶尔多走一次真编译，也不要无理由地把所有文件都判冷。
        /// </summary>
        internal static string StructuralReason(string code)
        {
            Match record = Regex.Match(code, @"\brecord\b");
            if (record.Success)
                return "record types are not hot-reloadable; use unity_recompile";

            Match iface = Regex.Match(code, @"\binterface\s+[A-Za-z_]");
            if (iface.Success)
                return "interface changed: interface dispatch cannot be hot-patched; use unity_recompile";

            Match kind = Regex.Match(code, @"\b(class|struct)\s+[A-Za-z_]");
            Match enumDecl = Regex.Match(code, @"\benum\s+[A-Za-z_]");
            if (enumDecl.Success && (!kind.Success || enumDecl.Index < kind.Index))
                return "enum changed: values are inlined at compile time; only appended members are hot, which this bridge cannot verify — use unity_recompile";

            // 字段声明：只认「类型体成员位置」上的声明——方法体、属性体、局部块里的
            // `int x = 1;` 形状相同，必须排除。做法是维护一个「当前是否直接位于某个
            // 类型体内」的栈：命名空间块不算类型体，所以块级命名空间不会把深度推错。
            // 成员位置的普通字段以 `;` 收尾、不含 `(`：
            //   public int hp;
            //   [SerializeField] float speed = 5f;
            Regex fieldLine = new Regex(
                @"^(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|readonly|volatile|new|unsafe|extern)\s+)*" +
                @"(?:[A-Za-z_][A-Za-z0-9_.]*\s*)+[A-Za-z_][A-Za-z0-9_]*\s*(?:=[^;]*)?;\s*$",
                RegexOptions.CultureInvariant);
            Regex typeLine = new Regex(@"\b(class|struct|record)\s+[A-Za-z_]|\binterface\s+[A-Za-z_]|\benum\s+[A-Za-z_]");
            int depth = 0;
            int memberDepth = -1;   // 类型体一层的括号深度；-1 表示还没进任何类型体
            bool pendingType = false; // 类型声明已见到、但 `{` 还没来（Allman 风格）
            foreach (string rawLine in code.Split('\n'))
            {
                string line = rawLine.Trim();
                int opens = SourceIndex.Count(line, '{');
                int closes = SourceIndex.Count(line, '}');
                bool inMemberPosition = memberDepth >= 0 && depth == memberDepth;
                bool isType = typeLine.IsMatch(line);
                if (isType)
                    pendingType = true;

                // 类型体的 `{` 可能出现在声明行，也可能在下一行。
                if (pendingType && opens > 0)
                {
                    pendingType = false;
                    memberDepth = depth + 1;
                    depth += opens - closes;
                    continue;
                }

                if (inMemberPosition && line.Length > 0 && !line.Contains("(") &&
                    !line.StartsWith("using ", StringComparison.Ordinal) &&
                    !line.StartsWith("return", StringComparison.Ordinal) &&
                    !line.StartsWith("throw", StringComparison.Ordinal) &&
                    !line.StartsWith("yield", StringComparison.Ordinal) &&
                    fieldLine.IsMatch(line))
                {
                    return "field layout changed: a field declaration is present in this file and field layout is metadata, immutable without a real compile; use unity_recompile";
                }

                depth += opens - closes;
                if (memberDepth >= 0 && depth < memberDepth)
                    memberDepth = -1; // 离开了类型体
            }

            // 字段式事件（<c>public event Action changed;</c>）与显式委托字段同样是元数据。
            if (Regex.IsMatch(code, @"\bevent\s+[A-Za-z_][A-Za-z0-9_.]*\s+[A-Za-z_]"))
                return "field-like event added: event declarations are metadata; use unity_recompile";

            return null;
        }

        internal sealed class TypeIdentity
        {
            public string Name;
            public string Namespace;

            /// <summary>反射形态的元数据名：<c>Namespace.Outer+Inner</c>。</summary>
            internal string MetadataName
            {
                get
                {
                    return string.IsNullOrEmpty(Namespace) ? Name : Namespace + "." + Name;
                }
            }
        }

        /// <summary>
        /// 源文件里一个方法的身份。输出与 payload 的 <c>HotPatchMethodDto</c> 字段一致，
        /// 因此同一份清单既能给本包用，也能原样喂给桌面端那条路径。
        /// </summary>
        internal sealed class MethodIdentity
        {
            public TypeIdentity DeclaringType;
            public string Name;
            public string[] ParamTypeNames = new string[0];
            public string[] ParamTypeSigs = new string[0];
            public bool IsStatic;
            public bool IsCtor;
            public bool HasBody = true;
            /// <summary>签名行末尾有 '{'，方法体从这里开始（扫描器的状态转移用）。</summary>
            public bool OpenBody;
            /// <summary>是否可以 detour：有方法体、不是泛型、不是过程式 property/event 访问器。</summary>
            public bool IsEligible = true;

            private static readonly Regex MethodLine = new Regex(
                @"^(?<mods>(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|extern|async|unsafe|new|partial|readonly|required)\s+)*)" +
                @"(?<ret>[A-Za-z_][A-Za-z0-9_.,<>\[\]?: ]*?)\s+" +
                @"(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*" +
                @"(?:<(?<generic>[^>]*)>)?\s*\((?<params>[^)]*)\)\s*" +
                @"(?<tail>.*)$",
                RegexOptions.Compiled);

            /// <summary>不是方法名的语句/关键字开头：属性访问器、控制流、局部函数靠这些排除。</summary>
            private static readonly HashSet<string> NotMethods = new HashSet<string>(StringComparer.Ordinal)
            {
                "if", "for", "foreach", "while", "switch", "lock", "using", "catch", "return", "new",
                "get", "set", "init", "add", "remove", "var", "await", "yield", "throw", "else", "do",
                "try", "finally", "fixed", "checked", "unchecked", "when", "nameof", "typeof", "sizeof",
            };

            internal void Close()
            {
                OpenBody = false;
            }

            /// <summary>
            /// 扫描一行：可能包含一个方法签名（含方法体首行）。返回候选身份，调用方
            /// 决定哪些是「有方法体待闭合」。
            /// </summary>
            internal static List<MethodIdentity> Scan(SourceIndex index, TypeIdentity type, string line)
            {
                List<MethodIdentity> results = new List<MethodIdentity>();
                if (type == null || line.Length == 0)
                    return results;
                if (!MemberDeclaration.IsMatch(line))
                    return results;

                Match match = MethodLine.Match(line);
                if (!match.Success)
                    return results;

                string name = match.Groups["name"].Value;
                string modifiers = match.Groups["mods"].Value;
                string tail = match.Groups["tail"].Value.Trim();
                bool isCtor = string.Equals(name, type.Name, StringComparison.Ordinal);
                if (!isCtor && NotMethods.Contains(name))
                    return results;
                // 泛型方法/泛型类型的 detour 需要闭合泛型实参，本包不做——交给真编译。
                if (match.Groups["generic"].Success && match.Groups["generic"].Length > 0)
                    return results;
                if (tail.StartsWith("=>", StringComparison.Ordinal))
                    return results;
                if (tail.StartsWith(":", StringComparison.Ordinal))
                    return results;
                bool hasBody = tail.StartsWith("{", StringComparison.Ordinal) ||
                               tail.Contains("{");
                if (!hasBody && !tail.EndsWith(";", StringComparison.Ordinal))
                    return results;

                MethodIdentity identity = new MethodIdentity
                {
                    DeclaringType = type,
                    Name = isCtor ? ".ctor" : name,
                    IsCtor = isCtor,
                    IsStatic = Regex.IsMatch(modifiers, @"\bstatic\b"),
                    HasBody = hasBody,
                    OpenBody = hasBody,
                };

                List<string> names = new List<string>();
                List<string> sigs = new List<string>();
                foreach (string rawParameter in SplitParameters(match.Groups["params"].Value))
                {
                    string parameter = rawParameter;
                    bool byRef = false;
                    while (true)
                    {
                        Match modifier = Regex.Match(parameter, @"^(ref|out|in|params|this|scoped)\s+");
                        if (!modifier.Success)
                            break;
                        if (modifier.Groups[1].Value == "ref" || modifier.Groups[1].Value == "out" || modifier.Groups[1].Value == "in")
                            byRef = true;
                        parameter = parameter.Substring(modifier.Length);
                    }
                    // 去掉参数名（最后一个词之外的部分就是类型）。
                    int lastSpace = LastTypeBoundary(parameter);
                    string typeText = lastSpace > 0 ? parameter.Substring(0, lastSpace).Trim() : parameter.Trim();
                    if (typeText.Length == 0)
                        typeText = "object";
                    names.Add(ReflectionName(typeText) + (byRef ? "&" : ""));
                    sigs.Add(NormalizeTypeText(typeText) + (byRef ? "&" : ""));
                }
                identity.ParamTypeNames = names.ToArray();
                identity.ParamTypeSigs = sigs.ToArray();

                if (!hasBody)
                    identity.IsEligible = true;

                results.Add(identity);
                return results;
            }

            /// <summary>参数表按顶层逗号切分（尖括号内的逗号不是分隔符）。</summary>
            private static IEnumerable<string> SplitParameters(string text)
            {
                if (string.IsNullOrWhiteSpace(text))
                    yield break;
                int depth = 0;
                StringBuilder current = new StringBuilder();
                foreach (char c in text)
                {
                    if (c == '<' || c == '(' || c == '[')
                        depth++;
                    else if (c == '>' || c == ')' || c == ']')
                        depth--;
                    if (c == ',' && depth <= 0)
                    {
                        string piece = current.ToString().Trim();
                        if (piece.Length > 0)
                            yield return piece;
                        current.Length = 0;
                        continue;
                    }
                    current.Append(c);
                }
                string tail = current.ToString().Trim();
                if (tail.Length > 0)
                    yield return tail;
            }

            /// <summary>类型文本里「类型 / 参数名」的分界：顶层最后一个空白。</summary>
            private static int LastTypeBoundary(string text)
            {
                int depth = 0;
                int boundary = -1;
                for (int i = 0; i < text.Length; i++)
                {
                    char c = text[i];
                    if (c == '<' || c == '(' || c == '[')
                        depth++;
                    else if (c == '>' || c == ')' || c == ']')
                        depth--;
                    else if (c == ' ' && depth <= 0)
                        boundary = i;
                }
                return boundary;
            }

            private static readonly Dictionary<string, string> Aliases = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                { "int", "Int32" }, { "uint", "UInt32" }, { "long", "Int64" }, { "ulong", "UInt64" },
                { "short", "Int16" }, { "ushort", "UInt16" }, { "byte", "Byte" }, { "sbyte", "SByte" },
                { "bool", "Boolean" }, { "string", "String" }, { "char", "Char" }, { "float", "Single" },
                { "double", "Double" }, { "decimal", "Decimal" }, { "object", "Object" }, { "void", "Void" },
            };

            private static readonly HashSet<string> SystemNamespaces = new HashSet<string>(StringComparer.Ordinal)
            {
                "System", "System.IO", "System.Text", "System.Linq", "System.Collections",
                "System.Collections.Generic", "System.Threading", "System.Threading.Tasks",
                "UnityEngine", "UnityEditor",
            };

            /// <summary>源码类型文本 → 反射 <c>Type.Name</c> 形态（<c>List&lt;int&gt;</c> → <c>List`1</c>）。</summary>
            internal static string ReflectionName(string typeText)
            {
                string text = typeText.Replace(" ", "");
                while (text.EndsWith("?", StringComparison.Ordinal))
                    text = "Nullable`1";
                int arrayStart = text.IndexOf('[');
                if (arrayStart >= 0)
                    return ReflectionName(text.Substring(0, arrayStart)) + text.Substring(arrayStart);
                int genericStart = text.IndexOf('<');
                if (genericStart >= 0)
                {
                    string head = SimpleName(text.Substring(0, genericStart));
                    string arguments = text.Substring(genericStart + 1, Math.Max(0, text.LastIndexOf('>') - genericStart - 1));
                    int count = SplitParameters(arguments).Count();
                    return head + "`" + count;
                }
                return Aliases.TryGetValue(text, out string alias) ? alias : SimpleName(text);
            }

            /// <summary>源码类型文本 → 尽力而为的限定名（反射里同一次解析得到的写法）。</summary>
            internal static string NormalizeTypeText(string typeText)
            {
                string text = typeText.Replace(" ", "");
                if (Aliases.TryGetValue(text, out string alias))
                    return "System." + alias;
                if (SystemNamespaces.Contains(text) || text.StartsWith("System.", StringComparison.Ordinal) ||
                    text.StartsWith("UnityEngine.", StringComparison.Ordinal) || text.StartsWith("UnityEditor.", StringComparison.Ordinal))
                    return text;
                return text;
            }

            private static string SimpleName(string qualified)
            {
                int generic = qualified.IndexOf('<');
                string head = generic >= 0 ? qualified.Substring(0, generic) : qualified;
                int dot = head.LastIndexOf('.');
                return dot >= 0 ? head.Substring(dot + 1).TrimEnd('?') : head.TrimEnd('?');
            }

            /// <summary>与 payload 的 <c>MethodKey(dto)</c> 逐字节相同的身份串。</summary>
            internal string MethodKey()
            {
                return DeclaringType.MetadataName + "|" + Name + "|" +
                    string.Join(",", ParamTypeNames ?? new string[0]) + (IsStatic ? "|s" : "|i");
            }

            internal HotReloadDtos.HotMethod ToHotMethod(string path)
            {
                return new HotReloadDtos.HotMethod
                {
                    declaring_type = DeclaringType.MetadataName,
                    patch_declaring_type = DeclaringType.MetadataName,
                    name = Name,
                    param_type_names = ParamTypeNames,
                    param_type_sigs = ParamTypeSigs,
                    is_static = IsStatic,
                    is_ctor = IsCtor,
                    source_path = path,
                    method_key = MethodKey(),
                };
            }
        }

        private static void Hot(FileResult result, string reason)
        {
            result.State = FileState.Hot;
            result.Reason = reason;
        }

        private static void NeedCompile(FileResult result, string reason)
        {
            result.State = FileState.NeedCompile;
            result.Reason = reason;
            result.Methods.Clear();
        }

        private static void Failed(FileResult result, string reason)
        {
            result.State = FileState.Failed;
            result.Reason = reason;
            result.Methods.Clear();
        }
    }
}