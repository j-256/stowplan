import { clearSessionCookie, revokeCurrentSession } from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";
export async function POST(request:Request){const env=await runtimeEnv();if(env.DB)await revokeCurrentSession(env.DB,request);return Response.json({ok:true},{headers:{"set-cookie":clearSessionCookie(),"cache-control":"no-store"}})}
