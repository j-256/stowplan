"use client";
/* QR images are generated data URLs; Next image optimization cannot improve them */
/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { workspacePath } from "../../src/domain/app-url";
import type { Location } from "../../src/domain/types";
import { readReplica } from "../../src/client/local-replica";
type Label = Location & { qr: string };

export default function Labels() {
  const [labels, setLabels] = useState<Label[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const replica = await readReplica();
      if (!replica) {
        setLabels([]);
        setSelected([]);
        setStatus("empty");
        return;
      }
      const live = replica.state.locations.filter((location) => !location.archivedAt);
      const withQr = await Promise.all(
        live.map(async (location) => ({
          ...location,
          qr: await QRCode.toDataURL(
            new URL(workspacePath({
              locationId: location.id,
              locationLabel: `${location.code} ${location.name}`,
              view: "capture",
              workspaceId: replica.state.workspace.id,
              workspaceLabel: replica.state.workspace.name,
            }), window.location.origin).href,
            { width: 220, margin: 1, errorCorrectionLevel: "M" },
          ),
        })),
      );
      setLabels(withQr);
      setSelected(live.map((location) => location.id));
      setStatus(live.length ? "ready" : "empty");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not open on-device storage");
      setStatus("error");
    }
  }, []);
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  return <main className="labels-page"><header className="no-print"><div><p className="eyebrow">Physical labels</p><h1>Print container labels</h1></div><div><button disabled={!labels.length} onClick={() => setSelected(labels.map((label) => label.id))}>Select all</button><button disabled={!selected.length} className="primary" onClick={() => print()}>Print selected</button><Link href="/">Back</Link></div></header><p className="no-print muted">Readable codes work with a label gun; QR is optional and deep-links to the same workspace and container.</p>{status === "loading" && <p className="loading-inline" role="status">Opening labels from this device...</p>}{status === "empty" && <section className="storage-error"><h2>No live spaces to label</h2><p>Create or restore a workspace, then add a room, cabinet, box, or other space.</p><Link href="/">Open Stowplan</Link></section>}{status === "error" && <section className="storage-error" role="alert"><h2>On-device storage could not be opened</h2><p>Nothing was changed. Check this browser&apos;s storage settings, then retry.</p><small>{error}</small><button onClick={() => void load()}>Retry</button></section>}<div className="label-sheet">{labels.map((label) => <article key={label.id} data-print={selected.includes(label.id)}><label className="no-print"><input type="checkbox" checked={selected.includes(label.id)} onChange={() => setSelected((current) => current.includes(label.id) ? current.filter((id) => id !== label.id) : [...current, label.id])} /> Include</label><img src={label.qr} alt={`QR code for ${label.code}`} /><div><b>{label.code}</b><strong>{label.name}</strong><small>{label.kind} · Stowplan</small></div></article>)}</div></main>;
}
