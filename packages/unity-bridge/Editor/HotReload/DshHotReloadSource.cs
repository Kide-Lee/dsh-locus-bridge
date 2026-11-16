using System;
using System.IO;
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
        internal const string CompiledTextMessage = "dsh_hot_reload_compiled_text";

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
                new DshBridgeBootstrap.MessageHandler { MessageType = CompiledTextMessage, Handler = HandleCompiledText },
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

        /// <summary>
        /// 读一个脚本“当前域编译时用到的源码”。
        ///
        /// 热补丁要做的差分是「域里的代码」→「磁盘上的文本」。编辑器自己不会保留
        /// 旧源码，但 `AssetPostprocessor.GetPostprocessOrder` 之类的钩子也不可靠，
        /// 所以这里只在**文本资产**上回答问题：从 `AssetDatabase` 取到脚本文件实例
        /// （不是 `.asset`、不是二进制），读出它的文本。读不到时如实报错，让调用方
        /// 退回「跳过这次热补丁、要求重编译」，而不是拿磁盘文本冒充旧版本把文件补丁
        /// 到它自身。
        /// </summary>
        private static Task<string> HandleCompiledText(string requestJson)
        {
            try
            {
                HotReloadDtos.CompiledTextRequest request = HotReloadDtos.Parse<HotReloadDtos.CompiledTextRequest>(requestJson);
                string path = request != null ? request.path : null;
                if (string.IsNullOrEmpty(path))
                    return Task.FromResult(HotReloadDtos.Error("dsh_hot_reload_compiled_text expects a \"path\""));
                if (!path.StartsWith("Assets/", StringComparison.Ordinal) && !path.StartsWith("Packages/", StringComparison.Ordinal))
                    return Task.FromResult(HotReloadDtos.Error("the compiled text of " + path + " is only available for Assets/ or Packages/ paths"));
                string absolute = Path.Combine(Directory.GetCurrentDirectory(), path);
                if (!File.Exists(absolute))
                    return Task.FromResult(HotReloadDtos.Error("the Editor has no compiled text for " + path + ": the file is gone"));
                // The disk file is NOT the compiled text: the domain was compiled
                // from whatever the file said last reload, and reading the current
                // file would make the diff empty by construction. What the editor
                // actually has is the last text this package saw while the domain
                // was live -- recorded by the classifier, which is the only code
                // that reads the file on the editor's side.
                //
                // 本域第一次被问到时还没有任何调用读过它：先拿磁盘文本作为「本域
                // 起始文本」记下来，再按正常路径回答。这是诚实的一步——域刚编译完，
                // 磁盘上的内容就是它编译的内容（同一份文件、同一个域）。真正想要
                // 「编辑后未重编译」的差分，靠的是之后每次分类把磁盘文本记成新基线；
                // 编辑发生在基线之后时，差分才非空（见 src/hotreload.js 的
                // asRevisionPair）。
                //
                // 但磁盘文本只有「本域刚编译过、之后没人再改过」时才算数：一次未重编译
                // 的编辑之后，磁盘已经不是域里的代码了。所以这里自带一条保守规则——
                // 磁盘文本与上次记录不同，就报 imported：「文件变了但域没重载」，这是
                // 真实的热补丁窗口，而不是可以当成旧版本回答的东西。之后分类会重新
                // 记录基线，本次编辑自然退回重编译，下一次编辑才可能被补丁。
                string text = DshHotReloadRegistry.CompiledText(path);
                if (text == null)
                {
                    text = File.ReadAllText(absolute);
                    DshHotReloadRegistry.RecordCompiledText(path, text);
                }
                else if (!string.Equals(text, File.ReadAllText(absolute), StringComparison.Ordinal))
                {
                    return Task.FromResult(HotReloadDtos.Error(
                        "the Editor has no recorded compiled text for " + path + ": the file changed but the domain has not been reloaded since"));
                }
                return Task.FromResult(HotReloadDtos.ToJson(new HotReloadDtos.CompiledTextResponse { path = path, text = text }));
            }
            catch (Exception ex)
            {
                return Task.FromResult(HotReloadDtos.Error("compiled text failed: " + ex.Message));
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