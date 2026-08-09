import type { Metadata } from "next";
import Link from "next/link";
import {
  FULL_DOCUMENTATION_URL,
  PRIVACY_POLICY_URL,
  SOURCE_REPOSITORY_URL,
} from "../../src/client/external-links";
import {
  TERMS_EFFECTIVE_DATE,
} from "../../src/shared/terms";
import styles from "../privacy/privacy.module.css";

const LEGAL_CONTACT_EMAIL = "legal@strangelasers.com";

export const metadata: Metadata = {
  description: "Terms for using the official hosted Stowplan service, including accounts, workspace content, acceptable use, and service availability.",
  title: "Terms of Service",
};

export default function TermsOfService() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/">Open Stowplan</Link>
      <a href={PRIVACY_POLICY_URL}>Privacy policy</a>
      <a href={FULL_DOCUMENTATION_URL}>User guide</a>
    </header>
    <article className={styles.policy}>
      <p className="eyebrow">Official hosted service</p>
      <h1>Terms of Service</h1>
      <p className={styles.effective}>
        Effective {TERMS_EFFECTIVE_DATE}
      </p>
      <p>These Terms govern the official Stowplan service at <a href="https://stowplan.lasers.app">stowplan.lasers.app</a>. Strange Lasers operates this service.</p>
      <p>When you check the agreement and continue with Google, you agree to these Terms. If you do not agree, do not sign in. You can still use Stowplan&apos;s browser-only organizing features and demo without an account.</p>
      <p>Independent Stowplan installations have their own operators and terms. These Terms do not govern a fork or another installation.</p>

      <section>
        <h2>The short version</h2>
        <ul>
          <li>You own the workspace content you enter</li>
          <li>You give the service only the permission needed to store, process, protect, and share that content as you direct</li>
          <li>You must use the service lawfully and avoid harming the service or other people</li>
          <li>The service is free and provided without an uptime, backup, or error-free guarantee</li>
          <li>You should keep exports of information you cannot afford to lose</li>
        </ul>
      </section>

      <section>
        <h2>Who may use the service</h2>
        <p>You may use the official hosted service only if you can legally agree to these Terms. The service is not directed to children under 13 or anyone below the minimum digital-consent age where they live. If you use Stowplan for an organization or household, you confirm that you have authority to act for it where that is required.</p>
      </section>

      <section>
        <h2>Browser-only and signed-in use</h2>
        <p>Stowplan can store a workspace in your browser without an account. Browser data can be lost if site data is cleared, the browser profile is removed, or the device fails. You are responsible for exporting anything you need to keep.</p>
        <p>Signing in enables online backup and collaboration. A workspace has an online copy only after a backup succeeds. Local changes can remain on one device while offline or after a sync refusal, so account access is not a promise that every change is stored online.</p>
      </section>

      <section>
        <h2>Accounts and security</h2>
        <p>You are responsible for access to your Google account, browser profile, devices, Stowplan sessions, and invitation links. Do not share session values or use another person&apos;s identity. Keep your account information reasonably accurate and contact <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a> if you believe an account or workspace is being used without permission.</p>
        <p>Stowplan may limit account creation, sessions, storage, workspaces, invitations, or other resources to protect a small shared service and keep it available.</p>
      </section>

      <section>
        <h2>Workspaces and sharing</h2>
        <p>Workspace roles control what members can see and change. An owner can invite or remove members, change roles, transfer practical control by adding another owner, and delete the online workspace. Installation administrators can inspect, administer, export, or delete server data as described in the <a href={PRIVACY_POLICY_URL}>Privacy Policy</a> and <a href={`${FULL_DOCUMENTATION_URL}guide/account-data`}>account and data guide</a>.</p>
        <p>Share an invitation only with someone who should receive the stated access. If you join a workspace, the workspace and content you add may remain available to other members after you leave or your account is deleted.</p>
      </section>

      <section>
        <h2>Your content</h2>
        <p>You keep any ownership rights you have in workspace content. You give Strange Lasers a limited, non-exclusive license to host, copy, process, transmit, display, secure, back up, and modify that content only as needed to operate, maintain, protect, diagnose, and improve how the service works and to carry out the sharing choices you make. This license lasts while the content is held by the service and for any limited period it remains in provider backups or retained records described by the Privacy Policy.</p>
        <p>You confirm that you have the rights and permissions needed to submit content and share it with workspace members. Do not enter information that the official service is not designed to protect, including passwords, payment-card data, government identifiers, or protected health information subject to HIPAA.</p>
      </section>

      <section>
        <h2>Acceptable use</h2>
        <p>Do not use the official hosted service to:</p>
        <ul>
          <li>Break the law, violate another person&apos;s rights, or facilitate fraud, abuse, harassment, or threats</li>
          <li>Upload malicious code or content intended to damage, disrupt, or gain unauthorized access to systems or data</li>
          <li>Probe, bypass, or interfere with authentication, authorization, rate limits, security controls, or workspace boundaries</li>
          <li>Overload the service, automate abusive account or resource creation, or use it in a way that materially degrades access for others</li>
          <li>Impersonate another person, misrepresent your authority, or collect or expose personal information without an appropriate reason</li>
          <li>Use invitation links, exports, or shared content beyond the access the sender or owner intended</li>
        </ul>
      </section>

      <section>
        <h2>Service changes and availability</h2>
        <p>The official hosted service is a small, free project. Features, limits, providers, and storage behavior may change, and the service may be interrupted or discontinued. When practical, material changes that require action will be announced through the service or project documentation.</p>
        <p>No uptime, support-response, durability, or backup commitment is offered. Keep your own exports and verify that important workspaces show a successful backup. Stowplan is not an emergency, safety-critical, medical, financial, or records-retention service.</p>
      </section>

      <section>
        <h2>Suspension, termination, and deletion</h2>
        <p>You may stop using browser-only features at any time, sign out, revoke sessions, leave shared workspaces, delete online workspaces you own, and delete your server account through the available controls.</p>
        <p>Strange Lasers may restrict, suspend, or terminate access when reasonably necessary to address a legal requirement, security risk, abuse, material breach of these Terms, harm to another person, or danger to the service. Where practical and safe, the operator will provide notice or an opportunity to export data. Immediate action may be necessary, and recovery is not guaranteed.</p>
        <p>Deletion effects and retained records are described in the <a href={PRIVACY_POLICY_URL}>Privacy Policy</a>. Removing an online account or workspace does not remove copies already exported or stored on a device.</p>
      </section>

      <section>
        <h2>Open-source code and third-party services</h2>
        <p>Stowplan&apos;s source code is offered separately under the <a href={`${SOURCE_REPOSITORY_URL}/blob/main/LICENSE`}>GNU Affero General Public License, version 3</a>. That license governs copying, modifying, and distributing the code. These Terms govern use of the official hosted service.</p>
        <p>The service relies on third parties including OpenAI, Cloudflare, and Google. Their services and your direct relationship with them are governed by their own terms and policies. Strange Lasers is not responsible for a third-party service outside its control.</p>
      </section>

      <section>
        <h2>Disclaimers</h2>
        <p>To the maximum extent the law permits, the official hosted service is provided &quot;as is&quot; and &quot;as available&quot; without warranties of merchantability, fitness for a particular purpose, non-infringement, availability, accuracy, or data preservation. No statement in these Terms excludes a warranty or consumer right that cannot legally be excluded.</p>
      </section>

      <section>
        <h2>Limits on liability</h2>
        <p>To the maximum extent the law permits, Strange Lasers will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost data, profits, revenue, business, or opportunities arising from the service. Strange Lasers&apos; total liability for claims relating to the official hosted service will not exceed the greater of US $100 or the amount you paid Strange Lasers for the service during the 12 months before the event giving rise to the claim.</p>
        <p>These limits do not apply to liability that cannot legally be limited, including any non-waivable consumer rights. Some places do not allow certain exclusions or limits, so parts of this section may not apply to you.</p>
      </section>

      <section>
        <h2>Changes and contact</h2>
        <p>These Terms may change as the service changes. The effective date at the top will be updated, and additional notice or a new agreement will be requested when required. When a new agreement is required, you will be asked to accept it again, normally at sign-in.</p>
        <p>Questions, notices, and good-faith concerns can be sent to Strange Lasers at <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>. Do not send passwords, session values, invitation links, or workspace exports by email.</p>
      </section>
    </article>
    <footer className={styles.footer}>
      <a href={SOURCE_REPOSITORY_URL}>View Stowplan source</a>
      <a href={PRIVACY_POLICY_URL}>Privacy policy</a>
      <Link href="/">Return to Stowplan</Link>
    </footer>
  </main>;
}
