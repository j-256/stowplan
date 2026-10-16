const CLOUDFLARE_WORKERS_SPECIFIER = "cloudflare:workers";
const EMPTY_NAMESPACE_URL = "data:text/javascript,export%20%7B%7D";

export function resolve(specifier, context, nextResolve) {
  if (specifier === CLOUDFLARE_WORKERS_SPECIFIER) {
    // Node has no Cloudflare tracing namespace during artifact export validation
    return { url: EMPTY_NAMESPACE_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
