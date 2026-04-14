import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Salesforce REST API version used for query + atomic claim.
const API_VERSION = "v59.0";

// --- GitHub Actions helpers ---

function getInput(name: string, fallback = ""): string {
  const value = process.env[`INPUT_${name.toUpperCase()}`];
  return value?.trim() || fallback;
}

function getState(name: string): string {
  return process.env[`STATE_${name}`]?.trim() ?? "";
}

function setState(name: string, value: string): void {
  appendFileSync(process.env.GITHUB_STATE!, `${name}=${value}\n`, "utf8");
}

function setOutput(name: string, value: string): void {
  appendFileSync(process.env.GITHUB_OUTPUT!, `${name}=${value}\n`, "utf8");
}

function fail(message: string): never {
  console.error(`::error::${message}`);
  throw new Error(message);
}

// --- Command execution ---

interface ExecResult {
  status: number;
  output: string;
}

function exec(command: string, args: string[], input?: string): ExecResult {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: input === undefined ? "pipe" : ["pipe", "pipe", "pipe"],
    input,
  });

  if (result.error) {
    fail(result.error.message);
  }

  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// --- Exported pure helpers (testable) ---

export interface DevHubAuth {
  accessToken: string;
  instanceUrl: string;
  username: string;
}

export interface ScratchOrgCandidate {
  Id: string;
  SignupUsername: string;
  LastModifiedDate: string;
  SfdxAuthUrl__c: string | null;
  Password__c: string | null;
  ExpirationDate: string;
}

export function parseDevHubAuth(output: string): DevHubAuth {
  const parsed = JSON.parse(output) as {
    result?: { accessToken?: string; instanceUrl?: string; username?: string };
  };
  const result = parsed?.result ?? {};
  const { accessToken, instanceUrl, username } = result;
  if (!accessToken || !instanceUrl || !username) {
    throw new Error(
      `sf org display did not return accessToken/instanceUrl/username. Got: ${JSON.stringify(result)}`,
    );
  }
  return { accessToken, instanceUrl, username };
}

export function buildAvailableOrgsSoql(poolTag: string, limit = 10): string {
  const escaped = poolTag.replace(/'/g, "\\'");
  return (
    "SELECT Id, SignupUsername, LastModifiedDate, SfdxAuthUrl__c, Password__c, ExpirationDate " +
    "FROM ScratchOrgInfo " +
    `WHERE Allocation_status__c = 'Available' AND Pooltag__c = '${escaped}' AND Status = 'Active' ` +
    `ORDER BY CreatedDate LIMIT ${limit}`
  );
}

export function buildQueryUrl(instanceUrl: string, soql: string): string {
  return `${stripTrailingSlash(instanceUrl)}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
}

export function buildClaimUrl(instanceUrl: string, recordId: string): string {
  return `${stripTrailingSlash(instanceUrl)}/services/data/${API_VERSION}/sobjects/ScratchOrgInfo/${recordId}`;
}

export function toHttpDate(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid LastModifiedDate: ${isoString}`);
  }
  return date.toUTCString();
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function buildReleaseArgs(devhubAlias: string, username: string): string[] {
  const args = ["data", "update", "record"];
  if (devhubAlias) args.push("--target-org", devhubAlias);
  args.push(
    "--sobject",
    "ScratchOrgInfo",
    "--where",
    `SignupUsername='${username.replace(/'/g, "\\'")}'`,
    "--values",
    "Allocation_status__c='Available'",
  );
  return args;
}

// --- Claim helpers ---

type ClaimOutcome = "won" | "raced" | "error";

async function getDevHubAuth(alias: string): Promise<DevHubAuth> {
  const args = ["org", "display", "--verbose", "--json"];
  if (alias) args.push("--target-org", alias);
  const result = exec("sf", args);
  if (result.status !== 0) {
    fail(`sf org display failed (exit ${result.status}): ${result.output.trim()}`);
  }
  return parseDevHubAuth(result.output);
}

