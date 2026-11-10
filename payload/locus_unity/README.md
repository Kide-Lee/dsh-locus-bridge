# Locus Unity Package

Embedded Unity package for Locus.

This package contains the Editor bridge, merged Roslyn bundle, and private JSON bundle used by the desktop app to communicate with the Unity Editor, execute C# snippets, parse View Script requests, and inspect project assets.

Windows Unity Inspector / UI Toolkit / IMGUI embedding: [Native Locus View](NativeWebView.md).

Publishing a View-owned RenderTexture into a Locus desktop panel: `Locus.Rendering.RenderOutput` and `UnityRenderSurface`; see the [GPU output SDK contract](../skills/view/unity-renderer.md) and [example View](../examples/unity-renderer/Renderer.vue). The SDK handles Windows/D3D11 sharing and input; scene, animation and pipeline code stay in the View.
