"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface User { email:string; displayName:string; globalRole:string; expiresAt:string }
interface MeResponse { user:User|null; configured:boolean; providers:string[] }
interface GuestResponse { url?:string; expiresAt?:string; error?:string }

async function fetchAccount(): Promise<MeResponse> {
  let response = await fetch("/api/auth/me", { cache: "no-store" });
  let body = await response.json() as MeResponse;
  if (!body.user && body.providers?.includes("cloudflare-access")) {
    const access = await fetch("/api/auth/access", { method: "POST" });
    if (access.ok) {
      response = await fetch("/api/auth/me", { cache: "no-store" });
      body = await response.json() as MeResponse;
    }
  }
  return body;
}

export default function Account(){
  const [user,setUser]=useState<User|null>(null),[configured,setConfigured]=useState(false),[providers,setProviders]=useState<string[]>([]),[loaded,setLoaded]=useState(false),[message,setMessage]=useState("");
  const [returnTo]=useState(()=>{if(typeof location==="undefined")return "/";const requested=new URLSearchParams(location.search).get("returnTo");return requested?.startsWith("/")&&!requested.startsWith("//")?requested:"/"});
  useEffect(()=>{let active=true;void fetchAccount().catch(()=>({user:null,configured:false,providers:[]} satisfies MeResponse)).then(body=>{if(!active)return;setUser(body.user);setConfigured(body.configured);setProviders(body.providers??[]);setLoaded(true)});return()=>{active=false}},[]);
  const guest=async()=>{const workspace=new URLSearchParams(location.search).get("workspace");if(!workspace){setMessage("Open this page from a workspace first.");return}const response=await fetch("/api/admin/guest-links",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workspaceId:workspace,role:"editor",hours:24})}),body=await response.json() as GuestResponse;setMessage(response.ok?`One-time link (expires ${new Date(body.expiresAt as string).toLocaleString()}): ${body.url}`:body.error??"Could not create link")};
  const developmentSignIn=async(data:FormData)=>{setMessage("");const response=await fetch("/api/auth/dev",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:String(data.get("email")),name:String(data.get("name"))})});const body=await response.json() as {error?:string};if(!response.ok){setMessage(body.error??"Development sign-in failed");return}location.href=returnTo};
  const oauthReturn=encodeURIComponent(returnTo);

  return <main className="onboarding account"><section><p className="eyebrow">Identity & backup</p><h1>{user?`Signed in as ${user.displayName}`:"Connect Stowplan"}</h1>{!loaded?<p>Checking server configuration…</p>:user?<><p>{user.email} · {user.globalRole}<br/>Session expires {new Date(user.expiresAt).toLocaleString()}</p><button onClick={guest}>Create 24-hour guest link</button><button onClick={async()=>{await fetch("/api/auth/logout",{method:"POST"});location.reload()}}>Sign out</button>{user.globalRole==="admin"&&<Link href="/admin">Open admin control panel</Link>}</>:<><p>{configured?"Sign in to back up this device, administer the server, and share authorized workspaces.":"This deployment has no server database. Local organizing remains fully available; use the Node + SQLite or Cloudflare + D1 runbook to test server features."}</p>{providers.includes("development")&&<form action={developmentSignIn} className="dev-signin"><h2>Local development sign-in</h2><label>Name<input name="name" defaultValue="Local Owner" required /></label><label>Admin email<input name="email" type="email" defaultValue="owner@example.test" required /></label><button className="primary">Sign in locally</button><small>Shown only when <code>AUTH_DEV_ENABLED=true</code>. Never enable it on a public deployment.</small></form>}{providers.includes("google")&&<a className="auth-button" href={`/api/auth/google/start?returnTo=${oauthReturn}`}>Continue with Google</a>}{providers.includes("github")&&<a className="auth-button" href={`/api/auth/github/start?returnTo=${oauthReturn}`}>Continue with GitHub</a>}{configured&&!providers.length&&<p className="muted">The database is ready, but no sign-in provider is enabled.</p>}<p className="muted">Cloudflare Access can sign you in automatically when enabled by the operator. Guest links are one-time and short-lived.</p></>}{message&&<output>{message}</output>}<Link href="/">Back to Stowplan</Link></section></main>;
}
