using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;

using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace DshBridge.Live
{
    /// <summary>
    /// 预制件实例的覆盖表：`unity_prefab_overrides` 的实时答案。
    ///
    /// 磁盘 YAML 里覆盖记录是 `m_Modifications` 的一串 `{propertyPath,
    /// value, objectReference, target}`，可读性很差，而且要自己判断一条覆盖是否还
    /// 生效（目标对象可能已经没了）。编辑器里问 Unity 拿的是**已经算好的覆盖集合**：
    /// 每条都带着来源值和实例值，直接就是“改了什么、改成了什么”。
    ///
    /// 两条数据源，都是有意的：
    ///   1. 场景里的实例——场景没被打开时先打开它（和 live 读场景同一条路径），
    ///      否则场景里的覆盖一条都看不见；
    ///   2. 预制件资产里的嵌套实例——资产文件自己也可能是一个实例。
    ///
    /// `PrefabUtility.GetPropertyModifications` 与它要的 `PrefabInstance` 句柄都是
    /// **internal** 的，因此这里全程反射调用；拿不到时如实返回 unsupported，不回退
    /// 去解析磁盘。
    /// </summary>
    internal static class PrefabOverrides
    {
        internal sealed class Override
        {
            public string target;
            public string property_path;
            public string value;
            public string object_reference;
            public string original_value;
            public string original_object_reference;
        }

        private const BindingFlags AnyStatic = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;

        /// <summary>覆盖记录的读取方式：两种修饰名在不同版本里都用过，逐个试。</summary>
        private static readonly MethodInfo[] ModificationMethods = new[]
        {
            FindMethod("GetPropertyModifications", 1),
            FindMethod("GetObjectOverrides", 1),
        };

        private static readonly MethodInfo _getOriginalTargetMethod =
            typeof(PrefabUtility).GetMethod("GetCorrespondingObjectFromSource", BindingFlags.Public | BindingFlags.Static);

        private static MethodInfo FindMethod(string name, int parameterCount)
        {
            foreach (MethodInfo method in typeof(PrefabUtility).GetMethods(AnyStatic))
            {
                if (method.Name == name && method.GetParameters().Length == parameterCount)
                    return method;
            }
            return null;
        }

        internal static bool Supported
        {
            get { return ModificationMethods[0] != null || ModificationMethods[1] != null; }
        }

        /// <summary>对一个资产路径收集覆盖；不是预制件实例时返回空表。</summary>
        internal static List<Override> Collect(string assetPath, out string unsupportedReason)
        {
            unsupportedReason = null;
            List<Override> overrides = new List<Override>();
            if (!Supported)
            {
                unsupportedReason = "this Editor version has no PrefabUtility.GetPropertyModifications";
                return overrides;
            }

            List<GameObject> roots = LoadRoots(assetPath);
            if (roots.Count == 0)
                return overrides;

            foreach (GameObject root in roots)
            {
                if (root == null)
                    continue;
                foreach (object instance in InstancesIn(root))
                    AppendModifications(instance, overrides, ref unsupportedReason);
            }
            return overrides;
        }

        /// <summary>
        /// 资产路径 → 参与覆盖统计的根对象。
        ///
        /// 场景的根对象不是“资产”，`LoadAssetAtPath` 对它返回 null，所以场景走打开
        /// 场景那条路（读取失败的一律返回空表，由调用方如实报“没读到”）。
        /// </summary>
        private static List<GameObject> LoadRoots(string assetPath)
        {
            List<GameObject> roots = new List<GameObject>();
            if (assetPath.EndsWith(".unity", StringComparison.OrdinalIgnoreCase))
            {
                Scene already = SceneManager.GetSceneByPath(assetPath);
                Scene scene = already.IsValid() && already.isLoaded
                    ? already
                    : EditorSceneManager.OpenScene(assetPath, OpenSceneMode.Single);
                if (scene.IsValid())
                    roots.AddRange(scene.GetRootGameObjects());
                return roots;
            }

            UnityEngine.Object[] loaded;
            try
            {
                loaded = AssetDatabase.LoadAllAssetsAtPath(assetPath);
            }
            catch (Exception)
            {
                return roots;
            }
            foreach (UnityEngine.Object item in loaded ?? Array.Empty<UnityEngine.Object>())
            {
                GameObject gameObject = item as GameObject;
                if (gameObject != null)
                    roots.Add(gameObject);
            }
            return roots;
        }

        /// <summary>根对象自身 + 它下面的每个实例（嵌套预制件也算）。</summary>
        private static IEnumerable<object> InstancesIn(GameObject root)
        {
            List<object> instances = new List<object>();
            CollectInstances(root, instances);
            foreach (object instance in instances)
                yield return instance;
        }

        private static readonly MethodInfo _prefabInstanceHandle =
            typeof(PrefabUtility).GetMethod("GetPrefabInstanceHandle", AnyStatic);

        private static void CollectInstances(GameObject root, List<object> into)
        {
            // 每个 Transform 都是一个潜在的实例根；问 Unity 要它的实例句柄，
            // 不是实例的返回 null。
            List<Transform> transforms = new List<Transform>(root.GetComponentsInChildren<Transform>(true));
            foreach (Transform transform in transforms)
            {
                if (transform == null)
                    continue;
                if (_prefabInstanceHandle == null)
                    continue;
                object handle;
                try
                {
                    handle = _prefabInstanceHandle.Invoke(null, new object[] { transform });
                }
                catch (Exception)
                {
                    continue;
                }
                if (handle != null && !into.Contains(handle))
                    into.Add(handle);
            }
        }

        private static void AppendModifications(object instance, List<Override> overrides, ref string unsupportedReason)
        {
            Array modifications = null;
            foreach (MethodInfo method in ModificationMethods)
            {
                if (method == null)
                    continue;
                try
                {
                    modifications = method.Invoke(null, new[] { instance }) as Array;
                }
                catch (Exception ex)
                {
                    unsupportedReason = "prefab modifications unavailable: " + ex.Message;
                    continue;
                }
                if (modifications != null)
                    break;
            }
            if (modifications == null)
                return;

            foreach (object modification in modifications)
            {
                if (modification == null)
                    continue;
                Override entry = new Override();
                entry.target = ReadMember(modification, "target");
                entry.property_path = ReadMember(modification, "propertyPath");
                entry.value = ReadMember(modification, "value");
                entry.object_reference = ReadMember(modification, "objectReference");
                if (entry.target == null && entry.property_path == null)
                    continue;
                TryDescribeOriginal(entry);
                overrides.Add(entry);
            }
        }

        /// <summary>
        /// 来源值：在预制件资产里找实例对应的源对象，再取同一属性路径的值。
        /// 找不到就留空——空字符串在工具输出里读作“来源里没有这个值”，不是零。
        /// </summary>
        private static void TryDescribeOriginal(Override entry)
        {
            if (_getOriginalTargetMethod == null || entry.target == null)
                return;
            try
            {
                UnityEngine.Object target = FindObject(entry.target);
                if (target == null)
                    return;
                object source = _getOriginalTargetMethod.Invoke(null, new object[] { target, true });
                if (source == null)
                    return;
                SerializedObject serialized = new SerializedObject((UnityEngine.Object)source);
                SerializedProperty property = serialized.FindProperty(entry.property_path ?? string.Empty);
                if (property != null)
                {
                    if (property.propertyType == SerializedPropertyType.ObjectReference)
                        entry.original_object_reference = property.objectReferenceValue == null
                            ? "None"
                            : property.objectReferenceValue.name;
                    else if (property.propertyType == SerializedPropertyType.String)
                        entry.original_value = property.stringValue;
                    else if (property.propertyType == SerializedPropertyType.Boolean)
                        entry.original_value = property.boolValue ? "true" : "false";
                    else if (property.propertyType == SerializedPropertyType.Float)
                        entry.original_value = property.floatValue.ToString("R", CultureInfo.InvariantCulture);
                    else if (property.propertyType == SerializedPropertyType.Enum)
                        entry.original_value = property.enumValueIndex.ToString(CultureInfo.InvariantCulture);
                    else
                        entry.original_value = property.intValue.ToString(CultureInfo.InvariantCulture);
                }
                serialized.Dispose();
            }
            catch (Exception)
            {
                // 来源值只是附加信息；拿不到就不给，不影响覆盖表本身。
            }
        }

        /// <summary>
        /// 覆盖记录里的 target 形如 `Name (Type) (in Assets/Prefabs/X.prefab)`；
        /// 去掉 “(in …)” 之后用 `FindAsset` 找对象。找不到就返回 null，
        /// 调用方保留原始字符串。
        /// </summary>
        private static UnityEngine.Object FindObject(string target)
        {
            int at = target.LastIndexOf("(in ", StringComparison.Ordinal);
            if (at < 0)
                return null;
            string path = target.Substring(at + 4).Trim().TrimEnd(')').Trim();
            if (path.Length == 0)
                return null;
            return AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path);
        }

        private static string ReadMember(object instance, string name)
        {
            Type type = instance.GetType();
            PropertyInfo property = type.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (property != null)
            {
                object value = property.GetValue(instance, null);
                return value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
            }
            FieldInfo field = type.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (field == null)
                return null;
            object raw = field.GetValue(instance);
            return raw == null ? null : Convert.ToString(raw, CultureInfo.InvariantCulture);
        }

        internal static string ToJson(string assetPath, List<Override> overrides, string unsupportedReason)
        {
            System.Text.StringBuilder builder = new System.Text.StringBuilder(1024);
            builder.Append("{\"path\":");
            DshLiveSource.AppendString(builder, assetPath);
            if (unsupportedReason != null)
            {
                builder.Append(",\"error\":");
                DshLiveSource.AppendString(builder, unsupportedReason);
                builder.Append(",\"overrides\":[]}");
                return builder.ToString();
            }
            builder.Append(",\"count\":").Append(overrides.Count);
            builder.Append(",\"overrides\":[");
            for (int i = 0; i < overrides.Count; i++)
            {
                if (i > 0)
                    builder.Append(',');
                Override entry = overrides[i];
                builder.Append("{\"target\":");
                DshLiveSource.AppendString(builder, entry.target);
                builder.Append(",\"property_path\":");
                DshLiveSource.AppendString(builder, entry.property_path);
                builder.Append(",\"value\":");
                DshLiveSource.AppendString(builder, entry.value);
                builder.Append(",\"object_reference\":");
                DshLiveSource.AppendString(builder, entry.object_reference);
                if (entry.original_value != null)
                {
                    builder.Append(",\"original_value\":");
                    DshLiveSource.AppendString(builder, entry.original_value);
                }
                if (entry.original_object_reference != null)
                {
                    builder.Append(",\"original_object_reference\":");
                    DshLiveSource.AppendString(builder, entry.original_object_reference);
                }
                builder.Append('}');
            }
            builder.Append("]}");
            return builder.ToString();
        }
    }
}
