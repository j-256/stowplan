import packageMetadata from "../../../package.json";

const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=utf-8",
};

export function GET() {
  return new Response(`${packageMetadata.version}\n`, {
    headers: RESPONSE_HEADERS,
  });
}
