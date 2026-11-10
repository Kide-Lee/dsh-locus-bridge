using System;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;

namespace Locus
{
    /// <summary>Native rectangular View slot. Supply the actual owning
    /// EditorWindow and a key unique within that window, including Inspectors.</summary>
    public sealed class LocusWebViewElement : VisualElement, IDisposable
    {
        EditorWindow owner;
        readonly string key;
        LocusViewConnection connection;
        LocusViewContext context;
        readonly IMGUIContainer anchor;
        readonly Label status;
        readonly Button retry, installRuntime;
        LocusWebViewLease lease;
        Vector2 origin;
        float pixelsPerPoint = 1;
        IVisualElementScheduledItem tick;
        bool disposed, leavingFocus, originValid, laidOut;
        static readonly PropertyInfo WorldClip = typeof(VisualElement).GetProperty("worldClip", BindingFlags.Instance | BindingFlags.NonPublic);
        /// <summary>Optional extra clip in panel coordinates, for custom hosts.</summary>
        public Func<Rect> ClipProvider { get; set; }

        public LocusWebViewLease Lease
        {
            get
            {
                return lease;
            }
        }

        public LocusWebViewElement(string controlKey, LocusViewConnection connection, LocusViewContext context = null) : this(null, controlKey, connection, context)
        {
        }

        public LocusWebViewElement(EditorWindow owner, string controlKey, LocusViewConnection connection, LocusViewContext context = null)
        {
            this.owner = owner;
            key = controlKey;
            this.connection = connection;
            this.context = context ?? new LocusViewContext();
            focusable = true;
            style.minHeight = 100;
            style.flexGrow = 1;
            anchor = new IMGUIContainer(() =>
            {
                if (Event.current.type == EventType.Repaint)
                {
                    origin = GUIUtility.GUIToScreenPoint(Vector2.zero) - anchor.worldBound.position;
                    pixelsPerPoint = EditorGUIUtility.pixelsPerPoint;
                    originValid = true;
                }
            });
            anchor.style.position = Position.Absolute;
            anchor.style.left = 0;
            anchor.style.top = 0;
            anchor.style.width = 1;
            anchor.style.height = 1;
            Add(anchor);
            status = new Label("正在打开 View…");
            status.style.paddingLeft = 8;
            status.style.paddingTop = 8;
            status.style.whiteSpace = WhiteSpace.Normal;
            Add(status);
            retry = new Button(() => lease?.Retry())
            {
                text = "重试"
            };
            retry.style.alignSelf = Align.FlexStart;
            retry.style.marginLeft = 8;
            retry.style.display = DisplayStyle.None;
            Add(retry);
            installRuntime = new Button(() => Application.OpenURL(LocusWebViewNative.RuntimeDownload))
            {
                text = "安装 WebView2"
            };
            installRuntime.style.alignSelf = Align.FlexStart;
            installRuntime.style.marginLeft = 8;
            installRuntime.style.display = DisplayStyle.None;
            Add(installRuntime);
            RegisterCallback<AttachToPanelEvent>(_ => Attach());
            RegisterCallback<DetachFromPanelEvent>(_ => Detach());
            RegisterCallback<GeometryChangedEvent>(_ => Sync());
            RegisterCallback<KeyDownEvent>(e =>
            {
                if (e.keyCode == KeyCode.Tab && !leavingFocus)
                {
                    lease?.Focus(e.shiftKey);
                    e.StopPropagation();
                    e.PreventDefault();
                }
            });
            RegisterCallback<FocusInEvent>(_ =>
            {
                if (!leavingFocus)
                    lease?.Focus();
            });
        }

        void Attach()
        {
            if (disposed || lease != null)
                return;
            if (owner == null)
            {
                foreach (var window in Resources.FindObjectsOfTypeAll<EditorWindow>())
                    if (window.rootVisualElement.Contains(this))
                    {
                        owner = window;
                        break;
                    }
            }

            if (owner == null)
                throw new InvalidOperationException("Cannot resolve the Inspector owning this View element.");
            lease = new LocusWebViewLease(owner, key, connection, context);
            lease.FocusLeaving += MoveFocus;
            lease.ScrollLeaving += Scroll;
            tick = schedule.Execute(Sync).Every(32);
            owner.Repaint();
        }

