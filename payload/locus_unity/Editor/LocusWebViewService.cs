using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace Locus
{
    [Serializable]
    public sealed class LocusViewConnection
    {
        const string ConnectionKey = "Locus.NativeWebView.Connection.v1";
        public string url, instanceId, viewId, title;
        /// <summary>Get the connection last authorized by Locus for this Unity
        /// project. Reopen a View from Locus after its backend is restarted.</summary>
        public static bool TryGet(string viewId, out LocusViewConnection connection)
        {
            connection = null;
            var json = SessionState.GetString(ConnectionKey, "");
            if (string.IsNullOrWhiteSpace(viewId) || string.IsNullOrEmpty(json))
                return false;
            connection = FromJson(json);
            connection.viewId = viewId;
            connection.title = viewId;
            return true;
        }

        internal static void Remember(LocusViewConnection connection)
        {
            SessionState.SetString(ConnectionKey, JsonUtility.ToJson(connection));
        }

        public static LocusViewConnection FromJson(string json)
        {
            var value = JsonUtility.FromJson<LocusViewConnection>(json);
            if (value == null || string.IsNullOrEmpty(value.instanceId) || string.IsNullOrEmpty(value.viewId) || string.IsNullOrEmpty(value.url))
                throw new ArgumentException("Invalid Locus View connection");
            return value;
        }
    }

    [Serializable]
    public sealed class LocusViewContext
    {
        public LocusBridge.SerializedPropertyBindingTarget[] targets = new LocusBridge.SerializedPropertyBindingTarget[0];
        public string dataJson = "{}";
        public static LocusViewContext FromObjects(params UnityEngine.Object[] objects)
        {
            return new LocusViewContext
            {
                targets = (objects ?? new UnityEngine.Object[0]).Where(o => o != null).Select(LocusBridge.NativeViewTarget).ToArray()
            };
        }
    }

    public static partial class LocusBridge
    {
        public static SerializedPropertyBindingTarget NativeViewTarget(UnityEngine.Object obj)
        {
            if (obj == null)
                throw new ArgumentNullException(nameof(obj));
            return new SerializedPropertyBindingTarget
            {
                globalObjectId = PropertyTreeIdentity(obj),
                kind = EditorUtility.IsPersistent(obj) ? "asset" : obj is Component ? "component" : "gameobject",
                path = AssetDatabase.GetAssetPath(obj),
                propertyPath = ""
            };
        }
    }

    /// <summary>A logical control; owns no browser while detached or clipped away.</summary>
    public sealed class LocusWebViewLease : IDisposable
    {
        internal readonly EditorWindow Owner;
        internal readonly string Key;
        internal LocusViewConnection Connection;
        internal LocusViewContext Context;
        internal LocusWebViewService.Slot Slot;
        internal bool Disposed, Visible, Occluded;
        internal Rect Full, Clip, OwnerRect;
        internal float PixelsPerPoint = 1;
        internal IntPtr Hwnd;
        internal string Fingerprint;
        internal double LastLayout;
        internal double RetryAt;
        internal readonly Queue<double> Recoveries = new Queue<double>();
        internal object OwnerParent;
        public event Action<bool> FocusLeaving;
        public event Action<Vector2, Vector2> ScrollLeaving;
        public string Error { get; internal set; }

        public bool Ready
        {
            get
            {
                return Slot != null && Slot.ready && string.IsNullOrEmpty(Error);
            }
        }

        public bool WaitingForCapacity
        {
            get
            {
                return Slot == null && Visible && LocusWebViewService.AtCapacity;
            }
        }

        public int NativeId
        {
            get
            {
                return Slot != null ? Slot.id : 0;
            }
        }

        public string BindingIdentity
        {
            get
            {
                return Key;
            }
        }

        public LocusWebViewLease(EditorWindow owner, string controlKey, LocusViewConnection connection, LocusViewContext context = null)
        {
            if (owner == null)
                throw new ArgumentNullException(nameof(owner));
            if (string.IsNullOrWhiteSpace(controlKey))
                throw new ArgumentException("A stable per-control key is required", nameof(controlKey));
            Owner = owner;
#if UNITY_6000_5_OR_NEWER
            Key = EntityId.ToULong(owner.GetEntityId()).ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + controlKey;
#else
            Key = LocusObjectIdentity.InstanceId(owner) + ":" + controlKey;
#endif
            Connection = connection ?? throw new ArgumentNullException(nameof(connection));
            Context = context ?? new LocusViewContext();
            Fingerprint = BindingFingerprint();
            LocusWebViewService.Register(this);
        }

        string BindingFingerprint()
        {
            return Connection.url + "|" + Connection.viewId + "|" + JsonUtility.ToJson(Context);
        }

        public void SetContext(LocusViewContext context)
        {
            Context = context ?? new LocusViewContext();
            string next = BindingFingerprint();
            if (next == Fingerprint)
                return;
            Fingerprint = next;
            Error = null;
            if (Slot != null)
                LocusWebViewService.Rebind(this);
        }

        public void SetConnection(LocusViewConnection connection)
        {
            Connection = connection ?? throw new ArgumentNullException(nameof(connection));
            SetContext(Context);
        }

        public void SetLayout(Rect screenRect, Rect screenClip, bool visible = true, float pixelsPerPoint = 0)
        {
            if (Disposed)
                return;
            LastLayout = EditorApplication.timeSinceStartup;
            // EditorApplication.update has no owning GUI context. Retain the
            // scale captured by this control's own Repaint on its own monitor.
            float scale = pixelsPerPoint > 0 ? pixelsPerPoint : Event.current != null ? EditorGUIUtility.pixelsPerPoint : PixelsPerPoint;
            if (!float.IsNaN(scale) && !float.IsInfinity(scale) && scale > 0) PixelsPerPoint = scale;
            Full = screenRect;
            Clip = LocusWebViewNative.Intersect(screenRect, screenClip);
            if (!LocusWebViewNative.Supported)
            {
                Error = "原生 View 当前支持 Windows Unity Editor。";
                return;
            }

            Visible = visible && LocusWebViewNative.Finite(Full) && LocusWebViewNative.Finite(Clip) && Clip.width > 1 && Clip.height > 1 && LocusWebViewService.OwnerVisible(Owner);
            if (!Visible)
            {
                LocusWebViewService.Update(this);
                return;
            }

            var parent = LocusWebViewNative.OwnerParent(Owner);
            if (OwnerRect != Owner.position || OwnerParent != parent || Hwnd == IntPtr.Zero || !LocusWebViewNative.IsWindow(Hwnd))
            {
                OwnerRect = Owner.position;
                OwnerParent = parent;
                Hwnd = LocusWebViewNative.FindOwner(Owner);
            }

            LocusWebViewService.Update(this);
        }

        public void Hide()
        {
            Visible = false;
            if (Slot != null)
                LocusWebViewService.Update(this);
        }

        internal void SetOccluded(bool value)
        {
            Occluded = value;
            LocusWebViewService.Update(this);
        }

        public void Focus(bool backwards = false)
        {
            if (Ready && !Occluded && !LocusWebViewNative.HasBlockingPopup(Owner, Full))
            {
                Owner.Focus();
                LocusWebViewNative.locus_webview_focus(Slot.id, backwards ? 2 : 1);
            }
        }

        public void Retry()
        {
            Error = null;
            RetryAt = 0;
            LocusWebViewService.Retry(this);
        }

        internal void LeaveFocus(bool backwards)
        {
            Owner.Focus();
            FocusLeaving?.Invoke(backwards);
        }

        internal void LeaveScroll(Vector2 delta, Vector2 point)
        {
            ScrollLeaving?.Invoke(delta, point);
        }

        public void Dispose()
        {
            if (Disposed)
                return;
            Disposed = true;
            LocusWebViewService.Unregister(this);
        }
    }

    [InitializeOnLoad]
    internal static class LocusWebViewService
    {
        internal const int ActiveLimit = 4, WarmLimit = 2;
        internal const double IdleSeconds = 30;
        const string SessionKey = "Locus.NativeWebView.Slots.v1";
        [Serializable]
        internal sealed class Slot
        {
            public int id;
            public ulong generation;
            public long parent;
            public string key, fingerprint;
            public bool ready, releasing, paused;
            public double touched;
            [NonSerialized]
            public double reclaimUntil;
            [NonSerialized]
            public LocusWebViewLease owner;
            [NonSerialized]public EditorWindow detachedOwner;
            [NonSerialized]public bool restored;
        }

        [Serializable]
        sealed class Saved
        {
            public List<Slot> slots = new List<Slot>();
        }

        [Serializable]
        sealed class Status
        {
            public bool running, ready;
            public string error;
            public Child[] children;
        }

        [Serializable]
        sealed class Child
        {
            public int id;
            public ulong generation;
            public bool ready;
        }

        [Serializable]
        sealed class Message
        {
            public string type, message, key;
            public bool shift, crashed;
            public int id, reason;
            public ulong generation;
            public float deltaX, deltaY, x, y;
        }

        [Serializable]
        sealed class Binding
        {
            public string type = "bind", instanceId, viewId, theme;
            public int id;
            public ulong generation;
            public LocusViewContext context;
        }

        [Serializable]
        sealed class Signal
        {
            public string type;
            public int id;
            public ulong generation;
        }

        static readonly List<Slot> Slots = new List<Slot>();
        static readonly HashSet<LocusWebViewLease> Leases = new HashSet<LocusWebViewLease>();
        static readonly FieldInfo ParentField = typeof(EditorWindow).GetField("m_Parent", BindingFlags.Instance | BindingFlags.NonPublic);
        static bool reloading;
        static string rootUrl, hostError;
        static double idleSince, startedAt;
        static bool started, rootReady;
        static double hostRetryAt;
        static readonly Queue<double> HostRecoveries = new Queue<double>();

        static bool TakeRecovery(Queue<double> attempts)
        {
            double now = EditorApplication.timeSinceStartup;
            while (attempts.Count > 0 && now - attempts.Peek() >= 60) attempts.Dequeue();
            if (attempts.Count >= 3) return false;
            attempts.Enqueue(now);
            return true;
        }

        internal static void Retry(LocusWebViewLease lease)
        {
            if (!string.IsNullOrEmpty(hostError)) { Restart(); return; }
            if (lease.Slot != null)
            {
                var slot = lease.Slot;
                lease.Slot = null;
                LocusWebViewNative.locus_webview_close(slot.id);
                Slots.Remove(slot);
                Save();
            }
            lease.Error = null;
        }
        internal static bool AtCapacity
        {
            get
            {
                return Slots.Count(s => s.owner != null) >= ActiveLimit;
            }
        }

        static LocusWebViewService()
        {
            if (!LocusWebViewNative.Supported)
                return;
            try
            {
                var status = JsonUtility.FromJson<Status>(LocusWebViewNative.Status());
                started = status.running;
                rootReady = status.ready;
                rootUrl = SessionState.GetString(SessionKey + ".url", "");
                var saved = JsonUtility.FromJson<Saved>(SessionState.GetString(SessionKey, "{}"));
                foreach (var slot in saved?.slots ?? new List<Slot>())
                {
                    var child = (status.children ?? new Child[0]).FirstOrDefault(c => c.id == slot.id);
                    if (child != null)
                    {
                        slot.ready = child.ready;
                        slot.paused = true;
                        slot.generation = child.generation;
                        slot.touched = EditorApplication.timeSinceStartup;
                        slot.reclaimUntil = slot.touched + IdleSeconds;
                        slot.restored=true;
                        Slots.Add(slot);
                    }
                }

                startedAt = EditorApplication.timeSinceStartup;
            }
            catch (DllNotFoundException)
            {
            }
            catch (EntryPointNotFoundException)
            {
            }
            catch (Exception e)
            {
                UnityEngine.Debug.LogWarning("[Locus] Native View restore: " + e.Message);
            }

            EditorApplication.update += Tick;
            EditorApplication.quitting += Shutdown;
            AssemblyReloadEvents.beforeAssemblyReload += () =>
            {
                reloading = true;
                foreach (var slot in Slots)
                {
                    LocusWebViewNative.Hide(slot.id);
                    LocusWebViewNative.Send(new Signal { type = "suspend", id = slot.id, generation = slot.generation });
                }

                Save();
            };
        }

        internal static bool OwnerVisible(EditorWindow owner)
        {
            if (owner == null || owner.rootVisualElement.panel == null)
                return false;
            try
            {
                var parent = ParentField?.GetValue(owner);
                var actual = parent?.GetType().GetProperty("actualView", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(parent, null) as EditorWindow;
                if (actual != null && actual != owner)
                    return false;
            }
            catch (Exception)
            {
            }

            return true;
        }

        internal static void Register(LocusWebViewLease lease)
        {
            if (Leases.Any(l => !l.Disposed && l.Key == lease.Key))
                throw new InvalidOperationException("Duplicate native View key in the same EditorWindow: " + lease.Key);
            Leases.Add(lease);
            var restored = Slots.FirstOrDefault(s => s.owner == null && s.key == lease.Key && !s.releasing&&(s.restored||ReferenceEquals(s.detachedOwner,lease.Owner)));
            if (restored != null)
            {
                restored.owner = lease;
                restored.restored=false;restored.detachedOwner=null;
                lease.Slot = restored;
                if (restored.fingerprint != lease.Fingerprint)
                    restored.ready = false;
            }
        }

        internal static void Unregister(LocusWebViewLease lease)
        {
            Leases.Remove(lease);
            if (lease.Slot == null)
                return;
            // UI Toolkit can detach before beforeAssemblyReload fires. Preserve
            // the binding briefly so reattach/reload can reclaim the same Vue.
            var slot = lease.Slot;
            lease.Slot = null;
            slot.owner = null;
            slot.detachedOwner=lease.Owner;
            slot.paused = true;
            slot.touched = EditorApplication.timeSinceStartup;
            slot.reclaimUntil = slot.touched + 0.25;
            LocusWebViewNative.locus_webview_park(slot.id);
            slot.parent = 0;
            LocusWebViewNative.Send(new Signal { type = "suspend", id = slot.id, generation = slot.generation });
            Save();
        }

        static void Save()
        {
            SessionState.SetString(SessionKey, JsonUtility.ToJson(new Saved { slots = Slots }));
            SessionState.SetString(SessionKey + ".url", rootUrl ?? "");
        }

        static ulong Generation()
        {
            int n = SessionState.GetInt(SessionKey + ".generation", 0) + 1;
            SessionState.SetInt(SessionKey + ".generation", n);
            return (ulong)n;
        }

        static int NextId()
        {
            int n = SessionState.GetInt(SessionKey + ".id", 0) + 1;
            SessionState.SetInt(SessionKey + ".id", n);
            return n;
        }

        static void Start(LocusWebViewLease lease)
        {
            if (started)
            {
                if (rootUrl != lease.Connection.url)
                {
                    lease.Error = "Locus 连接已变化，请重新打开视图。";
                }

                return;
            }

            var profile = Path.GetFullPath(Path.Combine(Application.dataPath, "../Library/Locus/WebView2/Shared"));
            byte[] p = Encoding.UTF8.GetBytes(profile), u = Encoding.UTF8.GetBytes(lease.Connection.url);
            try
            {
                int result = LocusWebViewNative.locus_webview_start(lease.Hwnd, p, p.Length, u, u.Length);
                if (result != 0)
                {
                    lease.Error = "无法启动 WebView2（" + result + "）。请检查运行时。";
                    return;
                }
            }
            catch (DllNotFoundException)
            {
                lease.Error = "Locus 原生插件未安装。请从 Locus 更新 Unity 插件。";
                return;
            }
            catch (EntryPointNotFoundException)
            {
                lease.Error = "Locus 原生插件需要更新。更新后请重启 Unity。";
                return;
            }

            started = true;
            rootUrl = lease.Connection.url;
            hostError = null;
            startedAt = EditorApplication.timeSinceStartup;
            Save();
        }

        internal static void Update(LocusWebViewLease lease)
        {
            if (!LocusWebViewNative.Supported)
            {
                lease.Error = "原生 View 当前支持 Windows Unity Editor。";
                return;
            }

            if (reloading || EditorApplication.isCompiling)
            {
                if (lease.Slot != null)
                {
                    LocusWebViewNative.Hide(lease.Slot.id);
                    if (!lease.Slot.paused)
                    {
                        lease.Slot.paused = true;
                        LocusWebViewNative.Send(new Signal { type = "suspend", id = lease.Slot.id, generation = lease.Slot.generation });
                    }
                }

                return;
            }

            if (lease.Occluded || LocusWebViewNative.HasBlockingPopup(lease.Owner, lease.Full))
            {
                if (lease.Slot != null)
                {
                    LocusWebViewNative.Hide(lease.Slot.id);
                    if (!lease.Slot.paused)
                    {
                        lease.Slot.paused = true;
                        LocusWebViewNative.Send(new Signal { type = "suspend", id = lease.Slot.id, generation = lease.Slot.generation });
                    }
                }

                return;
            }

            if (!lease.Visible || lease.Hwnd == IntPtr.Zero)
            {
                if (lease.Slot != null)
                    Release(lease);
                return;
            }

            if (!string.IsNullOrEmpty(lease.Error))
                return;
            Start(lease);
            if (!string.IsNullOrEmpty(hostError))
            {
                lease.Error = hostError;
                return;
            }

            if (!rootReady)
                return;
            if (lease.Slot == null)
            {
                if (Slots.Count(s => s.owner != null) >= ActiveLimit)
                    return;
                var slot = Slots.FirstOrDefault(s => s.owner == null && !s.releasing && string.IsNullOrEmpty(s.key));
                if (slot == null)
                {
                    if (Slots.Count >= ActiveLimit + WarmLimit)
                        return;
                    slot = new Slot
                    {
                        id = NextId()
                    };
                    Slots.Add(slot);
                }

                slot.owner = lease;
                slot.key = lease.Key;
                lease.Slot = slot;
                slot.ready = false;
                Rebind(lease);
            }
            else if (lease.Slot.fingerprint != lease.Fingerprint)
            {
                Rebind(lease);
            }

            if (lease.Slot != null && lease.Slot.parent != lease.Hwnd.ToInt64())
            {
                if (LocusWebViewNative.locus_webview_parent(lease.Slot.id, lease.Hwnd) != 0)
                {
                    var lost = lease.Slot;
                    LocusWebViewNative.locus_webview_close(lost.id);
                    Slots.Remove(lost);
                    lease.Slot = null;
                    return;
                }

                lease.Slot.parent = lease.Hwnd.ToInt64();
            }

            if (lease.Slot != null && lease.Slot.ready)
            {
                if (lease.Slot.paused)
                {
                    lease.Slot.paused = false;
                    LocusWebViewNative.Send(new Signal { type = "resume", id = lease.Slot.id, generation = lease.Slot.generation });
                }

                LocusWebViewNative.Sync(lease.Slot.id, lease.Full, lease.Clip, lease.PixelsPerPoint);
            }
        }

        internal static void Rebind(LocusWebViewLease lease)
        {
            var slot = lease.Slot;
            if (slot == null)
                return;
            slot.generation = Generation();
            slot.parent = lease.Hwnd.ToInt64();
            slot.fingerprint = lease.Fingerprint;
            slot.ready = false;
            slot.releasing = false;
            slot.paused = false;
            slot.touched = EditorApplication.timeSinceStartup;
            byte[] payload = Encoding.UTF8.GetBytes(JsonUtility.ToJson(new Binding { instanceId = lease.Key, viewId = lease.Connection.viewId, theme = EditorGUIUtility.isProSkin ? "dark" : "light", context = lease.Context }));
            int result = LocusWebViewNative.locus_webview_bind(slot.id, slot.generation, lease.Hwnd, payload, payload.Length);
            if (result != 0)
                lease.Error = "无法绑定 View（" + result + "）。";
            Save();
        }

        static void Release(LocusWebViewLease lease)
        {
            var slot = lease.Slot;
            if (slot == null)
                return;
            lease.Slot = null;
            ReleaseSlot(slot);
        }

        static void ReleaseSlot(Slot slot)
        {
            slot.detachedOwner=null;slot.restored=false;
            slot.owner = null;
            slot.key = null;
            slot.ready = false;
            slot.releasing = true;
            slot.touched = EditorApplication.timeSinceStartup;
            LocusWebViewNative.locus_webview_park(slot.id);
            slot.parent = 0;
            LocusWebViewNative.Send(new Signal { type = "release", id = slot.id, generation = slot.generation });
            Save();
        }

        static void Tick()
        {
            if (reloading || !started)
                return;
            try
            {
                for (int i = 0; i < 32; i++)
                {
                    string json = LocusWebViewNative.Poll();
                    if (json == null)
                        break;
                    var m = JsonUtility.FromJson<Message>(json);
                    var slot = Slots.FirstOrDefault(s => s.id == m.id);
                    if (m.type == "automation-result")
                    {
                        LocusNativeViewAutomation.Receive(json);
                        continue;
                    }

                    if (m.type == "host-ready")
                    {
                        // A document reload (including development HMR) loses
                        // the Vue owner, even while native children still exist.
                        if (rootReady)
                        {
                            Restart();
                            return;
                        }

                        rootReady = true;
                    }
                    else if (m.type == "host-error")
                    {
                        hostError = m.message;
                        if (m.crashed && hostRetryAt == 0)
                        {
                            if (TakeRecovery(HostRecoveries)) hostRetryAt = EditorApplication.timeSinceStartup + 1;
                            else hostError = "View 恢复失败，请重试。";
                        }
                        foreach (var l in Leases)
                        {
                            l.Error = hostError;
                            if(l.Slot!=null)LocusWebViewNative.Hide(l.Slot.id);
                            l.Owner?.Repaint();
                        }
                    }
                    else if (m.type == "bound" && slot != null && m.generation == slot.generation)
                    {
                        slot.ready = true;
                        slot.touched = EditorApplication.timeSinceStartup;
                        slot.owner?.Owner?.Repaint();
                    }
                    else if (m.type == "released" && slot != null && m.generation == slot.generation && slot.owner == null)
                    {
                        slot.releasing = false;
                        LocusWebViewNative.locus_webview_suspend(slot.id);
                    }
                    else if (m.type == "child-error" && slot?.owner != null && (m.generation == 0 || m.generation == slot.generation))
                    {
                        slot.owner.Error = m.message;
                        if (m.crashed && slot.owner.RetryAt == 0)
                        {
                            if (TakeRecovery(slot.owner.Recoveries)) slot.owner.RetryAt = EditorApplication.timeSinceStartup + 1;
                            else slot.owner.Error = "View 恢复失败，请重试。";
                        }
                        LocusWebViewNative.Hide(slot.id);
                        slot.owner.Owner?.Repaint();
                    }
                    else if (m.type == "move-focus" && (m.reason == 1 || m.reason == 2))
                        slot?.owner?.LeaveFocus(m.reason == 2);
                    else if (m.type == "wheel")
                        slot?.owner?.LeaveScroll(new Vector2(m.deltaX, m.deltaY), new Vector2(m.x, m.y));
                    else if (m.type == "shortcut" && m.key == "s" && slot?.owner != null)
                    {
                        slot.owner.Owner.SendEvent(Event.KeyboardEvent(m.shift ? "%#s" : "%s"));
                    }
                }

                if (hostRetryAt > 0 && EditorApplication.timeSinceStartup >= hostRetryAt)
                {
                    hostRetryAt = 0;
                    Restart();
                    return;
                }
                if (!rootReady && EditorApplication.timeSinceStartup - startedAt > 30)
                {
                    var s = JsonUtility.FromJson<Status>(LocusWebViewNative.Status());
                    hostError = string.IsNullOrEmpty(s.error) ? "View 主宿主启动超时，请检查 Locus 连接并重试。" : s.error;
                    foreach (var l in Leases)
                    {
                        l.Error = hostError;
                        l.Owner?.Repaint();
                    }
                }

                foreach (var lease in Leases.ToArray())
                {
                    if (lease.Owner == null)
                    {
                        lease.Dispose();
                        continue;
                    }

                    if (hostRetryAt == 0 && lease.RetryAt > 0 && EditorApplication.timeSinceStartup >= lease.RetryAt)
                    {
                        lease.RetryAt = 0;
                        Retry(lease);
                    }

                    if (!OwnerVisible(lease.Owner) && lease.Slot != null)
                    {
                        lease.Visible = false;
                        Release(lease);
                    }
                    else if (lease.Visible)
                        Update(lease);
                }

                foreach (var detached in Slots.Where(s => s.owner == null && !string.IsNullOrEmpty(s.key) && EditorApplication.timeSinceStartup > s.reclaimUntil).ToArray())
                    ReleaseSlot(detached);
                var idle = Slots.Where(s => s.owner == null).OrderByDescending(s => s.touched).ToArray();
                for (int i = 0; i < idle.Length; i++)
                    if ((i >= WarmLimit && string.IsNullOrEmpty(idle[i].key)) || EditorApplication.timeSinceStartup - idle[i].touched > (idle[i].releasing ? 5 : IdleSeconds))
                    {
                        LocusWebViewNative.locus_webview_close(idle[i].id);
                        Slots.Remove(idle[i]);
                    }

                // Startup and a failed-but-visible control are not an idle host.
                // Keep the timeout/error visible instead of silently erasing it.
                if (!Leases.Any(l => !l.Disposed && l.Visible) && Slots.All(s => s.owner == null))
                {
                    if (idleSince == 0)
                        idleSince = EditorApplication.timeSinceStartup;
                    if (EditorApplication.timeSinceStartup - idleSince > IdleSeconds)
                        Shutdown();
                }
                else
                    idleSince = 0;
            }
            catch (Exception e)
            {
                hostError = e.Message;
                foreach (var l in Leases)
                {
                    l.Error = e.Message;
                    l.Owner?.Repaint();
                }
            }
        }

        internal static void Restart()
        {
            Shutdown();
            foreach (var l in Leases)
            { l.Error = null; l.RetryAt = 0; }
        }

        internal static void UseConnection(LocusViewConnection connection)
        {
            if (started && rootUrl != connection.url)
                Shutdown();
            foreach (var lease in Leases)
            {
                if (lease.Connection.url == connection.url)
                    continue;
                lease.Connection.url = connection.url;
                lease.Connection.instanceId = connection.instanceId;
                lease.Error = null;
                lease.SetContext(lease.Context);
            }
        }

        static void Shutdown()
        {
            if (LocusWebViewNative.Supported)
            {
                try
                {
                    LocusWebViewNative.locus_webview_shutdown();
                }
                catch (DllNotFoundException)
                {
                }
                catch (EntryPointNotFoundException)
                {
                }
            }

            foreach (var lease in Leases)
                lease.Slot = null;
            Slots.Clear();
            started = false;
            rootReady = false;
            rootUrl = null;
            hostError = null;
            idleSince = 0;
            hostRetryAt = 0;
            SessionState.EraseString(SessionKey);
            SessionState.EraseString(SessionKey + ".url");
        }

        internal static string Diagnostics()
        {
            return LocusWebViewNative.Status();
        }

        internal static string ManagedDiagnostics()
        {
            return string.Join("; ", Slots.Select(s => s.id + ":" + s.key + ":owner=" + (s.owner != null) + ":ready=" + s.ready + ":generation=" + s.generation));
        }
    }
}
