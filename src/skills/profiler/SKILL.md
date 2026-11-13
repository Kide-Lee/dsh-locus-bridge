---
name: profiler
description: >-
  Profile Unity Editor / Play Mode CPU, GPU, memory, GC, rendering and subsystem metrics. Capture bounded samples, compare baselines, analyze worker call paths by Marker ID with reusable buffers, inspect timelines and save memory snapshots through ctx.Profiler. Not for static code review.
metadata:
  portedFrom: locus
  upstream: Locus/knowledge/skill/profiler.md
---

# Unity Profiler Runtime Sampling

Use for slow frames, stutters, allocations, memory growth, rendering load, simulation cost, or performance before/after an interaction. Prefer state inspection for deterministic logic bugs and static inspection for questions that need no measurements.

## Workflow

1. Reproduce the relevant scene, interaction and load. Prefer representative Play Mode conditions.
2. Discover metrics if their names/categories are uncertain. Capture a small overview first, then narrow to the relevant subsystem.
3. Allow warmup. Collect 120–600 observations or a bounded time window. Keep baseline/candidate conditions and sampling policies comparable.
4. Check availability and missing counts before interpreting statistics. Use frame exports for call attribution and snapshots for memory ownership.
5. Print a short finding with evidence, limitations and saved paths. Save raw samples in CSV and hierarchies in JSON.

Keep sampling and presentation separate. Never read `GetSampleName` for every sample during recording: the strings generate `GC.Alloc` samples in the next frame and can amplify history indefinitely. Match Marker IDs instead. Stop recording before resolving names, building hierarchies, calculating summaries, printing or exporting. Discard measurements already contaminated by a sampler; rerun after warmup for a final baseline.

All helpers are available through **`ctx.Profiler` in both `unity_execute` and `unity_run_states`**. Captures belong to the current call and are cleaned up on success, failure or cancellation. Save before returning. On `unity_execute`, use `readonly: false` when starting captures or writing artifacts; discovery and reading buffered frames can be read-only. `unity_run_states` has no `readonly` switch — declare intent in the state code and keep observation runs free of writes where possible. Standalone/remote Player capture is outside this helper's scope.

## unity_execute

For a bounded observation window, use `request_editor_status: "playing"`:

```csharp
var p = ctx.Profiler;
p.StartProfiler("baseline", p.ProfilerMetrics("overview", "memory"),
    new Locus.LocusBridge.ProfilerCaptureOptions { WarmupFrames = 30, MaxSamples = 300 });
await ctx.WaitSeconds(8);
p.StopProfiler("baseline");
p.PrintProfilerSummary("baseline");
printJson(p.GetProfilerSummary("baseline", "main_thread_ms").Statistics);
printJson(p.GetProfilerBudget("baseline", "main_thread_ms", 16.67));
p.SaveProfiler("baseline");
```

The duration does not promise 300 rendered frames; inspect sample counts. To wait for the sample cap, use `await ctx.WaitUntil(() => p.IsProfilerStopped("baseline"))` while the scene keeps rendering. Stop explicitly if the scenario pauses or finishes earlier.

## unity_run_states

```csharp
// start
ctx.Profiler.StartProfiler("baseline", ctx.Profiler.ProfilerMetrics("overview"),
    new Locus.LocusBridge.ProfilerCaptureOptions { WarmupFrames = 30, MaxSamples = 300 });

// update
if (!ctx.Profiler.IsProfilerStopped("baseline")) return;
ctx.Profiler.PrintProfilerSummary("baseline");
ctx.Profiler.SaveProfiler("baseline");
ctx.Done("profile captured");
```

Sampling continues while a state sleeps. Existing `ctx.StartProfiler`, `StopProfiler`, `PrintProfilerSummary`, `SaveProfiler`, `GetProfilerSummary`, last-value, spike and frame helpers remain supported. Legacy `ctx.StartProfiler` enables hierarchy capture; prefer `ctx.Profiler.StartProfiler` when only counters are needed.

## Metric discovery and domains

```csharp
var p = ctx.Profiler;
var page = p.DiscoverMetrics(nameContains: "Texture", categoryContains: "Memory", limit: 40, offset: 0);
printJson(page);
// Items have Name, Category, Unit, DataType and Flags; paginate using TotalMatches/HasMore.
// Use a discovered item in this call: p.ProfilerMetric(page.Items[0], "texture_metric").
```

Filters are case-insensitive substrings. Limit is 1–512. `ProfilerMetric(info, name, options)` converts nanoseconds to ms and preserves other native units. Explicit definitions use `ProfilerMetric(name, category, markerName, scale, unit, options)`.

`ProfilerMetrics(params string[] groups)` composes these domains:

