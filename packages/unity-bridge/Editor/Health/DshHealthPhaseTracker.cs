using System;
using System.Collections.Generic;
using System.Threading.Tasks;

using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace DshBridge.Health
{
    /// <summary>
    /// 编辑器的阶段状态机。
    ///
    /// 原生探针（native/locus_unix_native/src/state_probe）没法从进程外面问出
    /// Unity 正在干什么：它在 reload？在编译？在导入？这些只有编辑器自己知道。
    /// 所以由这里测量、通过 <c>dsh_health_snapshot</c> 上报，原生侧只负责记录并
    /// 打时间戳——过期了就报 stale，而不是拿旧值当现状。
    ///
    /// 阶段名与 docs/internal/contracts.md §4.2 一致。编译与导入各自独立，可能
    /// 同时发生，所以对外同时报 <c>phase</c>（当前最外层的活动）和各布尔位；读
    /// 的人按需取。
    /// </summary>
    internal static class DshHealthPhaseTracker
    {
        /// <summary>对外报告的阶段名。顺序即优先级：越靠前越“压住”后面的。</summary>
        internal const string Compiling = "compiling";
        internal const string Importing = "importing";
        internal const string Reloading = "reloading";
        internal const string Playing = "playing";
        internal const string Paused = "paused";
        internal const string Editing = "editing";

        private static readonly object Gate = new object();

        private static bool _installed;
        private static bool _compiling;
        private static bool _updating;
        private static bool _importing;
        private static bool _reloading;
        private static string _phase = Editing;
        private static long _sinceMs = NowMs();

        /// <summary>当前阶段（调用方须持有 <see cref="Gate"/>）。</summary>
        private static string PhaseLocked()
        {
            // reload 压住一切：旧域的绘制回调已经不可信，报 playing 会误导。
            if (_reloading)
                return Reloading;
            if (_compiling)
                return Compiling;
            if (_importing)
                return Importing;
            if (EditorApplication.isPlaying)
                return EditorApplication.isPaused ? Paused : Playing;
            return Editing;
        }

        internal static void Install()
        {
            lock (Gate)
            {
                if (_installed)
                    return;
                _installed = true;
                _sinceMs = NowMs();
            }

            EditorApplication.update += OnUpdate;
            AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
            AssemblyReloadEvents.afterAssemblyReload += OnAfterAssemblyReload;
            CompilationPipeline.compilationStarted += OnCompilationStarted;
            CompilationPipeline.compilationFinished += OnCompilationFinished;
            // assemblyCompilationFinished 只给“单个程序集编完”，用来标记更新期
            // 已经开始；真正的结束以 compilationFinished 为准（见 DshHealthSource
            // 的 500 ms 宽限，因为 Unity 会在前后顺序上耍花招）。
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
            UnityEditor.EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
            UnityEditor.EditorApplication.pauseStateChanged += OnPauseStateChanged;

            lock (Gate)
                _phase = PhaseLocked();
        }

        internal static void Uninstall()
        {
            lock (Gate)
            {
                if (!_installed)
                    return;
                _installed = false;
            }

            EditorApplication.update -= OnUpdate;
            AssemblyReloadEvents.beforeAssemblyReload -= OnBeforeAssemblyReload;
            AssemblyReloadEvents.afterAssemblyReload -= OnAfterAssemblyReload;
            CompilationPipeline.compilationStarted -= OnCompilationStarted;
            CompilationPipeline.compilationFinished -= OnCompilationFinished;
            CompilationPipeline.assemblyCompilationFinished -= OnAssemblyCompilationFinished;
            UnityEditor.EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            UnityEditor.EditorApplication.pauseStateChanged -= OnPauseStateChanged;
        }

        /// <summary>
        /// 域重载之后重装回调：静态字段本身会随域一起重建，但订阅不会跨域保留，
        /// 而 delayCall 里重装是幂等的。
        /// </summary>
        internal static void OnDomainLoaded()
        {
            lock (Gate)
            {
                // 域重载结束即 reload 结束：这一行原来的“重载”结论必须清掉。
                _reloading = false;
                _installed = false;
            }

            Install();
        }

        // ───────────────────────── 当前快照 ─────────────────────────

        /// <summary>一次上报的载荷，字段与 §4.2 一一对应（snake_case）。</summary>
        internal sealed class Snapshot
        {
            public string phase;
            public long since_ms;
            public bool playing;
            public bool paused;
            public bool compiling;
            public bool updating;
            public bool importing;
        }

        internal static Snapshot Capture()
        {
            lock (Gate)
            {
                string phase = PhaseLocked();
                if (phase != _phase)
                {
                    _phase = phase;
                    _sinceMs = NowMs();
                }

                bool playing = EditorApplication.isPlaying;
                bool paused = playing && EditorApplication.isPaused;
                return new Snapshot
                {
                    phase = _phase,
                    since_ms = _sinceMs,
                    playing = playing,
                    paused = paused,
                    compiling = _compiling,
                    updating = _updating,
                    importing = _importing,
                };
            }
        }

        /// <summary>协议的 snake_case 形状；序列化器自己不管命名。</summary>
        internal static Dictionary<string, object> ToWire(Snapshot snapshot)
        {
            return new Dictionary<string, object>
            {
                { "phase", snapshot.phase },
                { "since_ms", snapshot.since_ms },
                { "playing", snapshot.playing },
                { "paused", snapshot.paused },
                { "compiling", snapshot.compiling },
                { "updating", snapshot.updating },
                { "importing", snapshot.importing },
            };
        }

        internal static long NowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        // ───────────────────────── 事件 ─────────────────────────

        private static void OnUpdate()
        {
            // 导入状态没有公开事件可挂，只能轮询。AssetDatabase 的进度轮询很便宜：
            // 一次属性读取，不触发任何资源操作。
            bool importing = EditorApplication.isUpdating;
            lock (Gate)
            {
                _updating = importing;
                _importing = importing;
            }
        }

        private static void OnCompilationStarted(object context)
        {
            lock (Gate)
            {
                _compiling = true;
                _updating = false;
            }
        }

        private static void OnAssemblyCompilationFinished(string assembly, CompilerMessage[] messages)
        {
            // 程序集编完到 compilationFinished 之间 editor 什么也不能干，这段时间
            // 归到“更新”里，读的人才知道不是在跑用户代码。
            lock (Gate)
                _updating = true;
        }

        private static void OnCompilationFinished(object context)
        {
            lock (Gate)
            {
                _compiling = false;
                _updating = true;
            }
        }

        private static void OnBeforeAssemblyReload()
        {
            lock (Gate)
            {
                _reloading = true;
                _compiling = false;
                _updating = false;
            }
        }

        private static void OnAfterAssemblyReload()
        {
            lock (Gate)
                _reloading = false;
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange change)
        {
            // 只要让 Capture() 重算即可：playing/paused 直接读 EditorApplication。
        }

        private static void OnPauseStateChanged(PauseState state)
        {
            // 同上：不缓存，避免与编辑器实际状态脱节。
        }
    }
}