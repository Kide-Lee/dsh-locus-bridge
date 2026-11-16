using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Text;

namespace DshBridge.Health
{
    /// <summary>
    /// 健康消息的最小 JSON 编解码。
    ///
    /// 为什么不用 Unity 的 JsonUtility：它读不了裸标量（<c>{"enabled":true}</c> 里
    /// 的布尔没问题，但读不了顶层数组与 null），而这里只需要“输出一个平坦对象、
    /// 读一个布尔字段”这两件事。也不复用 HotReloadJson：那是另一个功能区的
    /// 内部类型，健康区不该依赖它的演化。
    /// </summary>
    internal static class HealthJson
    {
        internal static string Error(string message)
        {
            return "{\"error\":" + Quote(message ?? string.Empty) + "}";
        }

        /// <summary>输出字符串/布尔/整数/字典/可枚举，其余按公开实例字段反射输出。</summary>
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

            builder.Append('{');
            bool wroteAny = false;
            foreach (FieldInfo field in value.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                object fieldValue = field.GetValue(value);
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
            StringBuilder builder = new StringBuilder((text ?? string.Empty).Length + 2);
            builder.Append('"');
            foreach (char c in text ?? string.Empty)
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

        /// <summary>
        /// 读 <c>{"enabled":true|false}</c>。载荷为空时返回 true（“订阅”是这条消息
        /// 的默认语义）；认不出形状时返回 null，由调用方报错而不是猜。
        /// </summary>
        internal static bool? ParseEnabled(string json)
        {
            string text = (json ?? string.Empty).Trim();
            if (text.Length == 0)
                return true;

            int key = text.IndexOf("\"enabled\"", StringComparison.Ordinal);
            if (key < 0)
                return null;
            int colon = text.IndexOf(':', key + 9);
            if (colon < 0)
                return null;

            string rest = text.Substring(colon + 1).TrimStart();
            if (rest.StartsWith("true", StringComparison.Ordinal))
                return true;
            if (rest.StartsWith("false", StringComparison.Ordinal))
                return false;
            return null;
        }
    }
}