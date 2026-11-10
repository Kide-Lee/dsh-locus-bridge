using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEditor.Profiling;
using UnityEditorInternal;
using Unity.Profiling.LowLevel;

namespace Locus
{
    public static partial class LocusBridge
    {
        public enum ProfilerScanStatus
        {
            Complete, Recording, FrameUnavailable, ThreadUnavailable, ThreadCapacity,
            RowCapacity, DepthCapacity, SampleLimit, InvalidHierarchy
        }

        public struct ProfilerThreadSample
        {
            public int Index, SampleCount, ScannedSamples, FirstRow, RowCount, MissingGcMetadata;
            public ulong Id, FrameStartTimeNs;
            public string Name, Group;
            public double FrameMs, SampledMs;
            public long GcBytes;
        }

        // One row per (thread, parent call path, marker). Inclusive times/bytes include children.
        public struct ProfilerMarkerSample
        {
            public int ThreadIndex, MarkerId, ParentRow, Depth, Calls;
            public ushort CategoryIndex;
            public MarkerFlags Flags;
            public string Name;
            public double TotalMs, SelfMs;
            public long GcBytes, SelfGcBytes;
        }

        public struct ProfilerTimelineSample
        {
            public int ThreadIndex, SampleIndex, ParentSample, MarkerRow;
            // StartMs is relative to this thread's frameStartTimeMs.
            public double StartMs, TotalMs, SelfMs;
            public long GcBytes;
        }

        /// <summary>Allocate before recording. Only entries below the corresponding Count are valid.
        /// Reset and numeric scanning reuse storage; limits never trigger growth. Main thread only.</summary>
        public sealed class ProfilerFrameBuffer
        {
            public readonly ProfilerThreadSample[] Threads;
            public readonly ProfilerMarkerSample[] Rows;
            public readonly ProfilerTimelineSample[] Samples;
            public int ThreadCount { get; internal set; }
            public int RowCount { get; internal set; }
            public int SampleCount { get; internal set; }
            public int ScannedSamples { get; internal set; }
            public int FrameIndex { get; internal set; } = -1;
            public ProfilerScanStatus Status { get; internal set; }
            public bool TimelineTruncated { get; internal set; }
            public bool NamesResolved { get; internal set; }
            public readonly int MaxSamples;
            internal readonly Dictionary<ProfilerRowKey, int> RowLookup;
            internal readonly ProfilerScanLevel[] Stack;
            internal int ConnectedProfiler;

            public ProfilerFrameBuffer(int maxThreads = 128, int maxRows = 16384, int maxDepth = 256,
                int maxSamples = 1000000, int timelineCapacity = 0)
            {
                if (maxThreads < 1 || maxThreads > 4096 || maxRows < 1 || maxRows > 1000000
                    || maxDepth < 1 || maxDepth > 16384 || maxSamples < 1 || maxSamples > 10000000
                    || timelineCapacity < 0 || timelineCapacity > 1000000)
                    throw new ArgumentOutOfRangeException("Profiler buffer capacity");
                Threads = new ProfilerThreadSample[maxThreads];
                Rows = new ProfilerMarkerSample[maxRows];
                Samples = new ProfilerTimelineSample[timelineCapacity];
                Stack = new ProfilerScanLevel[maxDepth];
                RowLookup = new Dictionary<ProfilerRowKey, int>(maxRows);
                MaxSamples = maxSamples;
            }

            public void Reset()
            {
                // Release resolved strings as well as numeric data without reallocating arrays.
                Array.Clear(Threads, 0, ThreadCount);
                Array.Clear(Rows, 0, RowCount);
                RowLookup.Clear();
                ThreadCount = RowCount = SampleCount = ScannedSamples = 0;
                FrameIndex = -1;
                Status = ProfilerScanStatus.Complete;
                TimelineTruncated = NamesResolved = false;
            }
        }

        internal struct ProfilerRowKey : IEquatable<ProfilerRowKey>
        {
            internal int Thread, Parent, Marker;
            public bool Equals(ProfilerRowKey other) { return Thread == other.Thread && Parent == other.Parent && Marker == other.Marker; }
            public override bool Equals(object other) { return other is ProfilerRowKey && Equals((ProfilerRowKey)other); }
            public override int GetHashCode() { unchecked { return (Thread * 397 ^ Parent) * 397 ^ Marker; } }
        }

