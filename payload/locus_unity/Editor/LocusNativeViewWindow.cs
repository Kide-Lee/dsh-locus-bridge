using System;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;

namespace Locus
{
    public sealed class LocusNativeViewWindow : EditorWindow
    {
        [SerializeField]
        string connectionJson;
        LocusWebViewElement view;
        public static string OpenFromJson(string json)
        {
            var connection = LocusViewConnection.FromJson(json);
            LocusViewConnection.Remember(connection);
            LocusWebViewService.UseConnection(connection);
            LocusNativeViewWindow matched = null;
            foreach (var existing in Resources.FindObjectsOfTypeAll<LocusNativeViewWindow>())
            {
                if (string.IsNullOrEmpty(existing.connectionJson))
                    continue;
                var current = LocusViewConnection.FromJson(existing.connectionJson);
                current.url = connection.url;
                current.instanceId = connection.instanceId;
                existing.connectionJson = JsonUtility.ToJson(current);
                existing.view?.SetConnection(current);
                if (current.viewId == connection.viewId)
                {
                    existing.connectionJson = json;
                    existing.view?.SetConnection(connection);
                    existing.titleContent = new GUIContent(connection.title);
                    matched = existing;
                }
            }

            if (matched != null)
            {
                matched.Show();
                matched.Focus();
                return "reused";
            }

            var window = CreateInstance<LocusNativeViewWindow>();
            window.connectionJson = json;
            window.titleContent = new GUIContent(connection.title);
            window.minSize = new Vector2(240, 180);
            window.Show();
            if (window.view == null)
                window.CreateGUI();
            window.Focus();
            return "opened";
        }

        void OnEnable()
        {
            Selection.selectionChanged += SelectionChanged;
        }

        public void CreateGUI()
        {
            if (string.IsNullOrEmpty(connectionJson))
                return;
            view?.Dispose();
            rootVisualElement.Clear();
            view = new LocusWebViewElement(this, "view", LocusViewConnection.FromJson(connectionJson), LocusViewContext.FromObjects(Selection.objects));
            rootVisualElement.Add(view);
        }

        void SelectionChanged()
        {
            view?.SetContext(LocusViewContext.FromObjects(Selection.objects));
        }

        void OnDisable()
        {
            Selection.selectionChanged -= SelectionChanged;
            view?.Dispose();
            view = null;
        }
    }
}
