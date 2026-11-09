# Locus Unity 服务端 Linux 版：移植说明

基于 `Locus/`（commit `4ee37ed0`，src-tauri `0.9.3`）。目标：在 **Linux 版 Unity Editor**（本机 2022.3.62f3，Mono 运行时）里运行
`locus_unity_native` broker，并让 Unity 项目通过标准包安装方式接入 Locus。

## 已完成（本轮）

| 项 | 状态 | 说明 |
|---|---|---|
| 父仓库 git 忽略 `unity-test/` | 完成 | 工作区当前**不是** git 仓库；已准备好根级 `.gitignore`，`unity-test/Library、Temp、Obj、Logs、UserSettings…` 全部忽略，另附 Unity 标准模板条目 |
| Rust 工具链 | 完成 | `/home` 只读、rustup 默认目录不可用 → 装到工作区 `.tooling/`（`CARGO_HOME=.tooling/cargo`、`RUSTUP_HOME=.tooling/rustup`），cargo 1.99.1 / rustc 1.99.1 |
| Unity Editor | 确认 | `/home/kidelee/Unity/Hub/Editor/2022.3.62f3/Editor/Unity`（ELF x64，Mono） |
| Unity 参考程序集编译链 | 验证 | 用 Unity 自带 csc 引用的 `unity-4.8-api` + `Facades` 能编译 Locus 的 C# 插件；即使 `Assets/` 为空，`UnityEditor.dll`（约 2.7 万类型）在非 Unity 进程中反射也**无需初始化**、属性读取不报错 |
| Unity Mono 运行时 | 验证 | `MonoBleedingEdge/bin/mono` 下：`Type.GetType("Mono.Runtime")` 非空；`DllImport("libc", EntryPoint="system")` 调用成功（返回值 0，`errno=2` 来自构建环境的 `ECHILD`，不影响） |
| Unity 自带 Roslyn | 验证 | `Microsoft.CodeAnalysis(.CSharp)`（Mono 附带版）+ `System.Collections.Immutable / Memory / Reflection.Metadata / Runtime.CompilerServices.Unsafe / Numerics.Vectors / Threading.Tasks.Extensions` 在 Unity Mono 下 `CSharpCompilation.Emit` **成功**（`ok=True, bytes=2048`）。Unity 自身 `Editor/Data/Tools/csc` 使用的正是这套 |

**结论**：原版 Locus Unity 插件（Roslyn 在进程内编译 snippet）在 Linux Mono 上**可以工作**，不必砍掉 `execute_code`；真正缺的只有 Win32 部分。

## Windows-only 清单（移植范围）

| 位置 | 内容 | Linux 方案 |
|---|---|---|
| `crates/locus-native-broker` | `broker/server/outbox/state_plane/pipe_security/hang_stack` 全部 `#[cfg(windows)]`；tokio `windows::named_pipe` | 新增 Unix 后端：`tokio::net::UnixListener`（socket 路径取管道名的 32 位项目 key → `$XDG_RUNTIME_DIR/locus/locus_unity_native_<key>.sock`），per-connection 任务 + 出站队列；POSIX `shm_open` + mmap 写状态面（布局复用 `locus-native-protocol/src/state_plane.rs`）；控制通道 `system` 改为 `dlsym(RTLD_DEFAULT/Unity 自身 handle)`；hang 栈可选 `libunwind`/`pthread_getattr_np` |
| `locus_unity_native/src/lib.rs` | `#![cfg(windows)]`、`GetModuleHandleW/GetProcAddress`、WebView2、GPU、bg-hook 代码补丁 | dlopen 自身取符号；Mono 解析改用 `dlopen("libmonobdwgc-2.0.so")` + `dlsym`（Unity Linux 的 `MonoEmbedRuntime/libmonobdwgc-2.0.so`）；overlay/webview 保留空实现 |
| C# `LocusBridge.Native.cs` | `[DllImport("locus_unity_native")]`；`Library/Locus/NativeBridge.enabled`；Linux 上 Unity 会把 `NamedMutex` 等映射到 `Library/` 下文件 | `DllImport` 加 `#if UNITY_STANDALONE_LINUX` 名称 `locus_unity_native`（解析到 `liblocus_unity_native.so`）；marker 追加绝对 **socket 路径** 一行；`lock/` 目录下 fd 级 `flock`，避免 stale 锁 |
| 安装包 | `locus_unity/Editor/Native/x86_64/locus_unity_native.dll` | `locus_unity/Editor/Native/linux-x86_64/liblocus_unity_native.so`；`Microsoft.CodeAnalysis*.dll` 及其 Mono 依赖随包附带（Unity 包不引用 Mono 安装目录外的 DLL，必须随包分发） |

## 下一步

1. 移植 broker 的 Unix 后端（保持 `locus-native-protocol` 的帧格式与错误码不变，DST/客户端零改动）。
2. 构建 `liblocus_unity_native.so`，放入 `locus_unity/Editor/Native/linux-x86_64/`，并把 Locus 包（`locus_unity`）以 `file:` 依赖写进 `unity-test/Packages/manifest.json`。
3. 初次打开编辑器时 Unity 会重编译所有程序集（含 Roslyn 辅助程序集），然后端到端冒烟：`unity_status` → `unity_execute` → `unity_console_log` → `unity_asset` → `unity_scene` → `unity_recompile`，用 `scripts/live-smoke.mjs` 跑。