        internal struct ProfilerScanLevel
        {
            internal int Row, RemainingChildren, TimelineIndex;
            internal long GcBytes;
        }

        public sealed partial class ProfilerApi
        {
            /// <summary>Write only populated entries, streaming one row at a time after recording stops.</summary>
            public string SaveProfilerFrameAnalysis(string name, ProfilerFrameBuffer buffer)
            {
                CheckProfilerBuffer(buffer);
                RequireProfilerAnalysisStopped();
                string path = Path.Combine(RunStatesResultDirectory(), "profiler-analysis-"
                    + SanitizeRunStatesFileName(NormalizeProfilerName(name)) + "-" + Guid.NewGuid().ToString("N") + ".json");
                using (var writer = new StreamWriter(path, false, Utf8NoBom))
                {
                    writer.Write("{\"schema\":\"locus.profiler.raw_frame.v1\",\"frame_index\":");
                    writer.Write(buffer.FrameIndex.ToString(CultureInfo.InvariantCulture));
                    writer.Write(",\"status\":"); writer.Write(ToCSharpStringLiteral(buffer.Status.ToString()));
                    writer.Write(",\"scanned_samples\":"); writer.Write(buffer.ScannedSamples.ToString(CultureInfo.InvariantCulture));
                    writer.Write(",\"names_resolved\":"); writer.Write(buffer.NamesResolved ? "true" : "false");
                    writer.Write(",\"timeline_truncated\":"); writer.Write(buffer.TimelineTruncated ? "true" : "false");
                    writer.Write(",\"threads\":"); WriteProfilerBufferRows(writer, buffer.Threads, buffer.ThreadCount);
                    writer.Write(",\"rows\":"); WriteProfilerBufferRows(writer, buffer.Rows, buffer.RowCount);
                    writer.Write(",\"samples\":"); WriteProfilerBufferRows(writer, buffer.Samples, buffer.SampleCount);
                    writer.Write('}');
                }
                Print("profiler_analysis_file: " + path);
                return path;
            }

            private static void WriteProfilerBufferRows<T>(StreamWriter writer, T[] rows, int count)
            {
                writer.Write('[');
                for (int i = 0; i < count; i++)
                {
                    if (i > 0) writer.Write(',');
                    writer.Write(Locus.Json.LocusJson.SerializeData(rows[i]));
                }
                writer.Write(']');
            }

            /// <summary>Scan all threads (or one exact index) in a stopped capture. No names are read.
            /// Unity allocates a RawFrameDataView wrapper per thread; sample processing is allocation-free.</summary>
            public ProfilerScanStatus ReadProfilerFrameInto(int frameIndex, ProfilerFrameBuffer buffer, int threadIndex = -1)
            {
                CheckProfilerBuffer(buffer);
                if (threadIndex < -1) throw new ArgumentOutOfRangeException(nameof(threadIndex));
                buffer.Reset();
                if (ProfilerDriver.enabled) return buffer.Status = ProfilerScanStatus.Recording;
                if (frameIndex < ProfilerDriver.firstFrameIndex || frameIndex > ProfilerDriver.lastFrameIndex || frameIndex < 0)
                    return buffer.Status = ProfilerScanStatus.FrameUnavailable;
                buffer.FrameIndex = frameIndex;
                buffer.ConnectedProfiler = ProfilerDriver.connectedProfiler;
                for (int index = threadIndex < 0 ? 0 : threadIndex; ; index++)
                {
                    using (var frame = ProfilerDriver.GetRawFrameDataView(frameIndex, index))
                    {
                        if (!frame.valid)
                        {
                            if (buffer.ThreadCount == 0) buffer.Status = ProfilerScanStatus.ThreadUnavailable;
                            break;
                        }
                        AppendProfilerThread(frame, buffer);
                    }
                    if (threadIndex >= 0 || buffer.Status != ProfilerScanStatus.Complete) break;
                }
                return buffer.Status;
            }

