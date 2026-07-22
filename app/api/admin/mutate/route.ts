import { adminMutation } from "../../../../src/server/admin";
import { authenticate } from "../../../../src/server/auth";
import { runtimeEnv } from "../../../../src/server/runtime";
export async function POST(request:Request){try{const env=await runtimeEnv();if(!env.DB)return Response.json({error:"Database is not configured"},{status:503});const user=await authenticate(env.DB,request);if(user?.globalRole!=="admin")return Response.json({error:"Admin scope required"},{status:403});const body=await request.json() as {action:string;targetId:string;value?:string};await adminMutation(env.DB,user.userId,body);return Response.json({ok:true})}catch(error){return Response.json({error:error instanceof Error?error.message:"Admin mutation failed"},{status:400})}}
