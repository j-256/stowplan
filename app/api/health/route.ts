import { runtimeEnv } from "../../../src/server/runtime";
export async function GET(){const env=await runtimeEnv();return Response.json({ok:true,storage:env.DB?"configured":"missing",time:new Date().toISOString()},{status:env.DB?200:503,headers:{"cache-control":"no-store"}})}
