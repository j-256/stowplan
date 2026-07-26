import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PUBLIC_HOST = "localhost";
const BACKEND_HOST = "127.0.0.1";
const DEFAULT_PUBLIC_PORT = 3_100;
const BACKEND_PORT_OFFSET = 1;
const BACKEND_START_TIMEOUT_MS = 30_000;
const BACKEND_RETRY_DELAY_MS = 50;
const E2E_NEW_ACCOUNTS_PER_DAY = 1_000;
const TEST_OUTPUT_DIRECTORY = resolve("test-results");

const publicPort = Number(process.env.PORT ?? DEFAULT_PUBLIC_PORT);
if (
  !Number.isSafeInteger(publicPort) ||
  publicPort < 1 ||
  publicPort + BACKEND_PORT_OFFSET > 65_535
) {
  throw new Error("Playwright public port is invalid");
}
const backendPort = publicPort + BACKEND_PORT_OFFSET;
mkdirSync(TEST_OUTPUT_DIRECTORY, { recursive: true });
const certificateDirectory = mkdtempSync(
  join(TEST_OUTPUT_DIRECTORY, "playwright-tls-"),
);
const certificatePath = join(certificateDirectory, "certificate.pem");
const keyPath = join(certificateDirectory, "key.pem");

// HTTPS preserves the production __Host- session-cookie contract in every browser
const certificate = spawnSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
  ],
  { encoding: "utf8" },
);
if (certificate.status !== 0) {
  rmSync(certificateDirectory, { force: true, recursive: true });
  throw new Error(
    `Could not generate the Playwright TLS certificate: ${
      certificate.stderr.trim() || "openssl failed"
    }`,
  );
}
const tls = {
  cert: readFileSync(certificatePath),
  key: readFileSync(keyPath),
};
rmSync(certificateDirectory, { force: true, recursive: true });

const backend = spawn(
  process.execPath,
  ["scripts/node-server.mjs"],
  {
    env: {
      ...process.env,
      HOST: BACKEND_HOST,
      PORT: String(backendPort),
    },
    stdio: "inherit",
  },
);

function backendHealth() {
  return new Promise((resolveHealth) => {
    const request = httpRequest(
      {
        host: BACKEND_HOST,
        path: "/api/health",
        port: backendPort,
      },
      (response) => {
        response.resume();
        resolveHealth(response.statusCode === 200);
      },
    );
    request.once("error", () => resolveHealth(false));
    request.setTimeout(1_000, () => request.destroy());
    request.end();
  });
}

async function waitForBackend() {
  const deadline = Date.now() + BACKEND_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null || backend.signalCode !== null) {
      throw new Error("The Playwright backend exited before becoming ready");
    }
    if (await backendHealth()) return;
    await new Promise(resolveDelay =>
      setTimeout(resolveDelay, BACKEND_RETRY_DELAY_MS)
    );
  }
  throw new Error("The Playwright backend did not become ready");
}

function provisionE2eAccountCapacity() {
  const configuredPath = process.env.STOWPLAN_SQLITE_PATH;
  if (!configuredPath) {
    throw new Error("The Playwright database path is not configured");
  }
  const databasePath = resolve(configuredPath);
  const relativePath = relative(TEST_OUTPUT_DIRECTORY, databasePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("The Playwright database must be under test-results");
  }
  const sqlite = new DatabaseSync(databasePath);
  try {
    const result = sqlite.prepare(
      `UPDATE governance_limits
       SET limit_value = ?, updated_at = ?, updated_by_user_id = NULL
       WHERE limit_key = 'new_accounts_per_day'`,
    ).run(
      E2E_NEW_ACCOUNTS_PER_DAY,
      new Date().toISOString(),
    );
    if (Number(result.changes) !== 1) {
      throw new Error("The Playwright account capacity was not provisioned");
    }
  } finally {
    sqlite.close();
  }
}

const server = createServer(
  tls,
  (request, response) => {
    const publicAuthority = `${PUBLIC_HOST}:${publicPort}`;
    const proxy = httpRequest(
      {
        headers: {
          ...request.headers,
          host: publicAuthority,
          "x-forwarded-host": publicAuthority,
          "x-forwarded-proto": "https",
        },
        host: BACKEND_HOST,
        method: request.method,
        path: request.url,
        port: backendPort,
      },
      (proxyResponse) => {
        response.writeHead(
          proxyResponse.statusCode ?? 502,
          proxyResponse.headers,
        );
        proxyResponse.pipe(response);
      },
    );
    proxy.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("Playwright backend is unavailable");
    });
    request.pipe(proxy);
  },
);

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  server.close();
  if (backend.exitCode === null) backend.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop(signal));
}
backend.once("exit", (code, signal) => {
  if (!stopping) {
    stopping = true;
    server.close();
    process.exitCode = code ?? (signal ? 1 : 0);
  }
});
process.once("exit", () => {
  if (backend.exitCode === null) backend.kill();
  rmSync(certificateDirectory, { force: true, recursive: true });
});

await waitForBackend();
provisionE2eAccountCapacity();
server.listen(publicPort, BACKEND_HOST);
