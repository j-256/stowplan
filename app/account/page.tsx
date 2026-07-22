"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

interface User { email:string; displayName:string; globalRole:string; expiresAt:string }
interface MeResponse { user:User|null; configured:boolean }
interface GuestResponse { url?:string; expiresAt?:string; error?:string }

export default function Account(){
  const [user,setUser]=useState<User|null>(null),[configured,setConfigured]=useState(true),[message,setMessage]=useState("");
  useEffect(()=>{void (async()=>{try{let response=await fetch("/api/auth/me",{cache:"no-store"}),body=await response.json() as MeResponse;if(!response.ok&&body.configured){const access=await fetch("/api/auth/access",{method:"POST"});if(access.ok){response=await fetch("/api/auth/me",{cache:"no-store"});body=await response.json() as MeResponse}}setUser(body.user);setConfigured(body.configured)}catch{setConfigured(false)}})()},[]);
  const guest=async()=>{const workspace=new URLSearchParams(location.search).get("workspace");if(!workspace){setMessage("Open this page from a workspace first.");return}const response=await fetch("/api/admin/guest-links",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workspaceId:workspace,role:"editor",hours:24})}),body=await response.json() as GuestResponse;setMessage(response.ok?`One-time link (expires ${new Date(body.expiresAt as string).toLocaleString()}): ${body.url}`:body.error??"Could not create link")};
  return <main className="onboarding account"><section><p className="eyebrow">Identity & backup</p><h1>{user?`Signed in as ${user.displayName}`:"Connect Stowplan"}</h1>{user?<><p>{user.email} · {user.globalRole}<br/>Session expires {new Date(user.expiresAt).toLocaleString()}</p><button onClick={guest}>Create 24-hour guest link</button><button onClick={async()=>{await fetch("/api/auth/logout",{method:"POST"});location.reload()}}>Sign out</button></>:<><p>{configured?"Sign in to back up this device and share authorized workspaces.":"Server authentication is not configured yet. Local organizing remains fully available."}</p><a className="auth-button" href="/api/auth/google/start">Continue with Google</a><a className="auth-button" href="/api/auth/github/start">Continue with GitHub</a><p className="muted">Cloudflare Access can sign you in automatically when enabled by the operator. Guest links are one-time and short-lived.</p></>}{message&&<output>{message}</output>}<Link href="/">Back to Stowplan</Link></section></main>
}
