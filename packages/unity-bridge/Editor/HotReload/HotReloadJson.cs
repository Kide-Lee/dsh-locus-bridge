using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Text;

namespace DshBridge.HotReload
{
    /// <summary>
    /// 传输用的 DTO 与一个最小 JSON 序列化器。
    ///
    /// 为什么不用 Unity 的 JsonUtility：它读不了顶层的 JSON 数组与 <c>null</c>，
    /// 而扩展消息的载荷由 DSH 端生成，字段可能缺省；也读不了 <c>string[]</c>
    /// 之外的东西（补丁方法列表是对象数组）。本包的 asmdef 里虽然有
    /// Locus.Json.dll，但它是 payload 的预编译依赖，包一旦与 payload 版本脱节就
    /// 直接编译失败；一个 300 行的 DOM 解析器是更便宜的耦合。
    ///
    /// 序列化侧只输出本文件里声明的响应形状，字段名与 docs/internal/contracts.md
    /// §2.1 一一对应（snake_case）。
    /// </summary>
    internal static class HotReloadDtos
    {
        // ───────────────── 请求 ─────────────────

        internal sealed class ClassifyRequest
        {
            public string patch_id;
            public string[] paths;
        }

        internal sealed class ApplyRequest
        {
            public string patch_id;
            public string assembly_b64;
            public string assembly_path;
            public string domain_generation;
            // 与 payload 的 hot_patch_loaded 同名同义的字段：方法身份、声明类型的
            // 原始程序集、以及补丁类型在补丁程序集里的全名。
            public ApplyMethod[] methods;
        }

        internal sealed class DisposeRequest
        {
            public string patch_id;
        }

        /// <summary><c>dsh_hot_reload_compiled_text</c>：要读哪个脚本。</summary>
        internal sealed class CompiledTextRequest
        {
            public string path;
        }

        /// <summary>编译文本的答案。序列化器走公开字段，所以不能用匿名类型。</summary>
        internal sealed class CompiledTextResponse
        {
            public string path;
            public string text;
        }

        // ───────────────── 方法身份 ─────────────────

        /// <summary>
        /// 一个待打补丁的方法。字段与 payload 的 <c>HotPatchMethodDto</c> 保持同名，
        /// 这样同一份方法清单既能喂给本包，也能喂给桌面端那条路径。
        /// </summary>
        internal class ApplyMethod
        {
            public string declaring_type;
            public string patch_declaring_type;
            public string name;
            public string[] param_type_names;
            public string[] param_type_sigs;
            public bool is_static;
            public bool is_ctor;

            // 原始方法所在程序集的简单名（可空）。
            public string original_assembly;
            // 可选：补丁方法自身名（缺省等于 name）。payload 先按 name 找，找不到
            // 再改用这个。
            public string patch_name;
            public string source_path;

            public ApplyMethod Clone()
            {
                return new ApplyMethod
                {
                    declaring_type = declaring_type,
                    patch_declaring_type = patch_declaring_type,
                    name = name,
                    param_type_names = param_type_names,
                    param_type_sigs = param_type_sigs,
                    is_static = is_static,
                    is_ctor = is_ctor,
                    original_assembly = original_assembly,
                    patch_name = patch_name,
                    source_path = source_path,
                };
            }
        }

        /// <summary>分类结果里的热方法（contracts.md §2.1 的 <c>hot[]</c>）。</summary>
        internal sealed class HotMethod : ApplyMethod
        {
            // 与 MethodKey() 的结果一致：declaring_type|name|参数表|s 或 i。
            public string method_key;
        }

        // ───────────────── 响应 ─────────────────

        internal sealed class CompileReason
        {
            public string path;
            public string reason;
        }

        internal sealed class FailedPath
        {
            public string path;
            public string error;
        }

        internal sealed class ClassifyResponse
        {
            public HotMethod[] hot;
            public CompileReason[] needCompile;
            public FailedPath[] failed;
            /// <summary>本包是否能独立完成整个热重载流程（补丁程序集编译不在本包内）。</summary>
            public bool supported;
            /// <summary>对 <c>supported</c> 的说明，工具层直接展示给用户。</summary>
            public string reason;
        }

        internal sealed class SkippedMethod
        {
            public string method_key;
            public string reason;
        }

        internal sealed class ApplyResponse
        {
            public int applied;
            public SkippedMethod[] skipped;
            public string detour_engine;
            /// <summary>当前域的代次；调用方可用它判断补丁是否还能挂。</summary>
            public string domain_generation;
        }

        internal sealed class DetourEntry
        {
            public string method_key;
            public string patch_id;
            public string engine;
            public string declaring_type;
            public string name;
            /// <summary>挂 detour 时原方法所在程序集的简单名。</summary>
            public string assembly;
        }

        internal sealed class StatusResponse
        {
            public int detours;
            public string[] patched_methods;
            public string last_error;
            public string domain_generation;
            public DetourEntry[] entries;
        }

        internal sealed class DisposeResponse
        {
            public int disposed;
        }

