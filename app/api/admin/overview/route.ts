import { adminOverview } from "../../../../src/server/admin";
import { AuthorizationError, authorizeAdmin } from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";
export async function GET(request:Request){try{const env=await runtimeEnv();if(!env.DB)return Response.json({error:"Database is not configured"},{status:503});await authorizeAdmin(env.DB,env,request);return Response.json(await adminOverview(env.DB),{headers:{"cache-control":"no-store"}})}catch(error){return Response.json({error:error instanceof Error?error.message:"Admin authorization failed"},{status:error instanceof AuthorizationError?error.status:500})}}
