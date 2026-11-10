using System;
using UnityEditor;
using UnityEngine;

namespace Locus
{
    /// <summary>IMGUI adapter. Call Draw on every OnGUI and Dispose in OnDisable.
    /// screenClip must include the caller's complete nested scroll/clip stack.</summary>
    public sealed class LocusWebViewGUI : IDisposable
    {
        public LocusWebViewLease Lease { get; private set; }

        readonly EditorWindow owner;
        readonly int keyboardHint;
        bool leavingFocus;
        bool leaveBackwards;
        public event Action<bool> FocusLeaving;
        public LocusWebViewGUI(EditorWindow owner, string controlKey, LocusViewConnection connection, LocusViewContext context = null)
        {
            this.owner = owner;
            keyboardHint = controlKey.GetHashCode();
            Lease = new LocusWebViewLease(owner, controlKey, connection, context);
            Lease.FocusLeaving += direction =>
            {
                leavingFocus = true;
                leaveBackwards = direction;
                owner.SendEvent(Event.KeyboardEvent(direction ? "#tab" : "tab"));
            };
            Lease.ScrollLeaving += (delta, point) => owner.SendEvent(new Event { type = EventType.ScrollWheel, delta = delta / 30f, mousePosition = Lease.Full.position - owner.position.position + point });
        }

        public void Draw(Rect rect, Rect screenClip, bool visible = true)
        {
            if (Lease == null)
                return;
            int control = GUIUtility.GetControlID(keyboardHint, FocusType.Keyboard, rect);
            if (leavingFocus && Event.current.type == EventType.KeyDown)
            {
                leavingFocus = false;
                GUIUtility.keyboardControl = control;
                FocusLeaving?.Invoke(leaveBackwards);
            }
            else if (Event.current.type == EventType.KeyDown && Event.current.keyCode == KeyCode.Tab && GUIUtility.keyboardControl == control)
            {
                Lease.Focus(Event.current.shift);
                Event.current.Use();
            }

            if (Event.current.type == EventType.Repaint)
                Lease.SetLayout(new Rect(GUIUtility.GUIToScreenPoint(rect.position), rect.size), screenClip, visible);
            if (!string.IsNullOrEmpty(Lease.Error))
            {
                EditorGUI.HelpBox(new Rect(rect.x, rect.y, rect.width, Math.Min(64, rect.height)), Lease.Error, MessageType.Warning);
                if (GUI.Button(new Rect(rect.x + 6, rect.y + 68, 70, 22), "重试"))
                    Lease.Retry();
                if (Lease.Error.Contains("WebView2 Runtime unavailable") && GUI.Button(new Rect(rect.x + 82, rect.y + 68, 130, 22), "安装 WebView2"))
                    Application.OpenURL(LocusWebViewNative.RuntimeDownload);
            }
            else if (!Lease.Ready)
                EditorGUI.LabelField(rect, Lease.WaitingForCapacity ? "关闭其他 View 后继续" : "正在打开 View…");
        }

        public void Hide()
        {
            Lease?.Hide();
        }

        public void SetContext(LocusViewContext context)
        {
            Lease?.SetContext(context);
        }

        public void Focus(bool backwards = false)
        {
            Lease?.Focus(backwards);
        }

        public void Dispose()
        {
            Lease?.Dispose();
            Lease = null;
        }
    }
}