        /// <summary>任何一层失败都回这个形状，JS 端据此判定 <c>ok</c>。</summary>
        internal sealed class ErrorResponse
        {
            public string error;
        }

        // ───────────────── JSON 输出 ─────────────────

        internal static string Error(string message)
        {
            return "{\"error\":" + Quote(message ?? "") + "}";
        }

        internal static string ToJson(object value)
        {
            StringBuilder builder = new StringBuilder(256);
            WriteValue(builder, value);
            return builder.ToString();
        }

        private static void WriteValue(StringBuilder builder, object value)
        {
            if (value == null)
            {
                builder.Append("null");
                return;
            }

            switch (value)
            {
                case string text:
                    builder.Append(Quote(text));
                    return;
                case bool flag:
                    builder.Append(flag ? "true" : "false");
                    return;
                case int number:
                    builder.Append(number.ToString(CultureInfo.InvariantCulture));
                    return;
                case long number:
                    builder.Append(number.ToString(CultureInfo.InvariantCulture));
                    return;
                case float number:
                    builder.Append(number.ToString("R", CultureInfo.InvariantCulture));
                    return;
                case double number:
                    builder.Append(number.ToString("R", CultureInfo.InvariantCulture));
                    return;
                case IDictionary dictionary:
                {
                    builder.Append('{');
                    bool first = true;
                    foreach (DictionaryEntry entry in dictionary)
                    {
                        if (!first)
                            builder.Append(',');
                        first = false;
                        builder.Append(Quote(Convert.ToString(entry.Key, CultureInfo.InvariantCulture)));
                        builder.Append(':');
                        WriteValue(builder, entry.Value);
                    }
                    builder.Append('}');
                    return;
                }
                case IEnumerable sequence:
                {
                    builder.Append('[');
                    bool first = true;
                    foreach (object item in sequence)
                    {
                        if (!first)
                            builder.Append(',');
                        first = false;
                        WriteValue(builder, item);
                    }
                    builder.Append(']');
                    return;
                }
            }

            // 其余一律按公开字段反射输出（本文件的 DTO 都是平铺的公开字段）。
            builder.Append('{');
            bool wroteAny = false;
            foreach (FieldInfo field in value.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                object fieldValue = field.GetValue(value);
                // null 不输出：契约里的可选字段（last_error、reason）省略比显式 null
                // 更接近 payload 自己 JsonUtility 的输出。
                if (fieldValue == null)
                    continue;
                if (wroteAny)
                    builder.Append(',');
                wroteAny = true;
                builder.Append(Quote(field.Name));
                builder.Append(':');
                WriteValue(builder, fieldValue);
            }
            builder.Append('}');
        }

        internal static string Quote(string text)
        {
            StringBuilder builder = new StringBuilder(text.Length + 2);
            builder.Append('"');
            foreach (char c in text)
            {
                switch (c)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\b': builder.Append("\\b"); break;
                    case '\f': builder.Append("\\f"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (c < ' ')
                            builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else
                            builder.Append(c);
                        break;
                }
            }
            builder.Append('"');
            return builder.ToString();
        }

        // ───────────────── JSON 输入 ─────────────────

        /// <summary>
        /// 把扩展消息载荷反序列化成 <typeparamref name="T"/>。字段名按原样
        /// （snake_case）匹配；<c>string[]</c> 与嵌套对象数组都支持。
        /// 空载荷返回 null。
        /// </summary>
        internal static T Parse<T>(string json) where T : class, new()
        {
            if (string.IsNullOrWhiteSpace(json))
                return null;
            object tree = new JsonReader(json).ReadDocument();
            Dictionary<string, object> map = tree as Dictionary<string, object>;
            if (map == null)
                throw new FormatException("request must be a JSON object");
            return (T)ConvertTo(typeof(T), map);
        }

        private static object ConvertTo(Type type, object value)
        {
            if (value == null)
                return null;
            if (type == typeof(string))
                return value as string ?? Convert.ToString(value, CultureInfo.InvariantCulture);
            if (type == typeof(bool))
            {
                if (value is bool flag)
                    return flag;
                string text = Convert.ToString(value, CultureInfo.InvariantCulture);
                return string.Equals(text, "true", StringComparison.OrdinalIgnoreCase) || text == "1";
            }
            if (type == typeof(int))
                return value is int number ? number : (int)Convert.ToInt64(value, CultureInfo.InvariantCulture);
            if (type.IsArray)
            {
                Type element = type.GetElementType();
                List<object> items = value as List<object>;
                if (items == null)
                    return null;
                Array array = Array.CreateInstance(element, items.Count);
                for (int i = 0; i < items.Count; i++)
                    array.SetValue(ConvertTo(element, items[i]), i);
                return array;
            }
            Dictionary<string, object> map = value as Dictionary<string, object>;
            if (map == null)
                return null;
            object instance = Activator.CreateInstance(type, true);
            foreach (KeyValuePair<string, object> pair in map)
            {
                FieldInfo field = type.GetField(pair.Key, BindingFlags.Public | BindingFlags.Instance);
                if (field == null)
                    continue;
                field.SetValue(instance, ConvertTo(field.FieldType, pair.Value));
            }
            return instance;
        }

