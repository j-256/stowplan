import { cpSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const databasePath=resolve(process.env.STOWPLAN_SQLITE_PATH??"data/stowplan.sqlite");mkdirSync(dirname(databasePath),{recursive:true});const sqlite=new DatabaseSync(databasePath);if(!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_snapshots'").get())sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql",import.meta.url),"utf8"));
const DB={prepare(sql){const statement=sqlite.prepare(sql);const wrap=(values=[])=>({bind(...nextValues){return wrap(nextValues)},async first(){return statement.get(...values)??null},async all(){return{results:statement.all(...values)}},async run(){const result=statement.run(...values);return{success:true,meta:{changes:Number(result.changes)}}}});return wrap()}};
globalThis.__STOWPLAN_ENV={...process.env,DB};
process.env.HOSTNAME=process.env.HOST??"0.0.0.0";
const standalone=resolve(".next/standalone"),standaloneStatic=resolve(standalone,".next/static"),standalonePublic=resolve(standalone,"public");if(!existsSync(resolve(standalone,"server.js")))throw new Error("Run npm run build:next before start:node");if(!existsSync(standaloneStatic))cpSync(resolve(".next/static"),standaloneStatic,{recursive:true});if(!existsSync(standalonePublic))cpSync(resolve("public"),standalonePublic,{recursive:true});await import(new URL("../.next/standalone/server.js",import.meta.url).href);
