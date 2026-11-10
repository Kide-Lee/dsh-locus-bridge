using System;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace Locus
{
    internal static class LocusEditorScheduling
    {
        private static readonly MethodInfo RefreshMethod = typeof(EditorApplication).GetMethod(
            "UpdateInteractionModeSettings", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic,
            null, Type.EmptyTypes, null);
        private static bool _warned;

        // Main thread only. Unity caches its inactive 10 Hz rate separately from
        // IsApplicationActive. Changing the hook alone leaves that cache stale.
        // Recompute from the existing interaction preferences; never change them.
        internal static bool RefreshInteractionMode()
        {
            try
            {
                if (RefreshMethod == null)
                    throw new MissingMethodException("EditorApplication.UpdateInteractionModeSettings");
                RefreshMethod.Invoke(null, null);
                return true;
            }
            catch (Exception exception)
            {
                if (!_warned)
                {
                    _warned = true;
                    Debug.LogWarning("[Locus] Could not refresh editor scheduling after background hook change: "
                        + (exception.InnerException ?? exception).Message);
                }
                return false;
            }
        }
    }
}
