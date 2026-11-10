Shader "Hidden/Locus/CaptureDepth"
{
    SubShader
    {
        Pass
        {
            ZTest Always ZWrite Off Cull Off
            HLSLPROGRAM
            #pragma target 4.5
            #pragma vertex vert
            #pragma fragment frag
            Texture2D<float> _LocusCaptureDepth;
            float4 vert(uint id : SV_VertexID) : SV_POSITION
            {
                float2 uv = float2((id << 1) & 2, id & 2);
                return float4(uv * 2 - 1, 0, 1);
            }
            float frag(float4 position : SV_POSITION) : SV_Target
            {
                return _LocusCaptureDepth.Load(int3((int2)position.xy, 0));
            }
            ENDHLSL
        }
    }
}
