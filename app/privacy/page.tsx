import type { Metadata } from "next";
import Link from "next/link";
import {
  FULL_DOCUMENTATION_URL,
  SOURCE_REPOSITORY_URL,
  TERMS_OF_SERVICE_URL,
} from "../../src/client/external-links";
import styles from "./privacy.module.css";

const EFFECTIVE_DATE = "July 29, 2026";
const PRIVACY_CONTACT_EMAIL = "privacy@strangelasers.com";

export const metadata: Metadata = {
  description: "How the official hosted Stowplan service handles personal information, browser storage, online workspaces, and privacy choices.",
  title: "Privacy policy",
};

export default function PrivacyPolicy() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/">Open Stowplan</Link>
      <a href={TERMS_OF_SERVICE_URL}>Terms of Service</a>
      <a href={FULL_DOCUMENTATION_URL}>User guide</a>
    </header>
    <article className={styles.policy}>
      <p className="eyebrow">Official hosted service</p>
      <h1>Privacy policy</h1>
      <p className={styles.effective}>Effective {EFFECTIVE_DATE}</p>
      <p>This policy explains how the official Stowplan service at <a href="https://stowplan.lasers.app">stowplan.lasers.app</a> handles personal information. Strange Lasers operates this service.</p>
      <p>Independent Stowplan installations have their own operators, infrastructure, and privacy practices. Their operators must publish policies that describe those installations.</p>

      <section>
        <h2>The short version</h2>
        <ul>
          <li>You can organize entirely in your browser without creating an account</li>
          <li>Signing in sends account information and workspace data to the hosted service for backup and sharing</li>
          <li>Stowplan does not sell personal information, show advertising, or use advertising or analytics trackers</li>
          <li>You can export your workspace, remove browser copies, leave shared workspaces, delete online workspaces you own, and delete your server account</li>
          <li>The service uses functional storage and security cookies, including Cloudflare bot-protection cookies</li>
        </ul>
      </section>

      <section>
        <h2>Information Stowplan handles</h2>
        <h3>Workspace information</h3>
        <p>Workspace information includes the names and codes you give rooms, cabinets, drawers, boxes, and other spaces; item names, quantities, descriptions, categories, tags, conditions, dimensions, and placement preferences; move plans; Activity and undo history; membership and invitation records; and synchronization records. This content can include personal information if you choose to enter it.</p>
        <p>Without an account, workspace information stays in this browser&apos;s IndexedDB storage unless you export it or intentionally send it elsewhere.</p>
        <p>After you sign in, Stowplan attempts to create or update an online copy of the open workspace and to upload waiting changes from other local workspaces. A workspace remains browser-only until a backup succeeds.</p>

        <h3>Account and sign-in information</h3>
        <p>If you use Google sign-in, Google provides a stable account identifier, email address, and display name after you approve the sign-in. Stowplan requests only the <code>openid</code>, <code>email</code>, and <code>profile</code> scopes. Stowplan does not retain Google&apos;s access token, refresh token, or ID token after sign-in completes.</p>
        <p>The service stores account and security records such as internal identifiers, linked sign-in identities, role and account status, the accepted Terms version and acceptance time, session-token hashes, session and sign-in times, browser or device descriptions, shortened network prefixes, invitation records, quota records, and security or administrative audit events. The raw Stowplan session value stays in a secure, HTTP-only browser cookie.</p>

        <h3>Hosting and security information</h3>
        <p>When you visit the hosted service, your browser sends request information such as its network address, requested path, time, browser headers, and security signals to OpenAI and Cloudflare so they can deliver and protect the site. In Stowplan&apos;s application database, session and security records use a shortened network prefix and limited browser description rather than a full stored network address, but provider logs may contain additional request data.</p>

        <h3>Information from other people</h3>
        <p>A workspace owner may invite you. After you accept, workspace owners can see the display name and email address associated with your Stowplan account and can manage your membership. Viewers and editors cannot open the ordinary member list. Other users may also enter information about people in workspace content. Anyone entering another person&apos;s information is responsible for having an appropriate reason to do so and providing any notice the law requires.</p>
      </section>

      <section>
        <h2>Why this information is used</h2>
        <p>Stowplan uses information to provide local organizing, online backup, synchronization, collaboration, invitations, account and session controls, exports, recovery, administration, security, abuse prevention, service limits, troubleshooting, and legal compliance. It is not used for advertising, marketing profiles, or automated decisions that have legal or similarly significant effects.</p>
        <p>Where data-protection law requires a legal basis, the basis depends on the activity: providing features you request; the legitimate interests of operating, securing, and improving a small hosted service; compliance with legal obligations; or consent when consent is specifically requested. You can avoid optional account processing by using Stowplan without signing in.</p>
        <p>Information received from Google is used only to authenticate and administer your Stowplan account. Stowplan&apos;s use and transfer of that information follows the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including its Limited Use requirements.</p>
      </section>

      <section>
        <h2>Browser storage and cookies</h2>
        <p>Stowplan uses browser storage and cookies needed to provide features you request, remember your choices, and protect the service. It does not use non-essential advertising or analytics cookies. The Google sign-in form asks separately before allowing the session cookie to remain after the browser session.</p>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Storage</th>
                <th>Purpose</th>
                <th>Typical duration</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td data-label="Storage">IndexedDB</td>
                <td data-label="Purpose">Local workspaces, pending changes, recovery state, and workspace catalog information</td>
                <td data-label="Duration">Until you remove the workspace or clear this site&apos;s browser data</td>
              </tr>
              <tr>
                <td data-label="Storage">Local and session storage</td>
                <td data-label="Purpose">Theme, layout, dismissed notices, and short-lived navigation or sign-in continuity</td>
                <td data-label="Duration">Persistent preferences last until cleared; session values normally end with the browser session</td>
              </tr>
              <tr>
                <td data-label="Storage">Service-worker cache</td>
                <td data-label="Purpose">Application pages and static assets needed for offline use</td>
                <td data-label="Duration">Until Stowplan replaces its cache or you clear this site&apos;s browser data</td>
              </tr>
              <tr>
                <td data-label="Storage"><code>__Host-stowplan_session</code></td>
                <td data-label="Purpose">Keeps a signed-in account authenticated</td>
                <td data-label="Duration">The browser session unless you choose to stay signed in; a persistent cookie lasts until the app session expires, normally within 30 days, or until you sign out, revoke it, or delete the account</td>
              </tr>
              <tr>
                <td data-label="Storage"><code>__Secure-stowplan_oauth_*</code></td>
                <td data-label="Purpose">Binds a Google sign-in callback to the browser that started it</td>
                <td data-label="Duration">10 minutes</td>
              </tr>
              <tr>
                <td data-label="Storage"><code>__cf_bm</code></td>
                <td data-label="Purpose">Cloudflare bot detection and service protection</td>
                <td data-label="Duration">30 minutes after inactivity</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>Cloudflare Turnstile also examines browser and network signals when you start Google sign-in so it can distinguish people from abusive automation. Read Cloudflare&apos;s <a href="https://www.cloudflare.com/turnstile-privacy-policy/">Turnstile Privacy Addendum</a> and <a href="https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/">cookie documentation</a> for details.</p>
        <p>Because Stowplan does not track activity across unrelated services for advertising, browser &quot;Do Not Track&quot; and Global Privacy Control signals do not change its behavior.</p>
      </section>

      <section>
        <h2>Who can receive or access information</h2>
        <ul>
          <li>Workspace viewers, editors, and owners can read online workspace content, subject to their workspace role</li>
          <li>Workspace owners can see member names and email addresses and can manage membership</li>
          <li>Database-authorized Stowplan administrators can inspect, export, administer, or delete online workspaces without being workspace members, and can explicitly add themselves as an owner</li>
          <li>People authorized by Strange Lasers to access infrastructure may access information when needed to operate, secure, recover, or support the service</li>
          <li>OpenAI hosts the Sites service and processes hosted information on the operator&apos;s behalf, using its listed subprocessors</li>
          <li>Cloudflare provides delivery, security, bot protection, and hosted database infrastructure</li>
          <li>Google provides optional sign-in and receives the information involved in that sign-in</li>
          <li>Information may be disclosed when required by law, to protect people or the service, or as part of a service transfer with appropriate notice and safeguards</li>
        </ul>
        <p>Stowplan does not sell or rent personal information. It does not share personal information for cross-context behavioral advertising. OpenAI&apos;s processing of hosted data is described in the <a href="https://openai.com/policies/chatgpt-sites-data-processing-addendum/">ChatGPT Sites Data Processing Addendum</a> and its <a href="https://openai.com/policies/sub-processor-list/">subprocessor list</a>.</p>
      </section>

      <section>
        <h2>Retention and deletion</h2>
        <ul>
          <li>Browser copies remain until you remove them or clear this site&apos;s browser data</li>
          <li>Online workspace content remains while the workspace exists; an owner or administrator can delete the online workspace immediately through Stowplan</li>
          <li>Account profiles and linked identity information remain while an account is active or disabled; account deletion or banning redacts those records, subject to the retained non-secret records described below</li>
          <li>A normal app session expires after 30 days even when its browser cookie ends sooner, and its server record becomes eligible for cleanup 30 days later; OAuth sign-in lifecycle records become eligible 24 hours after their 10-minute expiry, and invitation records become eligible 30 days after expiry</li>
          <li>Security and administrative audit events have no automatic expiry and may be retained indefinitely; Terms acceptance versions and times, non-secret deletion receipts, and keyed abuse-prevention digests may also remain as long as needed to preserve service integrity, prevent abuse, resolve disputes, or meet legal obligations</li>
          <li>Hosting logs, security records, and provider backups follow provider retention rules and may persist after an in-app deletion until they age out of protected systems</li>
        </ul>
        <p>If you leave a shared workspace or an owner removes you, your server membership and online access end, but the workspace and content you added remain available to remaining members. Any copy already stored on your device is retained read-only and is no longer backed up until you export or remove it.</p>
        <p>Deleting a server account removes sign-in identities, revokes sessions and unused invitations, removes workspace memberships, and redacts retained security records. It does not delete shared workspace content that remains available to other members. It also does not erase workspace copies or queued work stored on your devices; remove those copies separately on each device. Deleting an online workspace removes its live contents, memberships, and invitations, while retaining a non-secret deletion record and relevant audit facts.</p>
      </section>

      <section>
        <h2>Your choices and privacy rights</h2>
        <p>Stowplan provides controls to export workspace data, edit workspace content, remove a browser copy, revoke sessions, leave a shared workspace, delete an online workspace you own, delete your server account, and remove Google consent separately. Use Settings for exports and recovery, Workspace access to leave, Workspaces and backup status to remove a device copy, and Account and sessions to revoke sessions or delete your server account. The <a href={`${FULL_DOCUMENTATION_URL}guide/account-data`}>account and data guide</a> explains the effect of each action.</p>
        <p>Portable JSON exports contain workspace content and available history. Full recovery bundles also contain waiting or refused device changes and their error details. Downloaded files are copies under the holder&apos;s control and are not deleted or revoked when you leave a workspace, lose membership, or delete an account or online workspace.</p>
        <p>Depending on where you live, you may also have rights to request access, correction, deletion, restriction, objection, or a portable copy of personal information, and to withdraw consent where processing relies on consent. You may lodge a complaint with your local data-protection regulator. To make a request or ask for reconsideration of a response, email <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`}>{PRIVACY_CONTACT_EMAIL}</a>. The operator may need to verify your identity and may retain information when the law permits or requires it.</p>
      </section>

      <section>
        <h2>Security and international processing</h2>
        <p>Stowplan uses measures such as HTTPS, secure and HTTP-only session cookies, hashed session values, workspace-scoped authorization, shortened network prefixes, audited administrative actions, bounded resource allocation, and export and recovery controls. No service can guarantee absolute security, so keep your own exports and avoid entering information you do not need Stowplan to hold.</p>
        <p>The hosting providers and their subprocessors may process information in the United States and other countries. Those countries may have different privacy laws from your home country. Provider contracts and legally required transfer safeguards apply where available, but this Sites deployment does not promise that data remains in a particular country.</p>
      </section>

      <section>
        <h2>Children and sensitive information</h2>
        <p>The official hosted service is a general household organization tool and is not directed to children under 13 or the minimum digital-consent age where they live. If you believe a child provided personal information improperly, contact the operator so it can be reviewed and removed.</p>
        <p>Do not use the official hosted service for payment-card data or protected health information subject to HIPAA. Avoid storing passwords, government identifiers, precise financial information, or other sensitive personal information in item names, descriptions, or shared workspaces.</p>
      </section>

      <section>
        <h2>Changes and contact</h2>
        <p>This policy will be updated when the service&apos;s data practices materially change. The effective date at the top will change, and additional notice will be provided when required.</p>
        <p>For privacy questions or requests, contact Strange Lasers at <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`}>{PRIVACY_CONTACT_EMAIL}</a>. Do not send passwords, session values, invitation links, or workspace exports by email.</p>
      </section>
    </article>
    <footer className={styles.footer}>
      <a href={SOURCE_REPOSITORY_URL}>View Stowplan source</a>
      <a href={TERMS_OF_SERVICE_URL}>Terms of Service</a>
      <Link href="/">Return to Stowplan</Link>
    </footer>
  </main>;
}
