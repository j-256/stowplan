import Link from "next/link";
import {
  FULL_DOCUMENTATION_URL,
  PRIVACY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
  USER_GUIDE_URL,
} from "../../src/client/external-links";

export default function InAppDocs() {
  return <main className="admin-page">
    <header>
      <div>
        <p className="eyebrow">Available offline</p>
        <h1>Stowplan quick guide</h1>
      </div>
      <div>
        <a
          href={USER_GUIDE_URL}
          rel="noreferrer"
          target="_blank"
        >
          Open full user guide
        </a>
        <Link href="/">Back to organizer</Link>
      </div>
    </header>
    <section>
      <h2>Capture one space at a time</h2>
      <p>Give a room, cabinet, drawer, box, or bin the same short ID as its physical label. Enter each distinct item by name, adjusting the default quantity only when needed. Description and unit are optional details. On a phone, use <strong>Add container inside</strong> from the current container to open the matching queue form. Choose <strong>Skip for now</strong> to navigate without changing capture status, or <strong>Counted & next</strong> when the records are accurate enough to organize.</p>
    </section>
    <section>
      <h2>Keep working without service</h2>
      <p>Accepted changes are saved in this browser before online backup. A workspace already opened on this device stays available offline. Export before clearing browser data, uninstalling the app, or removing a device copy that may hold unsent work.</p>
    </section>
    <section>
      <h2>Find and move things</h2>
      <p>Use <strong>Spaces</strong> when you know the place and <strong>Inventory</strong> when you know the item. On a phone, each compact result shows the item, quantity, and nearest space; tap it for the full path and details. Choose <strong>Filter and sort</strong> beside search when you need its secondary controls. For an item in a counted space, review and reopen it in the item dialog, make the change, then choose <strong>Mark counted again</strong> there.</p>
    </section>
    <section>
      <h2>Follow the next move</h2>
      <p>With no active plan, <strong>Generate move plan</strong> appears before setup and readiness guidance. Generating focuses the compact <strong>Next move</strong> card, and returning to Plan puts that physical action first. On a phone, priorities, readiness, replacement, and discard actions move under <strong>Plan options</strong> while a plan is active. Keep the route and <strong>Mark moved</strong> action in view while working, expand the supporting details only when needed, and let the card advance after each completed move.</p>
    </section>
    <section>
      <h2>Correct a mistake</h2>
      <p>Use <strong>Activity</strong> to undo or reapply a recent change. Stowplan stops an undo that would overwrite a newer edit to the same information. If online backup refuses local work, choose <strong>Review sync issues or restore a backup</strong> and export the full recovery bundle before resetting anything.</p>
    </section>
    <section>
      <h2>Understand workspace actions</h2>
      <p><strong>Remove from this device</strong> removes only this browser&apos;s copy. <strong>Leave shared workspace</strong> removes your membership. <strong>Delete server workspace</strong> permanently deletes the online copy and has no server undelete path.</p>
    </section>
    <section>
      <h2>More help</h2>
      <p>The full guide covers the kitchen demo, collaboration, backup states, recovery, account data, and every organizing view.</p>
      <a href={FULL_DOCUMENTATION_URL} rel="noreferrer" target="_blank">
        Open all documentation
      </a>
      <a href={PRIVACY_POLICY_URL}>
        Read the privacy policy
      </a>
      <a href={TERMS_OF_SERVICE_URL}>
        Read the Terms of Service
      </a>
    </section>
  </main>;
}
