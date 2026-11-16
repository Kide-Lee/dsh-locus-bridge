using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

using UnityEditor;
using UnityEngine;

namespace DshBridge.Live
{
    /// <summary>
    /// 编辑器内存里的实时值：`unity_yaml_read` 的 live 数据源。
    ///
    /// 磁盘上的 YAML 只是上一次保存的版本。改了值没保存、或者场景里刚拖进去一个
    /// 对象时，磁盘文件会撒谎——上游 Locus 的 `read_yaml` 走桥就是为了这一点。
    ///
    /// **这里刻意不解析文本。** 磁盘路径上的 YAML 解析器是我们自己的；编辑器侧再
    /// 复制一份解析器，两份就会各自演化然后给出不同的答案。取而代之的是：
    ///   1. 用 <see cref="AssetDatabase.LoadAllAssetsAtPath"/> 把文件当资产加载；
    ///   2. 用 Unity 自己的 <see cref="SerializedObject"/> 遍历属性树；
    ///   3. 输出与磁盘渲染器同样的节点形状（`{name,type,value,children}`），
    ///      工具层因此可以在两种来源之间逐字段比较。
    ///
    /// 序列化属性（FileID）用 `SerializedProperty.objectReferenceEntityIdValue`
    /// 取（2022.2+，`entityId`=−2 的本地引用也能回到一个真实对象），更老的编辑器
    /// 退回 `objectReferenceInstanceIDValue`。
    /// </summary>
    internal sealed class DshLiveSource : DshBridgeBootstrap.IEditorMessageSource
    {
        internal const string ReadMessage = "dsh_live_read";
        internal const string OverridesMessage = "dsh_live_prefab_overrides";

        /// <summary>一次请求最多返回多少个对象，避免一个 3 MB 的场景把消息撑爆。</summary>
        internal const int MaxObjectsPerRequest = 200;

        private static DshLiveSource _instance;

        [InitializeOnLoadMethod]
        internal static void Install()
        {
            if (_instance == null)
                _instance = new DshLiveSource();
            DshBridgeBootstrap.AddSource(_instance);
        }

        /// <summary>测试与工具探测用：这个包的 live 源是否已挂上。</summary>
        internal static bool Installed
        {
            get { return _instance != null; }
        }

        public IEnumerable<DshBridgeBootstrap.MessageHandler> Messages()
        {
            return new[]
            {
                new DshBridgeBootstrap.MessageHandler { MessageType = ReadMessage, Handler = HandleRead },
                new DshBridgeBootstrap.MessageHandler { MessageType = OverridesMessage, Handler = HandleOverrides },
            };
        }

        public void OnDomainLoaded()
        {
            // 无跨域状态：每次请求都重新加载资产，域重载后旧的对象引用必须失效。
        }

        private static Task<string> HandleRead(string requestJson)
        {
            try
            {
                return Task.FromResult(Read(requestJson));
            }
            catch (Exception ex)
            {
                return Task.FromResult(Error("live read failed: " + ex.Message));
            }
        }

        private static Task<string> HandleOverrides(string requestJson)
        {
            try
            {
                string path = ReadStringField(requestJson, "path");
                if (string.IsNullOrEmpty(path))
                    return Task.FromResult(Error("dsh_live_prefab_overrides expects a non-empty \"path\""));
                if (!path.StartsWith("Assets/", StringComparison.Ordinal))
                    return Task.FromResult(Error("live read needs a project-relative path starting with Assets/: " + path));
                string unsupported;
                List<PrefabOverrides.Override> overrides = PrefabOverrides.Collect(path, out unsupported);
                return Task.FromResult(PrefabOverrides.ToJson(path, overrides, unsupported));
            }
            catch (Exception ex)
            {
                return Task.FromResult(Error("prefab overrides failed: " + ex.Message));
            }
        }