        /// <summary>
        /// 极小的递归下降 JSON 读取器。只服务于本文件的请求形状，但严格：任何
        /// 语法错误都抛 <see cref="FormatException"/>，绝不静默返回半个对象。
        /// </summary>
        private sealed class JsonReader
        {
            private readonly string _text;
            private int _index;

            internal JsonReader(string text)
            {
                _text = text;
            }

            internal object ReadDocument()
            {
                object value = ReadValue();
                SkipWhitespace();
                if (_index < _text.Length)
                    throw new FormatException("trailing content at offset " + _index);
                return value;
            }

            private object ReadValue()
            {
                SkipWhitespace();
                if (_index >= _text.Length)
                    throw new FormatException("unexpected end of JSON");
                char c = _text[_index];
                switch (c)
                {
                    case '{': return ReadObject();
                    case '[': return ReadArray();
                    case '"': return ReadString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default: return ReadNumber();
                }
            }

            private Dictionary<string, object> ReadObject()
            {
                Dictionary<string, object> map = new Dictionary<string, object>(StringComparer.Ordinal);
                _index++; // '{'
                SkipWhitespace();
                if (Peek() == '}')
                {
                    _index++;
                    return map;
                }
                while (true)
                {
                    SkipWhitespace();
                    if (Peek() != '"')
                        throw new FormatException("expected a key at offset " + _index);
                    string key = ReadString();
                    SkipWhitespace();
                    if (Peek() != ':')
                        throw new FormatException("expected ':' at offset " + _index);
                    _index++;
                    map[key] = ReadValue();
                    SkipWhitespace();
                    char next = Peek();
                    if (next == ',')
                    {
                        _index++;
                        continue;
                    }
                    if (next == '}')
                    {
                        _index++;
                        return map;
                    }
                    throw new FormatException("expected ',' or '}' at offset " + _index);
                }
            }

            private List<object> ReadArray()
            {
                List<object> items = new List<object>();
                _index++; // '['
                SkipWhitespace();
                if (Peek() == ']')
                {
                    _index++;
                    return items;
                }
                while (true)
                {
                    items.Add(ReadValue());
                    SkipWhitespace();
                    char next = Peek();
                    if (next == ',')
                    {
                        _index++;
                        continue;
                    }
                    if (next == ']')
                    {
                        _index++;
                        return items;
                    }
                    throw new FormatException("expected ',' or ']' at offset " + _index);
                }
            }

            private string ReadString()
            {
                _index++; // '"'
                StringBuilder builder = new StringBuilder();
                while (true)
                {
                    if (_index >= _text.Length)
                        throw new FormatException("unterminated string");
                    char c = _text[_index++];
                    if (c == '"')
                        return builder.ToString();
                    if (c != '\\')
                    {
                        builder.Append(c);
                        continue;
                    }
                    if (_index >= _text.Length)
                        throw new FormatException("unterminated escape");
                    char escape = _text[_index++];
                    switch (escape)
                    {
                        case '"': builder.Append('"'); break;
                        case '\\': builder.Append('\\'); break;
                        case '/': builder.Append('/'); break;
                        case 'b': builder.Append('\b'); break;
                        case 'f': builder.Append('\f'); break;
                        case 'n': builder.Append('\n'); break;
                        case 'r': builder.Append('\r'); break;
                        case 't': builder.Append('\t'); break;
                        case 'u':
                            if (_index + 4 > _text.Length)
                                throw new FormatException("truncated \\u escape");
                            string hex = _text.Substring(_index, 4);
                            _index += 4;
                            builder.Append((char)int.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            break;
                        default:
                            throw new FormatException("unknown escape \\" + escape);
                    }
                }
            }

            private object ReadNumber()
            {
                int start = _index;
                while (_index < _text.Length && "+-0123456789.eE".IndexOf(_text[_index]) >= 0)
                    _index++;
                if (start == _index)
                    throw new FormatException("unexpected character '" + _text[_index] + "' at offset " + _index);
                string text = _text.Substring(start, _index - start);
                if (text.IndexOf('.') < 0 && text.IndexOf('e') < 0 && text.IndexOf('E') < 0)
                {
                    long value;
                    if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
                        return (int)value == value ? (object)(int)value : value;
                }
                double real;
                if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out real))
                    throw new FormatException("invalid number '" + text + "'");
                return real;
            }

            private void Expect(string literal)
            {
                if (_index + literal.Length > _text.Length ||
                    string.CompareOrdinal(_text, _index, literal, 0, literal.Length) != 0)
                    throw new FormatException("expected '" + literal + "' at offset " + _index);
                _index += literal.Length;
            }

            private char Peek()
            {
                if (_index >= _text.Length)
                    throw new FormatException("unexpected end of JSON");
                return _text[_index];
            }

            private void SkipWhitespace()
            {
                while (_index < _text.Length)
                {
                    char c = _text[_index];
                    if (c != ' ' && c != '\t' && c != '\n' && c != '\r')
                        return;
                    _index++;
                }
            }
        }
    }
}