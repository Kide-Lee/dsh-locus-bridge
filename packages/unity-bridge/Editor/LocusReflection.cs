using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;

using UnityEngine;

namespace DshBridge
{
    /// <summary>
    /// Reflection bridge to the Locus Unity package that ships in this
    /// repository's payload.
    ///
    /// Why reflection instead of a project reference: this package is
    /// installed beside <c>Packages/com.farlocus.locus</c>, whose assembly
    /// (<c>Locus.Editor</c>) is <c>autoReferenced: false</c>. Referencing it
    /// directly would also pin this package to one payload build; the three
    /// members used here are stable and documented in
    /// <c>docs/internal/contracts.md</c>, so a missing member degrades to a
    /// reported error instead of a compile failure the user cannot act on.
    /// </summary>
    internal static class LocusReflection
    {
        private const string BridgeTypeName = "Locus.LocusBridge, Locus.Editor";

        private static Type _bridgeType;
        private static MethodInfo _registerHandler;
        private static MethodInfo _sendEvent;
        private static MethodInfo _hasConnectedClient;
        private static FieldInfo _isPlaying;
        private static FieldInfo _isPaused;
        private static bool _probed;

        /// <summary>True when the Locus package is installed and its bridge is loadable.</summary>
        internal static bool Available
        {
            get
            {
                Probe();
                return _registerHandler != null;
            }
        }

        internal static string UnavailableReason { get; private set; }

        /// <summary>
        /// Register one bridge extension message. The handler receives the raw
        /// request message and answers the raw response. Returns false (with a
        /// Console warning) when the Locus package is absent.
        /// </summary>
        internal static bool RegisterHandler(string messageType, Func<string, Task<string>> handler)
        {
            Probe();
            if (_registerHandler == null)
            {
                Debug.LogWarning("[dsh-bridge] cannot register " + messageType + ": " + UnavailableReason);
                return false;
            }

            try
            {
                _registerHandler.Invoke(null, new object[] { messageType, handler });
                return true;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[dsh-bridge] registering " + messageType + " failed: " + (ex.InnerException ?? ex).Message);
                return false;
            }
        }

        /// <summary>The editor's own play state, or null when the bridge is absent.</summary>
        internal static bool? EditorIsPlaying()
        {
            Probe();
            return _isPlaying != null ? (bool?)_isPlaying.GetValue(null) : null;
        }

        internal static bool? EditorIsPaused()
        {
            Probe();
            return _isPaused != null ? (bool?)_isPaused.GetValue(null) : null;
        }

        /// <summary>
        /// Push one event to the connected client, if there is one.
        ///
        /// The payload exposes <c>TrySendEventToRust</c> (internal, checks
        /// <c>HasConnectedDesktopClient</c> first) and
        /// <c>SendEventToRust</c> (public, no check). The internal one is
        /// preferred: pushing when nobody listens costs a socket write per
        /// tick for nothing. Returns false when the event was not sent, so a
        /// caller can avoid building the payload twice.
        /// </summary>
        internal static bool EmitEvent(string eventType, string message)
        {
            Probe();
            if (_bridgeType == null)
                return false;

            try
            {
                if (_sendEvent != null)
                {
                    object sent = _sendEvent.Invoke(null, new object[] { eventType, message });
                    return sent is bool ok && ok;
                }

                if (_hasConnectedClient != null && _hasConnectedClient.Invoke(null, null) is bool connected && !connected)
                    return false;

                MethodInfo send = _bridgeType.GetMethod(
                    "SendEventToRust", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string), typeof(string) }, null);
                if (send == null)
                {
                    UnavailableReason = "Locus.LocusBridge.SendEventToRust is missing from this payload build";
                    return false;
                }

                _sendEvent = send;
                send.Invoke(null, new object[] { eventType, message });
                return true;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[dsh-bridge] emitting " + eventType + " failed: " + (ex.InnerException ?? ex).Message);
                return false;
            }
        }

        private static void Probe()
        {
            if (_probed)
                return;
            _probed = true;

            _bridgeType = Type.GetType(BridgeTypeName, throwOnError: false);
            if (_bridgeType == null)
            {
                UnavailableReason = "the Locus bridge type is not loaded; install Packages/com.farlocus.locus first";
                return;
            }

            const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
            _registerHandler = _bridgeType.GetMethod("RegisterExtensionMessageHandler", Flags, null, new[] { typeof(string), typeof(Func<string, Task<string>>) }, null);
            // The payload keeps its play state in private fields (LocusBridge.cs
            // `_isPlaying`); the status line below is the public read of them.
            _isPlaying = _bridgeType.GetField("_isPlaying", Flags);
            _isPaused = _bridgeType.GetField("_isPaused", Flags);
            _sendEvent = _bridgeType.GetMethod("TrySendEventToRust", Flags, null, new[] { typeof(string), typeof(string) }, null);
            _hasConnectedClient = _bridgeType.GetMethod("HasConnectedDesktopClient", Flags, null, Type.EmptyTypes, null);

            if (_registerHandler == null)
                UnavailableReason = "Locus.LocusBridge.RegisterExtensionMessageHandler is missing from this payload build";
        }
    }
}