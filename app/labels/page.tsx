"use client";
/* QR images are generated data URLs; Next image optimization cannot improve them. */
/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { Location } from "../../src/domain/types";
import { readReplica } from "../../src/client/local-replica";
type Label = Location & { qr?:string };
export default function Labels(){const[labels,setLabels]=useState<Label[]>([]),[selected,setSelected]=useState<string[]>([]);useEffect(()=>{void readReplica().then(async replica=>{if(!replica)return;const live=replica.state.locations.filter(l=>!l.archivedAt),withQr=await Promise.all(live.map(async l=>({...l,qr:await QRCode.toDataURL(`${location.origin}/?container=${encodeURIComponent(l.id)}`,{width:220,margin:1,errorCorrectionLevel:"M"})})));setLabels(withQr);setSelected(live.map(l=>l.id))})},[]);return <main className="labels-page"><header className="no-print"><div><p className="eyebrow">Physical labels</p><h1>Print container labels</h1></div><div><button onClick={()=>setSelected(labels.map(l=>l.id))}>Select all</button><button className="primary" onClick={()=>print()}>Print selected</button><Link href="/">Back</Link></div></header><p className="no-print muted">Readable codes work with a label gun; QR is optional and deep-links to the same container.</p><div className="label-sheet">{labels.map(l=><article key={l.id} data-print={selected.includes(l.id)}><label className="no-print"><input type="checkbox" checked={selected.includes(l.id)} onChange={()=>setSelected(s=>s.includes(l.id)?s.filter(x=>x!==l.id):[...s,l.id])}/> Include</label><img src={l.qr} alt={`QR code for ${l.code}`}/><div><b>{l.code}</b><strong>{l.name}</strong><small>{l.kind} · Stowplan</small></div></article>)}</div></main>}
