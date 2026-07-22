import { adminOverview } from "../../../../src/server/admin";
import { authenticate } from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";
export async function GET(request:Request){const env=await runtimeEnv();if(!env.DB)return Response.json({error:"Database is not configured"},{status:503});const user=await authenticate(env.DB,request);if(user?.globalRole!=="admin")return Response.json({error:"Admin scope required"},{status:403});return Response.json(await adminOverview(env.DB),{headers:{"cache-control":"no-store"}})}
