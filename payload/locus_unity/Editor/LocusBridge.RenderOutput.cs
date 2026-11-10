using System;
using System.Threading.Tasks;
using UnityEngine;

namespace Locus
{
    public static partial class LocusBridge
    {
        [Serializable] sealed class RenderOutputRequest {public string operation;public string id;}
        [Serializable] sealed class RenderOutputReply {public int version=1;public string domainGeneration;public string graphicsApi="d3d11";}
        static async Task<PipeEnvelope> HandleRenderOutput(string requestId,string message)
        {
            var request=JsonUtility.FromJson<RenderOutputRequest>(message);
            if(request==null)return ErrorResponse(requestId,"Missing render output request");
            var completion=LocusAsync.CreateTcs<PipeEnvelope>();
            PostToMainThread(delegate {
                try {
                    switch(request.operation) {
                        case "create": Rendering.RenderOutput.Register(request.id);break;
                        case "close": Rendering.RenderOutput.Close(request.id);break;
                        case "capabilities": Rendering.RenderOutput.CheckSupport();break;
                        default:throw new ArgumentException("Unknown GPU output operation");
                    }
                    completion.SetResult(OkResponse(requestId,JsonUtility.ToJson(new RenderOutputReply{domainGeneration=Rendering.RenderOutput.DomainGeneration})));
                }catch(Exception exception){completion.SetResult(ErrorResponse(requestId,exception.Message));}
            });
            return await completion.Task.ConfigureAwait(false);
        }
    }
}