| Group | Data |
| --- | --- |
| `overview` | CPU threads, allocation, reserved/system memory, rendering and GPU frame time |
| `cpu`, `gpu` | Main/render thread time; GPU frame time where supported |
| `memory` | Used/reserved/managed/system memory, allocation, textures, meshes, graphics memory |
| `rendering` | Draw calls, batches, SetPass, triangles, vertices, render textures |
| `physics`, `physics2d` | Registered metrics in the corresponding physics categories |
| `audio`, `animation`, `ui`, `loading` | Registered subsystem metrics |
| `2d` | Registered 2D/sprite metrics, including those added by newer Unity versions |

The last three rows use runtime discovery. An empty domain or one with more than 64 metrics asks you to narrow discovery instead of silently substituting data. Registration depends on Unity version, packages and whether the subsystem has run. At most 128 metrics and 1,000,000 stored values are allowed per capture.

`GC Allocated In Frame` is the allocation counter for a frame. `GC.Alloc` is useful for allocation attribution; do not assume a marker's duration is a byte count. Verify discovered units before selecting a scale.

For a custom marker and main-thread-only collection:

```csharp
var metric = ctx.Profiler.ProfilerMetric("combat_ms", Unity.Profiling.ProfilerCategory.Scripts,
    "Combat.SpawnWave", 0.000001, "ms", Unity.Profiling.ProfilerRecorderOptions.Default
    | Unity.Profiling.ProfilerRecorderOptions.CollectOnlyOnCurrentThread);
```

Defaults sum samples across threads in a frame. `GpuRecorder` requests GPU timing for an actual GPU-capable marker; it does not turn C# work into GPU work. Keep default sum/wrap flags unless individual-sample semantics are intended. For project state, use `ProfilerMetric("enemy_count", () => (double?)enemyManager.ActiveCount, "count")`. A reader returns `null` for missing data and should avoid expensive enumeration, allocations or logs on the measured main thread. Add stable project `ProfilerMarker` scopes only when built-in attribution is too coarse.

## Capture policy and analysis

`ProfilerCaptureOptions` fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `WarmupFrames` | `0` | Skip initial observed frames/ticks |
| `SampleEveryFrames` | `1` | Sample latest values every N observed frames/ticks; not an N-frame sum |
| `MaxSamples` | `3600` | Stop at this row count; range 1–60000 |
| `MaxSpikes` | `512` | Preallocated spike slots per capture; range 0–60000; overflow returns false and increments `GetProfilerDroppedSpikeCount(name)` |
| `Clock` | `"auto"` | Distinct `Time.frameCount` in Play Mode, editor ticks in Edit Mode; explicit `"unity_frame"` / `"editor_update"` also supported |
| `CaptureHierarchy` | `false` | Temporarily enable Profiler recording/CPU data for frame export |
| `CaptureGpu` | `false` | Also request GPU Profiler data, subject to hardware/API support |

The API observes latest recorder values; it cannot reconstruct frames missed between editor callbacks. Edit Mode ticks can read the same completed value again. Recorder buffers are not reset every tick: Unity `Reset()` stops collection. No completed data is missing, not zero. The row cap still applies if metrics are missing. Non-positive GPU frame timing is treated as unavailable.

Metric rows and spike slots are allocated at startup. The warmed numeric sampling loop and bounded spike updates do not grow storage or allocate managed objects (use already-normalized names/labels). Custom readers must also avoid allocations; after an exception the reader is disabled for that capture and subsequent rows are missing. Initialization, async waits, user code, Unity recording, discovery, summaries and serialization have separate overhead; zero managed allocation in the sampling loop does not imply zero CPU or native overhead.

Methods on `ctx.Profiler`:

- `GetProfilerSummary(name, metric)` retains `SampleCount`, `Average`, `P95`, `Max`, `Last`, `Available`, `Error`. `Statistics` adds missing count, min, median, p90, p99, population standard deviation, first and last values, and `Delta = last - first`.
- `GetProfilerSamples(name, metric, offset, count)` returns nullable observations with frame/timing metadata; default count 600, cap 60000.
- `GetProfilerBudget(name, metric, threshold)` reports observations strictly above the budget and their percentage among valid samples.
- `CompareProfilers(baseline, candidate, metric)` reports candidate minus baseline average/p95/max and percentage changes. Incompatible definitions or missing data produce errors; zero baselines have no percentage change.
- `IsProfilerStopped`, `StopProfiler`, `TryGetProfilerLastValue(name, metric, out value)` support scenario control.

Percentiles use nearest rank and exclude missing/non-finite observations. No-data statistics are `null` in JSON. Memory `Delta` is net change, not proof of a leak. CPU waits may be pacing, synchronization or GPU backpressure; do not add overlapping main/render/job durations or equate a rendering wait with GPU duration.

## Spikes and frame hierarchy

Start with `CaptureHierarchy = true`. Record candidates between awaits or in state updates; export only after capture stops:

