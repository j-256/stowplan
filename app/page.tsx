// Internal workspace sites can read the authenticated OpenAI user from the
// forwarded request headers:
//
// import { headers } from "next/headers";
//
// export default async function Home() {
//   const requestHeaders = await headers();
//   const email = requestHeaders.get("oai-authenticated-user-email");
//   const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
//   const fullName =
//     encodedFullName &&
//     requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
//       "percent-encoded-utf-8"
//       ? decodeURIComponent(encodedFullName)
//       : null;
//   const displayName = fullName ?? email;
//   // ...
// }

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-24 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="mx-auto flex max-w-4xl flex-col gap-16">
        <section className="space-y-6">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
            Starter Project
          </p>
          <h1 className="max-w-2xl text-5xl font-semibold tracking-tight sm:text-6xl">
            Ship something real from a clean baseline.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">
            This starter keeps the shell minimal so you can focus on the
            product, content, and workflows that matter for your build.
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <article className="rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-lg font-semibold">Start with structure</h2>
            <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">
              Replace this page with your site entry point and shape the layout
              around the experience you actually need.
            </p>
          </article>
          <article className="rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-lg font-semibold">Keep the stack quiet</h2>
            <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">
              The default copy stays framework-agnostic so the interface reads
              like your product, not a generated template.
            </p>
          </article>
          <article className="rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-lg font-semibold">Drizzle-ready</h2>
            <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">
              D1 bindings live in <code>.openai/hosting.json</code>, schema
              lives in <code>db/schema.ts</code>, and an inactive D1 route
              example lives at <code>examples/d1/app/api/notes/route.ts</code>.
            </p>
          </article>
        </section>
      </div>
    </main>
  );
}