        /// <summary>
        /// 把场景当作一个“资产”来读：已打开就直接取它的根对象，没打开就临时
        /// 单开（Single）打开、读完再恢复原场景。
        ///
        /// 恢复放在 finally 里：一次读取失败不能让编辑器停在一个不是用户打开的
        /// 场景上。批量模式下打不开就直接返回空，由调用方报“尚未导入”。
        /// </summary>
        private static UnityEngine.Object[] LoadSceneObjects(string path)
        {
            UnityEngine.SceneManagement.Scene already = UnityEngine.SceneManagement.SceneManager.GetSceneByPath(path);
            if (already.IsValid() && already.isLoaded)
                return already.GetRootGameObjects();
            if (Application.isBatchMode == false && UnityEditor.SceneManagement.EditorSceneManager.GetActiveScene().path != null
                && UnityEditor.SceneManagement.EditorSceneManager.GetActiveScene().isDirty)
                return null;

            UnityEngine.SceneManagement.Scene previous = UnityEditor.SceneManagement.EditorSceneManager.GetActiveScene();
            UnityEngine.SceneManagement.Scene opened = default(UnityEngine.SceneManagement.Scene);
            try
            {
                opened = UnityEditor.SceneManagement.EditorSceneManager.OpenScene(
                    path, UnityEditor.SceneManagement.OpenSceneMode.Single);
                return opened.GetRootGameObjects();
            }
            catch (Exception)
            {
                return null;
            }
            finally
            {
                // Objects stay valid until the next domain reload; the caller
                // reads them into JSON before returning a Task, so restoring the
                // previous scene here would already have destroyed them.
                if (opened.IsValid() && previous.IsValid() && previous != opened)
                    UnityEditor.SceneManagement.EditorSceneManager.OpenScene(
                        previous.path, UnityEditor.SceneManagement.OpenSceneMode.Single);
            }
        }

        /// <summary>请求 `{"path":"Assets/…/Player.prefab","depth":2}` → 实时快照。</summary>
        internal static string Read(string requestJson)
        {
            if (string.IsNullOrEmpty(requestJson) || requestJson.Trim() == "null")
                return Error("dsh_live_read expects {\"path\":\"Assets/…\"}");

            string path = ReadStringField(requestJson, "path");
            if (string.IsNullOrEmpty(path))
                return Error("dsh_live_read expects a non-empty \"path\"");
            if (!path.StartsWith("Assets/", StringComparison.Ordinal))
                // AssetDatabase 只认项目相对路径；别的写法会静默返回 null，看起来
                // 像“文件不存在”，与真实的失败原因不符。
                return Error("live read needs a project-relative path starting with Assets/: " + path);

            int depth = ReadIntField(requestJson, "depth", 2);
            if (depth < 1)
                depth = 1;
            if (depth > 8)
                depth = 8;

            UnityEngine.Object[] assets = AssetDatabase.LoadAllAssetsAtPath(path);
            if (assets == null || assets.Length == 0)
            {
                // A scene file is not an asset the database loads by itself; the
                // objects live in an open scene. Opening it read-only is the only
                // way to answer "what does this scene hold right now", and it is
                // also what makes an edit visible before the next save.
                if (path.EndsWith(".unity", StringComparison.OrdinalIgnoreCase))
                    assets = LoadSceneObjects(path);
            }
            if (assets == null || assets.Length == 0)
            {
                bool existsOnDisk = System.IO.File.Exists(path) || System.IO.Directory.Exists(path);
                return existsOnDisk
                    ? Error("the Editor has not imported " + path + " yet (no assets loaded for it)")
                    : Error("the Editor has no asset at " + path);
            }

            StringBuilder builder = new StringBuilder(4096);
            builder.Append("{\"path\":");
            AppendString(builder, path);
            builder.Append(",\"count\":").Append(assets.Length);
            builder.Append(",\"truncated\":").Append(assets.Length > MaxObjectsPerRequest ? "true" : "false");
            builder.Append(",\"objects\":[");
            int written = 0;
            foreach (UnityEngine.Object asset in assets)
            {
                if (asset == null)
                    continue;
                if (written >= MaxObjectsPerRequest)
                    break;
                if (written > 0)
                    builder.Append(',');
                WriteObject(builder, asset, depth);
                written++;
            }
            builder.Append("]}");
            return builder.ToString();
        }

