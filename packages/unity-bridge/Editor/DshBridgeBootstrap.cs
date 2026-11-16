using System;
using System.Collections.Generic;

using UnityEditor;
using UnityEngine;

namespace DshBridge
{
    /// <summary>
    /// Registers this package's bridge extension messages once per editor
    /// domain, on load and after every domain reload.
    ///
    /// Each feature area (hot reload, health) owns a
    /// <c>IEditorMessageSource</c>; this type only fans registration out to the
    /// Locus bridge, so a feature can be deleted without touching the others.
    /// </summary>
    [InitializeOnLoad]
    internal static class DshBridgeBootstrap
    {
        private static readonly List<IEditorMessageSource> Sources = new List<IEditorMessageSource>();

        static DshBridgeBootstrap()
        {
            EditorApplication.delayCall += RegisterAll;
        }

        /// <summary>One extension message this package answers.</summary>
        internal sealed class MessageHandler
        {
            public string MessageType;
            public Func<string, System.Threading.Tasks.Task<string>> Handler;
        }

        internal interface IEditorMessageSource
        {
            IEnumerable<MessageHandler> Messages();
            void OnDomainLoaded();
        }

        /// <summary>Called by a feature area's static constructor/inspector method.</summary>
        internal static void AddSource(IEditorMessageSource source)
        {
            if (source == null || Sources.Contains(source))
                return;
            Sources.Add(source);
            // Register immediately when the editor is already up (a feature
            // that loads later in the same domain must not wait a delayCall).
            RegisterSource(source);
        }

        private static void RegisterAll()
        {
            foreach (IEditorMessageSource source in Sources)
                RegisterSource(source);
        }

        private static void RegisterSource(IEditorMessageSource source)
        {
            try
            {
                source.OnDomainLoaded();
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }

            foreach (MessageHandler message in source.Messages())
            {
                if (message?.Handler == null || string.IsNullOrEmpty(message.MessageType))
                    continue;
                // The companion package references Locus.Editor directly (the
                // plugin declares the payload version it targets), so the bridge
                // is a compile-time dependency here rather than a reflection
                // probe: a payload that lacks this entry point fails the build
                // instead of silently going inert at runtime.
                Locus.LocusBridge.RegisterExtensionMessageHandler(message.MessageType, message.Handler);
            }
        }
    }
}