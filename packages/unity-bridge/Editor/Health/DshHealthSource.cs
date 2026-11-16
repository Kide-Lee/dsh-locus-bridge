using System;
using System.Collections.Generic;
using System.Threading.Tasks;

using UnityEditor;
using UnityEngine;

namespace DshBridge.Health
{
    /// <summary>
    /// 本包的健康消息源：向 Locus 桥注册
    /// <c>dsh_health_snapshot</c> 与 <c>dsh_health_subscribe</c>（contracts.md §4.2）。
    ///
    /// 为什么这两个消息值得单独存在：原生 broker 能回答“进程还活着吗 / 主线程还
    /// 有心跳吗”，但回答不了“它到底在干什么”——reload、编译、导入、进 playmode
    /// 这些事情只有编辑器自己知道。这里的每一次上报都是**直接观测**，不是推测；
    /// 观测不到就报 unknown，绝不根据“上次看到的是 playing”去猜现状。
    ///
    /// 扩展消息的派发点（payload 的 LocusBridge.HandleExtensionMessageAsync）会先
    /// <c>SwitchToMainThread()</c> 再调用 handler，所以这里不需要自己投递主线程。
    ///
    /// 订阅是显式的：没人订阅时一个字节都不推，编辑器空闲时不会因为在跑 DSH 而
    /// 多出每秒一次的消息。
    /// </summary>
    internal sealed class DshHealthSource : DshBridgeBootstrap.IEditorMessageSource
    {
        internal const string SnapshotMessage = "dsh_health_snapshot";
        internal const string SubscribeMessage = "dsh_health_subscribe";

        /// <summary>
        /// 订阅期间推送的事件类型。与上面两条“请求消息”区分开：它们走的是两个
        /// 不同的通道（请求由扩展消息层按类型查表，事件由这里主动 emit）。
        /// </summary>
        internal const string SnapshotEvent = "dsh-health-snapshot";

        /// <summary>
        /// 订阅期间的上报间隔。1 s 与原生侧的心跳/CPU 采样节奏一致：更密没有新
        /// 信息，更疏会让“卡住”判定变钝。
        /// </summary>
        internal const double PushIntervalSeconds = 1.0;

        private static DshHealthSource _instance;

        private static bool _subscribed;
        private static double _nextPushAt = 0;

        [InitializeOnLoadMethod]
        internal static void Install()
        {
            if (_instance == null)
                _instance = new DshHealthSource();
            DshBridgeBootstrap.AddSource(_instance);
        }

        public IEnumerable<DshBridgeBootstrap.MessageHandler> Messages()
        {
            return new[]
            {
                new DshBridgeBootstrap.MessageHandler { MessageType = SnapshotMessage, Handler = HandleSnapshot },
                new DshBridgeBootstrap.MessageHandler { MessageType = SubscribeMessage, Handler = HandleSubscribe },
            };
        }

        public void OnDomainLoaded()
        {
            // 订阅状态属于旧的域：域重载后客户端必须重新订阅，否则我们会推给
            // 一个早已不存在的桥。阶段追踪器也要重装回调。
            _subscribed = false;
            _nextPushAt = 0;
            DshHealthPhaseTracker.OnDomainLoaded();
            EditorApplication.update -= OnUpdate;
            EditorApplication.update += OnUpdate;
        }

        /// <summary>当前阶段上报的 JSON 文本（snake_case，§4.2）。</summary>
        internal static string SnapshotJson()
        {
            DshHealthPhaseTracker.Snapshot snapshot = DshHealthPhaseTracker.Capture();
            return HealthJson.ToJson(DshHealthPhaseTracker.ToWire(snapshot));
        }

        private static Task<string> HandleSnapshot(string requestJson)
        {
            try
            {
                return Task.FromResult(SnapshotJson());
            }
            catch (Exception ex)
            {
                // 阶段采集失败要说清是“采集不了”，而不是给一个空阶段让人误读成 idle。
                return Task.FromResult(HealthJson.Error("health snapshot failed: " + ex.Message));
            }
        }

        private static Task<string> HandleSubscribe(string requestJson)
        {
            try
            {
                bool? enabled = HealthJson.ParseEnabled(requestJson);
                if (enabled == null)
                    return Task.FromResult(HealthJson.Error("dsh_health_subscribe expects {\"enabled\":true|false}"));

                _subscribed = enabled.Value;
                _nextPushAt = 0;
                if (!_subscribed)
                {
                    // 退订即刻生效，一次多余的推送都不发。
                    return Task.FromResult("{\"subscribed\":false}");
                }

                return Task.FromResult("{\"subscribed\":true}");
            }
            catch (Exception ex)
            {
                return Task.FromResult(HealthJson.Error("subscribe failed: " + ex.Message));
            }
        }

        private static void OnUpdate()
        {
            if (!_subscribed)
                return;

            double now = EditorApplication.timeSinceStartup;
            if (now < _nextPushAt)
                return;
            _nextPushAt = now + PushIntervalSeconds;

            try
            {
                // The bridge is a compile-time dependency of this package;
                // SendEventToRust is its public event channel. The subscription
                // only exists while a client is connected, so there is no
                // "nobody is listening" case to gate here.
                Locus.LocusBridge.SendEventToRust(SnapshotEvent, SnapshotJson());
            }
            catch (Exception ex)
            {
                // 推送失败只记一次警告：反正下一拍还会再试，且阶段本身没坏。
                Debug.LogWarning("[dsh-bridge] pushing health snapshot failed: " + ex.Message);
            }
        }

        /// <summary>供测试与诊断：当前是否在推送。</summary>
        internal static bool Subscribed
        {
            get { return _subscribed; }
        }

        /// <summary>供测试：把内部状态复位。</summary>
        internal static void ResetForTests()
        {
            _subscribed = false;
            _nextPushAt = 0;
        }
    }
}