            /// <summary>Zero managed allocations after initialization, including Reset. The caller owns
            /// the view; opening a new Unity view is not allocation-free. Does not read names or log.</summary>
            public ProfilerScanStatus AnalyzeProfilerThreadInto(RawFrameDataView frame, ProfilerFrameBuffer buffer)
            {
                CheckProfilerBuffer(buffer);
                buffer.Reset();
                if (frame == null || !frame.valid) return buffer.Status = ProfilerScanStatus.FrameUnavailable;
                buffer.FrameIndex = frame.frameIndex;
                buffer.ConnectedProfiler = ProfilerDriver.connectedProfiler;
                AppendProfilerThread(frame, buffer);
                return buffer.Status;
            }

            /// <summary>Optional, allocating presentation pass. Resolve each marker once, after recording
            /// stops, and only from the same buffered frame/target. Never cache IDs across captures.</summary>
            public ProfilerScanStatus ResolveProfilerFrameNames(ProfilerFrameBuffer buffer)
            {
                CheckProfilerBuffer(buffer);
                if (ProfilerDriver.enabled) return ProfilerScanStatus.Recording;
                if (buffer.FrameIndex < 0 || buffer.FrameIndex < ProfilerDriver.firstFrameIndex
                    || buffer.FrameIndex > ProfilerDriver.lastFrameIndex || buffer.ConnectedProfiler != ProfilerDriver.connectedProfiler)
                    return ProfilerScanStatus.FrameUnavailable;
                var names = new Dictionary<int, string>();
                for (int t = 0; t < buffer.ThreadCount; t++)
                {
                    ref var thread = ref buffer.Threads[t];
                    using (var frame = ProfilerDriver.GetRawFrameDataView(buffer.FrameIndex, thread.Index))
                    {
                        if (!frame.valid || frame.threadId != thread.Id || frame.frameStartTimeNs != thread.FrameStartTimeNs)
                            return ProfilerScanStatus.ThreadUnavailable;
                        thread.Name = frame.threadName;
                        thread.Group = frame.threadGroupName;
                        for (int r = thread.FirstRow; r < thread.FirstRow + thread.RowCount; r++)
                        {
                            ref var row = ref buffer.Rows[r];
                            if (!names.TryGetValue(row.MarkerId, out var name))
                            {
                                name = row.MarkerId == FrameDataView.invalidMarkerId ? "" : frame.GetMarkerName(row.MarkerId);
                                names.Add(row.MarkerId, name);
                            }
                            row.Name = name;
                        }
                    }
                }
                buffer.NamesResolved = true;
                return buffer.Status;
            }

            private void CheckProfilerBuffer(ProfilerFrameBuffer buffer)
            {
                if (_disposed) throw new ObjectDisposedException(nameof(ProfilerApi));
                _lifetime.Token.ThrowIfCancellationRequested();
                if (buffer == null) throw new ArgumentNullException(nameof(buffer));
            }
        }

        private static void RequireProfilerAnalysisStopped()
        {
            if (ProfilerDriver.enabled)
                throw new InvalidOperationException("Stop Profiler recording before allocating analysis or export; use AnalyzeProfilerThreadInto for numeric scanning of an already-open view.");
        }

