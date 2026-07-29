import type { Metadata } from "next";
import Link from "next/link";
import {
  PRIVACY_POLICY_URL,
  SOURCE_REPOSITORY_URL,
  TERMS_OF_SERVICE_URL,
  USER_GUIDE_URL,
} from "../src/client/external-links";
import RedirectKnownVisitor from "../src/client/redirect-known-visitor";
import styles from "./page.module.css";

const SUBHEAD = "Find what you packed without opening every box.";

const VALUE_POINTS = Object.freeze([
  {
    title: "Start before the system is perfect",
    body: "Put a short code on each room, cabinet, drawer, box, or bin, then record what you see as you go.",
  },
  {
    title: "Keep working without service",
    body: "Accepted changes are saved in this browser first. Keep counting in a basement, garage, or moving truck and back up later.",
  },
  {
    title: "Find anything quickly",
    body: "Search names, descriptions, categories, tags, and locations across the workspace instead of opening containers one by one.",
  },
  {
    title: "Make fewer physical moves",
    body: "Build an explainable move plan, review why each suggestion was made, and undo completed changes when reality differs.",
  },
] as const);

export const metadata: Metadata = {
  description: SUBHEAD,
  openGraph: {
    title: "Stowplan",
    description: SUBHEAD,
  },
};

export function Hero() {
  return <main className={styles.page}>
    <section className={styles.hero}>
      <p className="eyebrow">Organize one space at a time</p>
      <h1>Stowplan</h1>
      <p className={styles.subhead}>{SUBHEAD}</p>
      <p className={styles.supporting}>
        Label spaces, capture what&apos;s inside, and get a practical plan for
        putting everything where it belongs. No account needed to try it.
      </p>
      <div className={styles.actions}>
        <Link className="primary" href="/demo">Try the kitchen demo</Link>
        <Link href="/workspaces">Create a workspace</Link>
      </div>
    </section>
    <section className={styles.values}>
      {VALUE_POINTS.map((point) => <article
        className={styles.value}
        key={point.title}
      >
        <h2>{point.title}</h2>
        <p>{point.body}</p>
      </article>)}
    </section>
    <footer className={styles.footer}>
      <a href={USER_GUIDE_URL} rel="noreferrer" target="_blank">User guide</a>
      <a href={PRIVACY_POLICY_URL}>Privacy policy</a>
      <a href={TERMS_OF_SERVICE_URL}>Terms of Service</a>
      <a href={SOURCE_REPOSITORY_URL} rel="noreferrer" target="_blank">Source</a>
    </footer>
  </main>;
}

export default function Home() {
  return <>
    <Hero />
    <RedirectKnownVisitor />
  </>;
}
