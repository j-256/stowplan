import { clearSessionCookie, isTrustedMutation, revokeCurrentSession } from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";
export async function POST(request:Request){if(!isTrustedMutation(request))return Response.json({error:"Cross-origin mutation denied"},{status:403});const env=await runtimeEnv();if(env.DB)await revokeCurrentSession(env.DB,request);return Response.json({ok:true},{headers:{"set-cookie":clearSessionCookie(),"cache-control":"no-store"}})}
