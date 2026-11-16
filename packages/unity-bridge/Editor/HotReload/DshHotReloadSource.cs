using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading.Tasks;

using UnityEditor;
using UnityEngine;

namespace DshBridge.HotReload
{
    /// <summary>
    /// 本包的热重载消息源：向 Locus 桥注册四个 <c>dsh_hot_reload_*</c> 扩展消息。
    ///
    /// 协议（docs/internal/contracts.md §2.1）：
    ///   dsh_hot_reload_classify → 只做分类，不动程序集；
    ///   dsh_hot_reload_apply    → 加载补丁程序集并挂自己的 detour；
    ///   dsh_hot_reload_status   → 报告自己的 detour 台账；
    ///   dsh_hot_reload_dispose  → 摘掉 detour（按补丁或全部）。
    ///
    /// 扩展消息的派发点（payload 的 LocusBridge.HandleExtensionMessageAsync）会先
    /// <c>SwitchToMainThread()</c> 再调用 handler，所以这里不需要自己投递主线程。
    /// 分类与 detour 仍然都在主线程上跑，写 detour 台账的那把锁只是防止 detour 回调
    /// 期间的重入。
    /// </summary>
    internal sealed class DshHotReloadSource : DshBridgeBootstrap.IEditorMessageSource
    {
        internal const string ClassifyMessage = "dsh_hot_reload_classify";
        internal const string ApplyMessage = "dsh_hot_reload_apply";
        internal const string StatusMessage = "dsh_hot_reload_status";
        internal const string DisposeMessage = "dsh_hot_reload_dispose";

        private static DshHotReloadSource _instance;

        /// <summary>
        /// 注册入口。由域重载后的 delayCall 或任何早期调用触发；重复调用无副作用
        /// （AddSource 去重），因此可以安全地挂在编辑器初始化回调上。
        /// </summary>
        [InitializeOnLoadMethod]
        internal static void Install()
        {
            if (_instance == null)
                _instance = new DshHotReloadSource();
            DshBridgeBootstrap.AddSource(_instance);
        }

        public IEnumerable<DshBridgeBootstrap.MessageHandler> Messages()
        {
            // 每个 handler 都自己把异常翻译成 {"error":…} 的 JSON：扩展消息层会把
            // 抛出的异常变成裸文本拒绝，工具层就分不清「分类失败」与「补丁失败」。
            return new[]
            {
                new DshBridgeBootstrap.MessageHandler { MessageType = ClassifyMessage, Handler = HandleClassify },
                new DshBridgeBootstrap.MessageHandler { MessageType = ApplyMessage, Handler = HandleApply },
                new DshBridgeBootstrap.MessageHandler { MessageType = StatusMessage, Handler = HandleStatus },
                new DshBridgeBootstrap.MessageHandler { MessageType = DisposeMessage, Handler = HandleDispose },
            };
        }

        public void OnDomainLoaded()
        {
            // 域重载之后所有 detour 都随旧域的 JIT 代码一起消失，台账里只剩下
            // 失效的句柄——必须清空，否则 status 会报告早已不存在的补丁。
            DshHotReloadRegistry.OnDomainLoaded();
        }

        private static Task<string> HandleClassify(string requestJson)
        {
            try
            {
                HotReloadDtos.ClassifyRequest request = HotReloadDtos.Parse<HotReloadDtos.ClassifyRequest>(requestJson);
                string[] paths = request != null ? request.paths : null;
                if (paths == null || paths.Length == 0)
                    return Task.FromResult(HotReloadDtos.Error("classify request has no paths"));

                HotReloadDtos.ClassifyResponse response = new HotReloadDtos.ClassifyResponse();
                List<DshHotReloadClassifier.FileResult> results = DshHotReloadClassifier.Classify(paths);
                List<HotReloadDtos.HotMethod> hot = new List<HotReloadDtos.HotMethod>();
                List<HotReloadDtos.CompileReason> needCompile = new List<HotReloadDtos.CompileReason>();
                List<HotReloadDtos.FailedPath> failed = new List<HotReloadDtos.FailedPath>();

                foreach (DshHotReloadClassifier.FileResult file in results)
                {
                    switch (file.State)
                    {
                        case DshHotReloadClassifier.FileState.Hot:
                            List<HotReloadDtos.HotMethod> methods = file.Methods ?? new List<HotReloadDtos.HotMethod>();
                            if (methods.Count > 0)
                                hot.AddRange(methods);
                            break;
                        case DshHotReloadClassifier.FileState.NeedCompile:
                            needCompile.Add(new HotReloadDtos.CompileReason { path = file.Path, reason = file.Reason });
                            break;
                        default:
                            failed.Add(new HotReloadDtos.FailedPath { path = file.Path, error = file.Reason });
                            break;
                    }
                }

                response.hot = hot.ToArray();
                response.needCompile = needCompile.ToArray();
                response.failed = failed.ToArray();
                // 本实现只做「文件级」分类：补丁程序集由调用方提供，本包不编译。
                response.supported = true;
                response.reason = DshHotReloadClassifier.ClassificationNote;
                return Task.FromResult(HotReloadDtos.ToJson(response));
            }
            catch (Exception ex)
            {
                return Task.FromResult(HotReloadDtos.Error("classify failed: " + ex.Message));
            }
        }

        private static Task<string> HandleApply(string requestJson)
        {
            try
            {
                HotReloadDtos.ApplyRequest request = HotReloadDtos.Parse<HotReloadDtos.ApplyRequest>(requestJson);
                if (request == null)
                    return Task.FromResult(HotReloadDtos.Error("apply request is empty"));

                return Task.FromResult(DshHotReloadRegistry.Apply(request));
            }
            catch (Exception ex)
            {
                return Task.FromResult(HotReloadDtos.Error("apply failed: " + ex.Message));
            }
        }

        private static Task<string> HandleStatus(string requestJson)
        {
            try
            {
                return Task.FromResult(DshHotReloadRegistry.Status());
            }
            catch (Exception ex)
            {
                return Task.FromResult(HotReloadDtos.Error("status failed: " + ex.Message));
            }
        }

        private static Task<string> HandleDispose(string requestJson)
        {
            try
            {
                HotReloadDtos.DisposeRequest request = HotReloadDtos.Parse<HotReloadDtos.DisposeRequest>(requestJson);
                return Task.FromResult(DshHotReloadRegistry.Dispose(request != null ? request.patch_id : null));
            }
            catch (Exception ex)
            {
                return Task.FromResult(HotReloadDtos.Error("dispose failed: " + ex.Message));
            }
        }
    }
}