        private static void WriteObject(StringBuilder builder, UnityEngine.Object asset, int depth)
        {
            string fileId = FileIdOf(asset);
            builder.Append("{\"name\":");
            AppendString(builder, asset.name);
            builder.Append(",\"type\":");
            AppendString(builder, asset.GetType().Name);
            builder.Append(",\"file_id\":");
            AppendString(builder, fileId);
            builder.Append(",\"fields\":");
            SerializedObject serialized = null;
            try
            {
                serialized = new SerializedObject(asset);
                SerializedProperty iterator = serialized.GetIterator();
                bool enter = true;
                builder.Append('[');
                bool first = true;
                // NextVisible(enterChildren:true) 会走进子属性；走到 `m_Name` 之类的
                // 深度截断点时停止进入，但继续遍历兄弟。
                while (iterator.NextVisible(enter))
                {
                    if (iterator.depth > depth)
                    {
                        enter = false;
                        continue;
                    }
                    if (!first)
                        builder.Append(',');
                    first = false;
                    WriteProperty(builder, iterator, depth);
                    enter = false;
                }
                builder.Append(']');
            }
            catch (Exception ex)
            {
                builder.Append("null,\"error\":");
                AppendString(builder, ex.Message);
            }
            finally
            {
                if (serialized != null)
                    serialized.Dispose();
            }
            builder.Append('}');
        }

        private static void WriteProperty(StringBuilder builder, SerializedProperty property, int depth)
        {
            builder.Append("{\"name\":");
            AppendString(builder, property.name);
            builder.Append(",\"type\":");
            AppendString(builder, TypeName(property));
            builder.Append(",\"value\":");
            AppendString(builder, ScalarValue(property));
            string reference = ObjectReference(property);
            if (!string.IsNullOrEmpty(reference))
            {
                builder.Append(",\"reference\":");
                AppendString(builder, reference);
            }
            if (property.isArray && property.propertyType != SerializedPropertyType.String)
            {
                builder.Append(",\"size\":").Append(property.arraySize);
            }
            // 子属性只给到 depth-1：depth=2 时对象级字段（depth 0/1）展开一层容器，
            // 与磁盘渲染器的 `depth:2` 视觉上对齐。
            if (property.propertyType == SerializedPropertyType.Generic && depth > 1)
            {
                builder.Append(",\"children\":[");
                SerializedProperty child = property.Copy();
                SerializedProperty end = child.GetEndProperty();
                bool first = true;
                bool entered = false;
                while (child.NextVisible(true) && !SerializedProperty.EqualContents(child, end))
                {
                    if (!entered)
                    {
                        // Copy() 停在父节点自身，第一个 NextVisible 才是第一个孩子。
                        entered = true;
                    }
                    if (!first)
                        builder.Append(',');
                    first = false;
                    // 展开但不再深入，避免一次请求把整棵 prefab 树拉平。
                    WriteProperty(builder, child, 1);
                }
                builder.Append(']');
            }
            builder.Append('}');
        }

        private static readonly Dictionary<string, string> _fileIdCache = new Dictionary<string, string>();

        /// <summary>
        /// 资产的 FileID（前 4 个字节是小端 int，与 YAML 头里的 `fileID` 一致）。
        ///
        /// 只对目录下的资产有效：真正的 FileID 在 .meta 里，读取它比每次请求
        /// 走一遍 GUID 反查便宜，而且对场景里的非资产对象必然失败——那种情况返回空串，
        /// 工具层就知道“这个对象没有磁盘身份”，不会拿 0 去冒充。
        /// </summary>
        internal static string FileIdOf(UnityEngine.Object asset)
        {
            if (asset == null)
                return string.Empty;
            string path = AssetDatabase.GetAssetPath(asset);
            if (string.IsNullOrEmpty(path))
                return string.Empty;
            // 只在 .meta 存在时问 FileID：对场景/预制件之外的对象（或还没导入的
            // 路径）这个问题没有意义，而 TryGetGUIDAndLocalFileIdentifier 的成本
            // 与调用次数成正比。
            if (!System.IO.File.Exists(path + ".meta"))
                return string.Empty;
            try
            {
                string guid = AssetDatabase.AssetPathToGUID(path);
                long localId;
                if (guid.Length > 0 && AssetDatabase.TryGetGUIDAndLocalFileIdentifier(asset, out guid, out localId))
                    return localId.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                // 拿不到不算错误：没有 FileID 只是少一个定位字段，工具层会退回路径。
            }
            return string.Empty;
        }