```csharp
var p = ctx.Profiler;
p.RecordProfilerSpikeTop("baseline", "main_thread_ms", 30, "slow", 5);
// After the bounded sampling window:
p.StopProfiler("baseline");
foreach (var spike in p.GetProfilerSpikes("baseline")) {
    if (spike.ProfilerFrameIndex >= 0) p.SaveProfilerFrame("slow_" + spike.ProfilerFrameIndex, spike.ProfilerFrameIndex,
        new Locus.LocusBridge.ProfilerFrameOptions {
            ThreadName = "Main Thread", SortBy = "self_ms", TopCount = 80
        }, inlineRows: 0);
}
```

Spikes retain observation metadata; repeated checks do not duplicate the observation. Top-N retains the highest values for each metric/label. `GetProfilerSpikes` returns retained records. The legacy spelling `ctx.RecordProfilerSpikeTop` remains available.

`GetProfilerThreads(frame)` lists names/groups/indices/IDs. `GetProfilerFrame(frame, options)` returns CPU rows in memory. Options select `ThreadName` or concrete `ThreadIndex`, `SortBy` (`total_ms`, `self_ms`, `gc_bytes`, `calls`), `NameContains` (path substring), and `TopCount` (0–512). Missing threads produce errors, not another thread's rows. Frame metadata includes GPU duration when available; row durations remain **CPU** durations.

These allocating frame APIs require `ProfilerDriver.enabled == false`. `GetProfilerFrame` reports an error during recording; `GetProfilerThreads` throws. `StopProfiler` releases this call's recording lease and preserves an already-running user recording or another overlapping capture. If recording remains active, finish those captures or stop the Profiler explicitly before analysis. Without a path filter, hierarchy exports read names/paths only for Top-N winners.

Legacy exports remain supported: `ctx.SaveProfilerFrame(name, profilerFrameIndex, threadName, topCount)` and `ctx.SaveProfilerFrame(name, profilerFrameIndex, threadName, topCount, inlineRows)`. Overloads without the index use the latest buffered frame.

Unity frames, tool ticks and Profiler indices are different clocks. A sampled row records the latest available Profiler frame as a **candidate**, not guaranteed exact attribution; GPU data can arrive later. Inspect adjacent frames and verify the marker before attributing a spike. Buffers roll over: save promptly. Use the local Editor target; switching targets invalidates frame association. Do not sum hierarchy total-time rows because parent values include children.

## Workers, call paths and reusable numeric buffers

Use a short capture that fits Unity's history. After stopping, analyze all recorded threads in one pass:

```csharp
var p = ctx.Profiler;
var buffer = new Locus.LocusBridge.ProfilerFrameBuffer(
    maxThreads: 256, maxRows: 32768, maxDepth: 256,
    maxSamples: 1000000, timelineCapacity: 0);
p.StartProfiler("workers", p.ProfilerMetrics("cpu", "memory"),
    new Locus.LocusBridge.ProfilerCaptureOptions {
        CaptureHierarchy = true, WarmupFrames = 10, MaxSamples = 30
    });
await ctx.WaitUntil(() => p.IsProfilerStopped("workers"));
int frame = p.LatestProfilerFrameIndex();
var status = p.ReadProfilerFrameInto(frame, buffer); // all threads; exact selection: threadIndex: N
if (status != Locus.LocusBridge.ProfilerScanStatus.Complete)
    throw new System.InvalidOperationException(status.ToString());
status = p.ResolveProfilerFrameNames(buffer); // optional; once per distinct Marker ID
if (status != Locus.LocusBridge.ProfilerScanStatus.Complete)
    throw new System.InvalidOperationException(status.ToString());
p.SaveProfilerFrameAnalysis("workers", buffer);
p.SaveProfiler("workers");
```

`ReadProfilerFrameInto` reuses the buffer and resets it for each frame. It refuses live recording (`Recording`) because Unity allocates a `RawFrameDataView` wrapper per thread. For an already-open view, `AnalyzeProfilerThreadInto(rawView, buffer)` scans one thread with no managed allocation after initialization; the caller owns/disposes the view. It also resets the buffer. Do not print, resolve strings or open a new view per sample in that loop. Prefer stopped-frame analysis for minimal measurement interference.

Only entries below `ThreadCount`, `RowCount` and `SampleCount` are valid. Use indexed loops over these counts; do not serialize the entire backing arrays. `SaveProfilerFrameAnalysis` streams only populated entries to `locus.profiler.raw_frame.v1` JSON and prints `profiler_analysis_file`.