        void Detach()
        {
            tick?.Pause();
            tick = null;
            if (lease != null)
            {
                lease.FocusLeaving -= MoveFocus;
                lease.ScrollLeaving -= Scroll;
                lease.Dispose();
                lease = null;
            }
        }

        void MoveFocus(bool backwards)
        {
            leavingFocus = true;
            try
            {
                Focus();
                using (var e = KeyDownEvent.GetPooled('\t', KeyCode.Tab, backwards ? EventModifiers.Shift : EventModifiers.None))
                {
                    SendEvent(e);
                }
            }
            finally
            {
                leavingFocus = false;
            }
        }

        void Scroll(Vector2 delta, Vector2 point)
        {
            var systemEvent = new Event
            {
                type = EventType.ScrollWheel,
                delta = delta / 30f,
                mousePosition = worldBound.position + point
            };
            using (var e = WheelEvent.GetPooled(systemEvent))
            {
                SendEvent(e);
            }
        }

        void Sync()
        {
            if (lease == null || disposed || panel == null)
                return;
            // A restored slot is already alive. Initial GeometryChanged events
            // precede the IMGUI screen anchor; they must not release its Vue.
            if (!originValid)
                return;
            if (!LocusWebViewNative.Finite(worldBound) || worldBound.width < 1 || worldBound.height < 1)
            {
                if (laidOut)
                    lease.Hide();
                return;
            }

            Rect full = worldBound, clip = full;
            bool visible = resolvedStyle.display != DisplayStyle.None && resolvedStyle.visibility == Visibility.Visible && originValid;
            if (WorldClip?.GetValue(this, null)is Rect computedClip)
                clip = LocusWebViewNative.Intersect(clip, computedClip);
            if (ClipProvider != null)
                clip = LocusWebViewNative.Intersect(clip, ClipProvider());
            for (VisualElement p = this; p != null; p = p.parent)
            {
                if (p.resolvedStyle.display == DisplayStyle.None || p.resolvedStyle.visibility != Visibility.Visible)
                    visible = false;
                if (p is ScrollView scroll)
                    clip = LocusWebViewNative.Intersect(clip, scroll.contentViewport.worldBound);
                if (p.style.overflow.value == Overflow.Hidden)
                    clip = LocusWebViewNative.Intersect(clip, p.worldBound);
            }

            clip = LocusWebViewNative.Intersect(clip, owner.rootVisualElement.worldBound);
            if (visible && clip.width > 1 && clip.height > 1)
                laidOut = true;
            else if (!laidOut)
                return;
            full.position += origin;
            clip.position += origin;
            lease.SetLayout(full, clip, visible, pixelsPerPoint);
            status.text = lease.Error ?? (lease.Ready ? "" : lease.WaitingForCapacity ? "关闭其他 View 后继续" : "正在打开 View…");
            status.style.display = lease.Ready ? DisplayStyle.None : DisplayStyle.Flex;
            retry.style.display = string.IsNullOrEmpty(lease.Error) ? DisplayStyle.None : DisplayStyle.Flex;
            installRuntime.style.display = lease.Error?.Contains("WebView2 Runtime unavailable") == true ? DisplayStyle.Flex : DisplayStyle.None;
        }

        public void SetContext(LocusViewContext value)
        {
            context = value ?? new LocusViewContext();
            lease?.SetContext(context);
        }

        public void SetConnection(LocusViewConnection value)
        {
            connection = value;
            lease?.SetConnection(value);
        }

        /// <summary>Hide while the owner displays an overlapping Unity overlay.</summary>
        public void SetOverlayVisible(bool value)
        {
            if (value)
            {
                tick?.Pause();
                lease?.SetOccluded(true);
            }
            else
            {
                lease?.SetOccluded(false);
                tick?.Resume();
                Sync();
            }
        }

        public void Dispose()
        {
            if (disposed)
                return;
            disposed = true;
            Detach();
        }
    }
}
