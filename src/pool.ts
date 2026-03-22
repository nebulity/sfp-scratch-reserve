import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { appendFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

interface ActionOptions {
  poolTag: string;
  devhubAlias: string;
  fetchAttempts: number;
  fetchRetrySeconds: number;
  scratchAlias: string;
  setDefaultTargetOrg: boolean;
  setDefaultDevHub: boolean;
}

interface CommandResult {
  status: number;
  output: string;
}

function fail(message: string): never {
  console.error(`::error::${message}`);
  throw new Error(message);
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resolveInputEnvKeys(name: string): string[] {
  const canonical = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const underscoreVariant = canonical.replace(/-/g, "_");

  if (underscoreVariant === canonical) {
    return [canonical];
  }

  return [canonical, underscoreVariant];
}

function getInput(name: string, fallbackValue = ""): string {
  for (const key of resolveInputEnvKeys(name)) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return fallbackValue;
}

export function parsePositiveInteger(raw: string, inputName: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Input "${inputName}" must be a positive integer. Received "${raw}".`);
  }

  return parsed;
}

export function parseRequiredString(raw: string, inputName: string): string {
  const value = raw.trim();
  if (value.length === 0) {
    fail(`Input "${inputName}" is required.`);
  }

  return value;
}

export function parseBooleanInput(raw: string, inputName: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  fail(`Input "${inputName}" must be either "true" or "false". Received "${raw}".`);
}

export function parseJsonObjectFromOutput(output: string): JsonObject | null {
  const lines = output.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("{")) {
      continue;
    }

    const candidate = lines.slice(i).join("\n").trim();
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Continue scanning in case logs precede valid JSON.
    }
  }

  return null;
}

export function extractScratchUsername(output: string): string | null {
  const parsed = parseJsonObjectFromOutput(output);
  if (!parsed) {
    return null;
  }

  const username = parsed.username;
  if (typeof username === "string" && username.trim().length > 0) {
    return username.trim();
  }

  const nested = parsed.result;
  if (isRecord(nested)) {
    const nestedUsername = nested.username;
    if (typeof nestedUsername === "string" && nestedUsername.trim().length > 0) {
      return nestedUsername.trim();
    }
  }

  return null;
}

export function isSfpPoolCommandUnavailable(output: string): boolean {
  return (
    /is not a sf command/i.test(output) ||
    /CLIError:\s*command\s+[^\n]+?\s+not found/i.test(output) ||
    /\bcommand\s+[^\n]+?\s+not found\b/i.test(output)
  );
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    fail(`Missing required environment variable: ${name}`);
  }

  return value;
}

function appendEnvironmentFile(filePath: string, line: string): void {
  appendFileSync(filePath, `${line}\n`, "utf8");
}

function setOutput(name: string, value: string): void {
  const outputPath = requireEnv("GITHUB_OUTPUT");
  appendEnvironmentFile(outputPath, `${name}=${value}`);
}

function setState(name: string, value: string): void {
  const statePath = requireEnv("GITHUB_STATE");
  appendEnvironmentFile(statePath, `${name}=${value}`);
}

function runCommandAllowFailure(
  command: string,
  args: string[],
  captureOutput = false,
  stdin = "",
): CommandResult {
  const hasStdinInput = stdin.length > 0;
  let stdio: SpawnSyncOptions["stdio"];

  if (captureOutput) {
    stdio = "pipe";
  } else if (hasStdinInput) {
    stdio = ["pipe", "inherit", "inherit"];
  } else {
    stdio = "inherit";
  }

  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio,
    input: hasStdinInput ? stdin : undefined,
  });

  if (result.error) {
    fail(result.error.message);
  }

  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function runCommand(command: string, args: string[], captureOutput = false, stdin = ""): string {
  const result = runCommandAllowFailure(command, args, captureOutput, stdin);

  if (result.status !== 0) {
    if (captureOutput && result.output.trim().length > 0) {
      console.error(result.output);
    }
    fail(`Command failed (${result.status}): ${command} ${args.join(" ")}`);
  }

  return result.output;
}

function authenticateDevHubIfNeeded(options: ActionOptions): void {
  const sfdxAuthUrl = getInput("devhub-sfdx-auth-url", "");
  if (!sfdxAuthUrl) {
    return;
  }

  const probe = runCommandAllowFailure("sf", buildDevHubProbeArgs(options.devhubAlias), true);
  if (probe.status === 0) {
    if (options.devhubAlias) {
      console.log(
        `Dev Hub alias "${options.devhubAlias}" is already authenticated. Skipping login.`,
      );
    } else {
      console.log("Default Dev Hub context is already authenticated. Skipping login.");
    }
    return;
  }

  if (options.devhubAlias) {
    console.log(`Authenticating Dev Hub alias "${options.devhubAlias}" from action input...`);
  } else {
    console.log("Authenticating Dev Hub from action input without explicit alias...");
  }

  runCommand(
    "sf",
    buildDevHubLoginArgs(options.devhubAlias, options.setDefaultDevHub),
    false,
    `${sfdxAuthUrl}\n`,
  );
}

function escapeSingleQuotes(raw: string): string {
  return raw.replace(/'/g, "\\'");
}

function releaseAllocationStatus(devhubAlias: string, username: string): void {
  const escapedUsername = escapeSingleQuotes(username);
  runCommand("sf", buildScratchOrgUpdateArgs(devhubAlias, escapedUsername, "Return"));
}

async function reservePooledScratchOrg(options: ActionOptions): Promise<string> {
  const sfpCommand = resolveSfpCommand();

  for (let attempt = 1; attempt <= options.fetchAttempts; attempt += 1) {
    console.log(`Pool fetch attempt ${attempt}/${options.fetchAttempts}...`);

    const result = runCommandAllowFailure(
      sfpCommand,
      buildPoolFetchArgs(options.poolTag, options.devhubAlias),
      true,
    );

    if (isSfpPoolCommandUnavailable(result.output)) {
      fail(`sfp pool command is unavailable for pool "${options.poolTag}".`);
    }

    if (result.status === 0) {
      const scratchUsername = extractScratchUsername(result.output);
      if (scratchUsername) {
        console.log(`Fetched pooled scratch org: ${scratchUsername}`);
        return scratchUsername;
      }
    } else {
      console.log(result.output.trim());
    }

    if (attempt < options.fetchAttempts) {
      console.log(
        `No pooled scratch org available yet. Waiting ${options.fetchRetrySeconds}s before retry.`,
      );
      await sleep(options.fetchRetrySeconds);
    }
  }

  fail(
    `Timed out after ${options.fetchAttempts * options.fetchRetrySeconds} seconds waiting for an available scratch org in pool "${options.poolTag}".`,
  );
}

function getState(name: string): string {
  const key = `STATE_${name.replace(/-/g, "_").toUpperCase()}`;
  const value = process.env[key];
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function readActionOptions(): ActionOptions {
  const poolTag = parseRequiredString(getInput("pool-tag", ""), "pool-tag");
  const devhubAlias = getInput("devhub-alias", "");
  const fetchAttempts = parsePositiveInteger(getInput("fetch-attempts", "30"), "fetch-attempts");
  const fetchRetrySeconds = parsePositiveInteger(
    getInput("fetch-retry-seconds", "60"),
    "fetch-retry-seconds",
  );
  const scratchAlias = getInput("scratch-alias", "scratch");
  const setDefaultTargetOrg = parseBooleanInput(
    getInput("set-default-target-org", "true"),
    "set-default-target-org",
  );
  const setDefaultDevHub = parseBooleanInput(
    getInput("set-default-devhub", "false"),
    "set-default-devhub",
  );

  return {
    poolTag,
    devhubAlias,
    fetchAttempts,
    fetchRetrySeconds,
    scratchAlias,
    setDefaultTargetOrg,
    setDefaultDevHub,
  };
}

function configureScratchAliasAndDefaultTargetOrg(
  options: ActionOptions,
  scratchUsername: string,
): string {
  const normalizedAlias = options.scratchAlias.trim();
  const targetOrgValue = normalizedAlias.length > 0 ? normalizedAlias : scratchUsername;

  if (normalizedAlias.length > 0) {
    runCommand("sf", ["alias", "set", `${normalizedAlias}=${scratchUsername}`]);
  }

  if (options.setDefaultTargetOrg) {
    runCommand("sf", ["config", "set", `target-org=${targetOrgValue}`]);
  }

  return targetOrgValue;
}

export async function runMain(): Promise<void> {
  const options = readActionOptions();
  authenticateDevHubIfNeeded(options);
  const scratchUsername = await reservePooledScratchOrg(options);
  const targetOrgValue = configureScratchAliasAndDefaultTargetOrg(options, scratchUsername);
  setOutput("scratch-username", scratchUsername);
  setOutput("scratch-alias", targetOrgValue);
  setState("scratch-username", scratchUsername);
  setState("devhub-alias", options.devhubAlias);
}

export function runPost(): void {
  const scratchUsername = getState("scratch-username");
  if (!scratchUsername) {
    console.log("No reserved scratch org found in state. Skipping pool release.");
    return;
  }

  const devhubAlias = getState("devhub-alias") || getInput("devhub-alias", "");
  console.log(`Returning scratch org to pool: ${scratchUsername}`);
  releaseAllocationStatus(devhubAlias, scratchUsername);
}

export function buildPoolFetchArgs(poolTag: string, devhubAlias: string): string[] {
  const args = ["pool", "fetch", "-t", poolTag];
  if (devhubAlias) {
    args.push("-v", devhubAlias);
  }
  args.push("--json");
  return args;
}

export function buildScratchOrgUpdateArgs(
  devhubAlias: string,
  escapedUsername: string,
  statusValue: string,
): string[] {
  const args = ["data", "update", "record"];
  if (devhubAlias) {
    args.push("--target-org", devhubAlias);
  }
  args.push("--sobject", "ScratchOrgInfo", "--where", `SignupUsername='${escapedUsername}'`);
  args.push("--values", `Allocation_status__c='${statusValue}'`);
  return args;
}

export function buildDevHubProbeArgs(devhubAlias: string): string[] {
  if (devhubAlias) {
    return ["org", "display", "--target-org", devhubAlias, "--json"];
  }

  return ["org", "display", "--target-dev-hub", "--json"];
}

export function buildDevHubLoginArgs(devhubAlias: string, setDefaultDevHub: boolean): string[] {
  const args = ["org", "login", "sfdx-url"];
  if (devhubAlias) {
    args.push("--alias", devhubAlias);
  }
  if (setDefaultDevHub) {
    args.push("--set-default-dev-hub");
  }
  args.push("--sfdx-url-stdin");
  return args;
}

export function resolveSfpCommand(): string {
  return "sfp";
}
