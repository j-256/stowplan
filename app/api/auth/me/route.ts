import { authenticate } from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";
export async function GET(request:Request){const env=await runtimeEnv();if(!env.DB)return Response.json({user:null,configured:false});const user=await authenticate(env.DB,request);return Response.json({user,configured:true},{status:user?200:401,headers:{"cache-control":"no-store"}})}
