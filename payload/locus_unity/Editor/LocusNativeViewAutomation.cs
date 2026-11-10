using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace Locus
{
    /// <summary>Agent/test access to the existing View automation API. No raw
    /// browser debugger port is opened by this transport.</summary>
    public static class LocusNativeViewAutomation
    {
        [Serializable]
        sealed class Request
        {
            public string type = "automation", requestId, kind, payloadJson;
            public int id;
        }

        [Serializable]
        sealed class Reply
        {
            public string type, requestId, resultJson, message;
            public bool ok;
        }

        sealed class Pending
        {
            public TaskCompletionSource<string> completion;
            public double deadline;
        }

        static readonly Dictionary<string, Pending> pending = new Dictionary<string, Pending>();
        static LocusNativeViewAutomation()
        {
            EditorApplication.update += Tick;
            AssemblyReloadEvents.beforeAssemblyReload += Cancel;
            EditorApplication.quitting += Cancel;
        }

        public static Task<string> ExecuteAsync(int nativeId, string kind, string payloadJson = "{}")
        {
            if (pending.Count >= 32)
                throw new InvalidOperationException("Native View automation queue is full");
            var id = Guid.NewGuid().ToString("N");
            var completion = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending.Add(id, new Pending { completion = completion, deadline = EditorApplication.timeSinceStartup + 30 });
            LocusWebViewNative.Send(new Request { id = nativeId, requestId = id, kind = kind, payloadJson = payloadJson });
            return completion.Task;
        }

        internal static void Receive(string json)
        {
            var reply = JsonUtility.FromJson<Reply>(json);
            Pending request;
            if (reply.type != "automation-result" || reply.requestId == null || !pending.TryGetValue(reply.requestId, out request))
                return;
            pending.Remove(reply.requestId);
            if (reply.ok)
                request.completion.TrySetResult(reply.resultJson);
            else
                request.completion.TrySetException(new InvalidOperationException(reply.message));
        }

        static void Tick()
        {
            double now = EditorApplication.timeSinceStartup;
            foreach (var entry in new List<KeyValuePair<string, Pending>>(pending))
                if (now > entry.Value.deadline)
                {
                    pending.Remove(entry.Key);
                    entry.Value.completion.TrySetException(new TimeoutException("Native View automation timed out"));
                }
        }

        static void Cancel()
        {
            foreach (var request in pending.Values)
                request.completion.TrySetCanceled();
            pending.Clear();
        }

        public static string Diagnostics()
        {
            return LocusWebViewService.Diagnostics();
        }

        public static string BindingDiagnostics()
        {
            return LocusWebViewService.ManagedDiagnostics();
        }
    }
}
