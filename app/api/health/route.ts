import { probeDatabaseSchema } from "../../../src/server/database-health";
import { runtimeEnv } from "../../../src/server/runtime";

export async function GET() {
  const env = await runtimeEnv();
  const headers = { "cache-control": "no-store" };
  if (!env.DB) {
    return Response.json(
      { ok: false, storage: "missing", time: new Date().toISOString() },
      { status: 503, headers },
    );
  }
  try {
    await probeDatabaseSchema(env.DB);
    return Response.json(
      {
        ok: true,
        schema: "ready",
        storage: "configured",
        time: new Date().toISOString(),
      },
      { headers },
    );
  } catch {
    return Response.json(
      {
        ok: false,
        schema: "unavailable",
        storage: "configured",
        time: new Date().toISOString(),
      },
      { status: 503, headers },
    );
  }
}