        private static void AppendProfilerThread(RawFrameDataView frame, ProfilerFrameBuffer buffer)
        {
            if (buffer.ThreadCount == buffer.Threads.Length) { buffer.Status = ProfilerScanStatus.ThreadCapacity; return; }
            int threadSlot = buffer.ThreadCount++;
            ref var thread = ref buffer.Threads[threadSlot];
            thread.Index = frame.threadIndex;
            thread.Id = frame.threadId;
            thread.FrameStartTimeNs = frame.frameStartTimeNs;
            thread.FrameMs = frame.frameTimeMs;
            thread.SampleCount = frame.sampleCount;
            thread.FirstRow = buffer.RowCount;
            // Native ID lookup, once per thread. No sample-name strings enter the hot loop.
            int gcMarker = frame.GetMarkerId("GC.Alloc");
            int depth = 0;
            double frameStart = buffer.Samples.Length > 0 ? frame.frameStartTimeMs : 0;
            for (int sample = 0; sample < thread.SampleCount; sample++)
            {
                while (depth > 0 && buffer.Stack[depth - 1].RemainingChildren == 0)
                    FinishProfilerLevel(buffer, ref depth);
                if (buffer.ScannedSamples >= buffer.MaxSamples) { buffer.Status = ProfilerScanStatus.SampleLimit; break; }
                if (depth == buffer.Stack.Length) { buffer.Status = ProfilerScanStatus.DepthCapacity; break; }
                int marker = frame.GetSampleMarkerId(sample);
                int parent = depth == 0 ? -1 : buffer.Stack[depth - 1].Row;
                var key = new ProfilerRowKey { Thread = thread.Index, Parent = parent, Marker = marker };
                if (!buffer.RowLookup.TryGetValue(key, out int rowIndex))
                {
                    if (buffer.RowCount == buffer.Rows.Length) { buffer.Status = ProfilerScanStatus.RowCapacity; break; }
                    rowIndex = buffer.RowCount++;
                    buffer.RowLookup.Add(key, rowIndex);
                    buffer.Rows[rowIndex] = new ProfilerMarkerSample { ThreadIndex = thread.Index, MarkerId = marker,
                        ParentRow = parent, Depth = depth, CategoryIndex = frame.GetSampleCategoryIndex(sample), Flags = frame.GetSampleFlags(sample) };
                }
                double duration = frame.GetSampleTimeMs(sample);
                long bytes = 0;
                if (marker == gcMarker && gcMarker != FrameDataView.invalidMarkerId)
                {
                    if (frame.GetSampleMetadataCount(sample) > 0) bytes = frame.GetSampleMetadataAsLong(sample, 0);
                    else thread.MissingGcMetadata++;
                }
                ref var row = ref buffer.Rows[rowIndex];
                row.Calls++;
                row.TotalMs += duration;
                row.SelfMs += duration;
                row.SelfGcBytes += bytes;
                int parentTimeline = -1;
                if (depth > 0)
                {
                    ref var level = ref buffer.Stack[depth - 1];
                    level.RemainingChildren--;
                    buffer.Rows[parent].SelfMs -= duration;
                    parentTimeline = level.TimelineIndex;
                    if (parentTimeline >= 0) buffer.Samples[parentTimeline].SelfMs -= duration;
                }
                else thread.SampledMs += duration;
                int timelineIndex = -1;
                if (buffer.Samples.Length > 0)
                {
                    if (buffer.SampleCount < buffer.Samples.Length)
                    {
                        timelineIndex = buffer.SampleCount++;
                        buffer.Samples[timelineIndex] = new ProfilerTimelineSample { ThreadIndex = thread.Index, SampleIndex = sample,
                            ParentSample = parentTimeline, MarkerRow = rowIndex, StartMs = frame.GetSampleStartTimeMs(sample) - frameStart,
                            TotalMs = duration, SelfMs = duration, GcBytes = bytes };
                    }
                    else buffer.TimelineTruncated = true;
                }
                buffer.Stack[depth++] = new ProfilerScanLevel { Row = rowIndex, RemainingChildren = frame.GetSampleChildrenCount(sample),
                    TimelineIndex = timelineIndex, GcBytes = bytes };
                thread.GcBytes += bytes;
                thread.ScannedSamples++;
                buffer.ScannedSamples++;
            }
            while (depth > 0)
            {
                if (buffer.Status == ProfilerScanStatus.Complete && buffer.Stack[depth - 1].RemainingChildren != 0)
                    buffer.Status = ProfilerScanStatus.InvalidHierarchy;
                FinishProfilerLevel(buffer, ref depth);
            }
            thread.RowCount = buffer.RowCount - thread.FirstRow;
        }

        private static void FinishProfilerLevel(ProfilerFrameBuffer buffer, ref int depth)
        {
            var level = buffer.Stack[--depth];
            buffer.Rows[level.Row].GcBytes += level.GcBytes;
            if (depth > 0) buffer.Stack[depth - 1].GcBytes += level.GcBytes;
        }
    }
}