async function queryAvailableOrgs(
  auth: DevHubAuth,
  poolTag: string,
): Promise<ScratchOrgCandidate[]> {
  const soql = buildAvailableOrgsSoql(poolTag);
  const url = buildQueryUrl(auth.instanceUrl, soql);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Query failed (${res.status}): ${body}`);
  }
  const body = (await res.json()) as { records?: ScratchOrgCandidate[] };
  return body.records ?? [];
}

async function attemptClaim(
  auth: DevHubAuth,
  candidate: ScratchOrgCandidate,
): Promise<ClaimOutcome> {
  const url = buildClaimUrl(auth.instanceUrl, candidate.Id);
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "Content-Type": "application/json",
      "If-Unmodified-Since": toHttpDate(candidate.LastModifiedDate),
    },
    body: JSON.stringify({ Allocation_status__c: "Allocate" }),
  });
  if (res.status === 204) return "won";
  if (res.status === 412) return "raced";
  const text = await res.text();
  console.log(`PATCH ${candidate.Id} returned ${res.status}: ${text.trim()}`);
  return "error";
}

function loginToScratch(authUrl: string | null, alias: string, setDefault: boolean): void {
  if (!authUrl) fail("Won scratch org has no SfdxAuthUrl__c; cannot authenticate.");
  const args = ["org", "login", "sfdx-url", "--sfdx-url-stdin"];
  if (alias) args.push("--alias", alias);
  if (setDefault) args.push("--set-default");
  const result = exec("sf", args, `${authUrl}\n`);
  if (result.status !== 0) {
    fail(`sf org login sfdx-url failed (exit ${result.status}): ${result.output.trim()}`);
  }
}

// --- Main / Post entry points ---

export async function runMain(): Promise<void> {
  const poolTag = getInput("pool-tag");
  if (!poolTag) fail('Input "pool-tag" is required.');

  const devhubAlias = getInput("devhub-alias");
  const scratchAlias = getInput("scratch-alias", "scratch");
  const setDefaultTargetOrg = getInput("set-default-target-org", "true") === "true";
  const maxAttempts = Math.max(1, parseInt(getInput("fetch-attempts", "1"), 10) || 1);

  const auth = await getDevHubAuth(devhubAlias);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`Atomic claim attempt ${attempt}/${maxAttempts} on pool "${poolTag}"...`);

    const candidates = shuffle(await queryAvailableOrgs(auth, poolTag));
    if (candidates.length === 0) {
      console.log(`No Available orgs in pool "${poolTag}".`);
    } else {
      console.log(`Found ${candidates.length} Available candidate(s); attempting atomic claim.`);
      for (const candidate of candidates) {
        const outcome = await attemptClaim(auth, candidate);
        if (outcome === "won") {
          console.log(
            `Atomically claimed scratch org: ${candidate.SignupUsername} (Id=${candidate.Id})`,
          );
          loginToScratch(candidate.SfdxAuthUrl__c, scratchAlias, setDefaultTargetOrg);
          setOutput("scratch-username", candidate.SignupUsername);
          setOutput("scratch-alias", scratchAlias || candidate.SignupUsername);
          setState("scratch-username", candidate.SignupUsername);
          setState("devhub-alias", devhubAlias);
          return;
        }
        if (outcome === "raced") {
          console.log(
            `Raced on ${candidate.SignupUsername} (If-Unmodified-Since 412); trying next candidate.`,
          );
          continue;
        }
      }
    }

    if (attempt < maxAttempts) {
      console.log("No claim won. Waiting 60s before retry.");
      await sleep(60);
    }
  }

  fail(`No available scratch org in pool "${poolTag}" after ${maxAttempts} attempt(s).`);
}

export function runPost(): void {
  const username = getState("scratch-username");
  if (!username) {
    console.log("No reserved scratch org found in state. Skipping pool release.");
    return;
  }

  const devhubAlias = getState("devhub-alias") || getInput("devhub-alias");
  console.log(`Returning scratch org to pool: ${username}`);

  const result = exec("sf", buildReleaseArgs(devhubAlias, username));
  if (result.status !== 0) {
    console.error(result.output);
    fail(`Failed to release scratch org: ${username}`);
  }
}