        private static string ObjectReference(SerializedProperty property)
        {
            if (property.propertyType != SerializedPropertyType.ObjectReference)
                return null;
            UnityEngine.Object target = property.objectReferenceValue;
            if (target == null)
                return string.Empty;
            string path = AssetDatabase.GetAssetPath(target);
            if (string.IsNullOrEmpty(path))
            {
                // 场景里的对象没有资产路径：给出名字，工具层据此说明“不是资产引用”。
                return target.name + " (in-scene)";
            }
            string fileId = FileIdOf(target);
            return fileId.Length == 0 ? path : path + "#" + fileId;
        }

        private static string TypeName(SerializedProperty property)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer:
                    return "int";
                case SerializedPropertyType.Boolean:
                    return "bool";
                case SerializedPropertyType.Float:
                    return "float";
                case SerializedPropertyType.String:
                    return "string";
                case SerializedPropertyType.Color:
                    return "Color";
                case SerializedPropertyType.ObjectReference:
                    return "Object";
                case SerializedPropertyType.Enum:
                    return "enum";
                case SerializedPropertyType.Vector2:
                    return "Vector2";
                case SerializedPropertyType.Vector3:
                    return "Vector3";
                case SerializedPropertyType.Vector4:
                    return "Vector4";
                case SerializedPropertyType.Rect:
                    return "Rect";
                case SerializedPropertyType.Bounds:
                    return "Bounds";
                case SerializedPropertyType.Quaternion:
                    return "Quaternion";
                case SerializedPropertyType.LayerMask:
                    return "LayerMask";
                case SerializedPropertyType.Generic:
                    return "object";
                default:
                    return property.propertyType.ToString();
            }
        }

        private static string ScalarValue(SerializedProperty property)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.Integer:
                    return property.longValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
                case SerializedPropertyType.Boolean:
                    return property.boolValue ? "true" : "false";
                case SerializedPropertyType.Float:
                    // 用 R 格式：float 的 0.1 不能被渲染成 0.100000001490116。
                    return property.floatValue.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
                case SerializedPropertyType.String:
                    return property.stringValue;
                case SerializedPropertyType.Color:
                    return string.Format(
                        System.Globalization.CultureInfo.InvariantCulture,
                        "{0}, {1}, {2}, {3}",
                        property.colorValue.r, property.colorValue.g, property.colorValue.b, property.colorValue.a);
                case SerializedPropertyType.Vector2:
                    return Format(property.vector2Value.x, property.vector2Value.y);
                case SerializedPropertyType.Vector3:
                    return Format(property.vector3Value.x, property.vector3Value.y, property.vector3Value.z);
                case SerializedPropertyType.Vector4:
                    return Format(property.vector4Value.x, property.vector4Value.y, property.vector4Value.z, property.vector4Value.w);
                case SerializedPropertyType.Rect:
                    return Format(property.rectValue.x, property.rectValue.y, property.rectValue.width, property.rectValue.height);
                case SerializedPropertyType.Bounds:
                    UnityEngine.Bounds bounds = property.boundsValue;
                    return Format(bounds.center.x, bounds.center.y, bounds.center.z, bounds.extents.x, bounds.extents.y, bounds.extents.z);
                case SerializedPropertyType.Quaternion:
                    UnityEngine.Quaternion rotation = property.quaternionValue;
                    return Format(rotation.x, rotation.y, rotation.z, rotation.w);
                case SerializedPropertyType.LayerMask:
                    return property.intValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
                case SerializedPropertyType.ObjectReference:
                    return property.objectReferenceValue == null ? "None" : property.objectReferenceValue.name;
                case SerializedPropertyType.Enum:
                    return EnumLabel(property);
                case SerializedPropertyType.Generic:
                    return string.Empty;
                default:
                    return property.propertyType == SerializedPropertyType.ArraySize ? property.intValue.ToString() : string.Empty;
            }
        }

        /// <summary>
        /// 枚举字段的显示名。`enumValueIndex` 是属性的序号，不是枚举值本身
        /// （位域、[InspectorName] 都会让两者不同），所以优先按
        /// `enumDisplayNames` 取，取不到才退回索引。
        /// </summary>
        private static string EnumLabel(SerializedProperty property)
        {
            string[] names = property.enumDisplayNames;
            int index = property.enumValueIndex;
            if (names != null && index >= 0 && index < names.Length)
                return names[index];
            return property.intValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        private static string Format(params float[] values)
        {
            string[] parts = new string[values.Length];
            for (int i = 0; i < values.Length; i++)
                parts[i] = values[i].ToString("R", System.Globalization.CultureInfo.InvariantCulture);
            return string.Join(", ", parts);
        }

        internal static string Error(string message)
        {
            StringBuilder builder = new StringBuilder("{\"error\":");
            AppendString(builder, message ?? string.Empty);
            builder.Append('}');
            return builder.ToString();
        }

        internal static void AppendString(StringBuilder builder, string value)
        {
            if (value == null)
            {
                builder.Append("null");
                return;
            }
            builder.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                            builder.Append("\\u").Append(((int)c).ToString("x4"));
                        else
                            builder.Append(c);
                        break;
                }
            }
            builder.Append('"');
        }

        /// <summary>从请求 JSON 里取一个字符串字段（只处理扁平对象，够用即可）。</summary>
        internal static string ReadStringField(string json, string name)
        {
            object value;
            if (!TryReadField(json, name, out value))
                return null;
            return value as string;
        }

        internal static int ReadIntField(string json, string name, int fallback)
        {
            object value;
            if (!TryReadField(json, name, out value))
                return fallback;
            if (value is double)
                return (int)Math.Round((double)value);
            long parsed;
            if (value is string && long.TryParse((string)value, out parsed))
                return (int)parsed;
            return fallback;
        }

        private static bool TryReadField(string json, string name, out object value)
        {
            value = null;
            if (string.IsNullOrEmpty(json))
                return false;
            string quoted = "\"" + name + "\"";
            int at = json.IndexOf(quoted, StringComparison.Ordinal);
            if (at < 0)
                return false;
            int colon = json.IndexOf(':', at + quoted.Length);
            if (colon < 0)
                return false;
            int index = colon + 1;
            while (index < json.Length && char.IsWhiteSpace(json[index]))
                index++;
            if (index >= json.Length)
                return false;
            if (json[index] == '"')
            {
                StringBuilder text = new StringBuilder();
                index++;
                while (index < json.Length && json[index] != '"')
                {
                    if (json[index] == '\\' && index + 1 < json.Length)
                    {
                        char escape = json[index + 1];
                        text.Append(escape == 'n' ? '\n' : escape == 't' ? '\t' : escape);
                        index += 2;
                        continue;
                    }
                    text.Append(json[index]);
                    index++;
                }
                value = text.ToString();
                return true;
            }
            int end = index;
            while (end < json.Length && json[end] != ',' && json[end] != '}')
                end++;
            string raw = json.Substring(index, end - index).Trim();
            double number;
            if (double.TryParse(raw, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out number))
            {
                value = number;
                return true;
            }
            value = raw;
            return raw.Length > 0;
        }

        /// <summary>
        /// 反射指纹：类型与字段名集合的哈希。
        ///
        /// 域重载之后对象身份会变，但“磁盘上的类型是这个脚本吗”必须能跨域比对。
        /// 用字段名而不是程序集版本号，因为版本号在每次重编译后都会变。
        /// </summary>
        internal static string TypeFingerprint(Type type)
        {
            if (type == null)
                return string.Empty;
            List<string> fields = new List<string>();
            for (Type current = type; current != null && current != typeof(object); current = current.BaseType)
            {
                foreach (FieldInfo field in current.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                    fields.Add(current.Name + "." + field.Name);
            }
            fields.Sort(StringComparer.Ordinal);
            unchecked
            {
                int hash = 17;
                foreach (string field in fields)
                    hash = hash * 31 + field.GetHashCode();
                return type.FullName + "#" + fields.Count + ":" + hash.ToString("x8");
            }
        }
    }
}
