#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_BASE_URL = "https://plan-api.k8r.no";
const CONFIG_PATH = resolve(process.env.HOME || ".", ".config/html-plan-host/env");

function usage() {
  console.error(`Usage: upload-html-plan.mjs <file.html> [--ttl seconds] [--title title] [--base-url url]
       upload-html-plan.mjs <file.html> --plan-id id --update-token token --change-summary summary

Environment:
  HTML_PLAN_HOST_TOKEN       preferred upload token
  PLAN_HOST_TOKEN            fallback upload token
  HTML_PLAN_HOST_BASE_URL    optional Worker URL override
  HTML_PLAN_HOST_TTL_SECONDS optional TTL override`);
}

function parseArgs(argv) {
  const options = { file: null, ttl: process.env.HTML_PLAN_HOST_TTL_SECONDS || null, title: null, baseUrl: process.env.HTML_PLAN_HOST_BASE_URL || DEFAULT_BASE_URL, planId: null, updateToken: null, changeSummary: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") { usage(); process.exit(0); }
    if (value === "--ttl") { options.ttl = argv[++index] || null; continue; }
    if (value === "--title") { options.title = argv[++index] || null; continue; }
    if (value === "--base-url") { options.baseUrl = argv[++index] || null; continue; }
    if (value === "--plan-id") { options.planId = argv[++index] || null; continue; }
    if (value === "--update-token") { options.updateToken = argv[++index] || null; continue; }
    if (value === "--change-summary") { options.changeSummary = argv[++index] || null; continue; }
    if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    if (options.file) throw new Error(`Unexpected extra argument: ${value}`);
    options.file = value;
  }
  if (!options.file) throw new Error("Missing HTML file path.");
  if (options.planId && (!options.updateToken || !options.changeSummary)) throw new Error("Updates require --update-token and --change-summary.");
  return options;
}

function findDevVars(startDir) {
  let current = resolve(startDir);
  while (true) {
    const candidate = resolve(current, ".dev.vars");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readKeyValueFile(filePath, key) {
  if (!filePath || !existsSync(filePath)) return null;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(new RegExp(`^${key}=(.*)$`));
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

function getToken(filePath) {
  return process.env.HTML_PLAN_HOST_TOKEN || process.env.PLAN_HOST_TOKEN || readKeyValueFile(findDevVars(dirname(resolve(filePath))), "PLAN_HOST_TOKEN") || readKeyValueFile(CONFIG_PATH, "PLAN_HOST_TOKEN");
}

function parseTtl(value) {
  if (!value) return null;
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("--ttl must be a positive number of seconds.");
  return Math.floor(ttl);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const filePath = resolve(options.file);
  const html = readFileSync(filePath, "utf8");
  if (!/\.html?$/i.test(filePath)) throw new Error("Input file must use an .html or .htm extension.");
  if (!/<(?:!doctype\s+html|html|body|section|article)\b/i.test(html)) throw new Error("Input file does not look like an HTML document.");
  const token = getToken(filePath);
  if (!token) throw new Error(`Missing upload token. Set PLAN_HOST_TOKEN, HTML_PLAN_HOST_TOKEN, or add PLAN_HOST_TOKEN to ${CONFIG_PATH}.`);
  const ttl = parseTtl(options.ttl);
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/plans${options.planId ? `/${options.planId}` : ""}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(options.planId
      ? { html, update_token: options.updateToken, change_summary: options.changeSummary }
      : { html, title: options.title || basename(filePath), ...(ttl ? { ttl_seconds: ttl } : {}) })
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`Upload failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