- `Threads`: native thread `Id`, per-frame `Index`, `FrameStartTimeNs`, `FrameMs`, root-sample `SampledMs`, sample counts, `GcBytes`, `MissingGcMetadata`, and the contiguous `FirstRow`/`RowCount` range. Names/groups are filled only by `ResolveProfilerFrameNames`.
- `Rows`: `(ThreadIndex, ParentRow, MarkerId)` identifies a call path. Includes category, native flags, depth, calls, inclusive `TotalMs`, exclusive `SelfMs`, inclusive `GcBytes` and direct `SelfGcBytes`. Repeated child calls under the same parent path aggregate; the same marker under a different parent or worker stays separate. GC bytes come from `GC.Alloc` metadata, not its duration. Inclusive bytes propagate to ancestors; add direct bytes only when summing rows.
- Optional `Samples`: set `timelineCapacity > 0` to retain chronological raw sample order, raw `SampleIndex`, parent **buffer** index `ParentSample` (-1 for roots), `MarkerRow`, frame-relative `StartMs`, total/self duration and direct GC bytes. Pair `StartMs` with the thread's `FrameStartTimeNs` to align workers. `TimelineTruncated` means aggregates are complete but the requested detail buffer filled.

`Status` explicitly reports unavailable frame/thread, row/thread/depth capacity or scan-work limits. Non-`Complete` aggregates are partial; increase capacity **before the next recording**, or select a narrower thread. The numeric scan has no dynamic growth, per-sample strings, path construction, sorting, reflection or logging. Marker IDs and row indices must not be reused blindly across captures; reset each frame and resolve names from its same buffered frame/target before eviction.

Thread totals include waits and idle scopes; they are not CPU utilization percentages. Inspect named self-time rows and timeline overlap to distinguish worker work, waiting and imbalance. Do not add overlapping worker totals to frame wall time. The API does not infer job dependency graphs or GPU work from CPU markers.

## GPU timing and memory snapshots

Combine render counters, the GPU frame counter, GPU-capable marker recorders and frame metadata. Use the graphics debugger skill for render-pass/resource/overdraw investigation beyond timing counters.

For CPU/GPU/present-wait records and dynamic resolution scale:

```csharp
if (ctx.Profiler.CaptureFrameTimings()) {
    await ctx.WaitFrames(8);
    printJson(ctx.Profiler.GetFrameTimings(4));
} else print("Frame Timing Stats is disabled or unsupported.");
```

Frame Timing Manager requires platform support and Frame Timing Stats configuration. The helper does not change Player settings. Records preserve timestamps for deduplication. GPU data may remain missing/delayed when CPU data is available.

For retained/native/managed memory investigation, take snapshots separately from timing measurements:

```csharp
string snapshot = await ctx.Profiler.SaveMemorySnapshotAsync("after_load", cancellationToken);
print(snapshot);
```

This saves `.snap` for Unity Memory Profiler. Select the local Editor target in the Profiler; the helper rejects a non-Editor target instead of taking a Player snapshot. Use `includeNativeAllocations: true` for allocation detail. Snapshot capture is intrusive; stop timing capture first. Cancellation ends the wait, but Unity's native operation may still finish writing. Snapshot requests are serialized. The helper does not automatically analyze retained-object graphs.

## Saved data

`SaveProfiler(name)` stops the capture, saves full-precision `locus.profiler.samples_csv.v1` CSV and `locus.profiler.summary.v1` JSON under `Library/Locus/RunStates`, prints `profiler_file` / `profiler_summary_file`, and returns the CSV path.

```csv
sample_index,session_frame,unity_time_frame_count,profiler_frame_index,elapsed_ms,main_thread_ms,gpu_frame_ms
0,31,546,190,517,11.2,
1,32,547,191,534,12.4,8.6
```

Empty cells mean missing, not zero. Summary JSON includes definitions, units, source/options, availability/statistics/spikes, Unity version, graphics API, Editor/Play Mode, sample policy and stop reason. `sample_rows` counts rows; spans are boundary distances and need not equal row count. Frame JSON retains `locus.profiler.frame_hierarchy.v1` with added filter/sort/GPU metadata.

## Unity 6.5

Unity 6.5 adds a 2D Profiler module for sprites/atlas usage, an experimental USS Stats Profiler, and Profiler AI integration. UI features do not imply public recorder APIs for every detail: discover exposed 2D metrics and use Unity's specific tools for atlas/USS detail absent from the catalog. Ordinary counter sampling does not require Unity Assistant or the Memory Profiler package.

Sources: [Unity 6.5 changes](https://docs.unity3d.com/6000.5/Documentation/Manual/WhatsNewUnity65.html), [ProfilerRecorder](https://docs.unity3d.com/6000.5/Documentation/ScriptReference/Unity.Profiling.ProfilerRecorder.html), [metric discovery](https://docs.unity3d.com/6000.5/Documentation/ScriptReference/Unity.Profiling.LowLevel.Unsafe.ProfilerRecorderHandle.GetAvailable.html), [Frame Timing Manager](https://docs.unity3d.com/6000.5/Documentation/ScriptReference/FrameTimingManager.html).
