"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDevHubAuth = parseDevHubAuth;
exports.buildAvailableOrgsSoql = buildAvailableOrgsSoql;
exports.buildQueryUrl = buildQueryUrl;
exports.buildClaimUrl = buildClaimUrl;
exports.toHttpDate = toHttpDate;
exports.shuffle = shuffle;
exports.buildReleaseArgs = buildReleaseArgs;
exports.runMain = runMain;
exports.runPost = runPost;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
// Salesforce REST API version used for query + atomic claim.
const API_VERSION = "v59.0";
// --- GitHub Actions helpers ---
function getInput(name, fallback = "") {
    const value = process.env[`INPUT_${name.toUpperCase()}`];
    return value?.trim() || fallback;
}
function getState(name) {
    return process.env[`STATE_${name}`]?.trim() ?? "";
}
function setState(name, value) {
    (0, node_fs_1.appendFileSync)(process.env.GITHUB_STATE, `${name}=${value}\n`, "utf8");
}
function setOutput(name, value) {
    (0, node_fs_1.appendFileSync)(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}
function fail(message) {
    console.error(`::error::${message}`);
    throw new Error(message);
}
function exec(command, args, input) {
    console.log(`$ ${command} ${args.join(" ")}`);
    const result = (0, node_child_process_1.spawnSync)(command, args, {
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
function sleep(seconds) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
function parseDevHubAuth(output) {
    const parsed = JSON.parse(output);
    const result = parsed?.result ?? {};
    const { accessToken, instanceUrl, username } = result;
    if (!accessToken || !instanceUrl || !username) {
        throw new Error(`sf org display did not return accessToken/instanceUrl/username. Got: ${JSON.stringify(result)}`);
    }
    return { accessToken, instanceUrl, username };
}
function buildAvailableOrgsSoql(poolTag, limit = 10) {
    const escaped = poolTag.replace(/'/g, "\\'");
    return ("SELECT Id, SignupUsername, LastModifiedDate, SfdxAuthUrl__c, Password__c, ExpirationDate " +
        "FROM ScratchOrgInfo " +
        `WHERE Allocation_status__c = 'Available' AND Pooltag__c = '${escaped}' AND Status = 'Active' ` +
        `ORDER BY CreatedDate LIMIT ${limit}`);
}
function buildQueryUrl(instanceUrl, soql) {
    return `${stripTrailingSlash(instanceUrl)}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
}
function buildClaimUrl(instanceUrl, recordId) {
    return `${stripTrailingSlash(instanceUrl)}/services/data/${API_VERSION}/sobjects/ScratchOrgInfo/${recordId}`;
}
function toHttpDate(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid LastModifiedDate: ${isoString}`);
    }
    return date.toUTCString();
}
function stripTrailingSlash(url) {
    return url.endsWith("/") ? url.slice(0, -1) : url;
}
function shuffle(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
function buildReleaseArgs(devhubAlias, username) {
    const args = ["data", "update", "record"];
    if (devhubAlias)
        args.push("--target-org", devhubAlias);
    args.push("--sobject", "ScratchOrgInfo", "--where", `SignupUsername='${username.replace(/'/g, "\\'")}'`, "--values", "Allocation_status__c='Available'");
    return args;
}
async function getDevHubAuth(alias) {
    const args = ["org", "display", "--verbose", "--json"];
    if (alias)
        args.push("--target-org", alias);
    const result = exec("sf", args);
    if (result.status !== 0) {
        fail(`sf org display failed (exit ${result.status}): ${result.output.trim()}`);
    }
    return parseDevHubAuth(result.output);
}
async function queryAvailableOrgs(auth, poolTag) {
    const soql = buildAvailableOrgsSoql(poolTag);
    const url = buildQueryUrl(auth.instanceUrl, soql);
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Query failed (${res.status}): ${body}`);
    }
    const body = (await res.json());
    return body.records ?? [];
}
async function attemptClaim(auth, candidate) {
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
    if (res.status === 204)
        return "won";
    if (res.status === 412)
        return "raced";
    const text = await res.text();
    console.log(`PATCH ${candidate.Id} returned ${res.status}: ${text.trim()}`);
    return "error";
}
function loginToScratch(authUrl, alias, setDefault) {
    if (!authUrl)
        fail("Won scratch org has no SfdxAuthUrl__c; cannot authenticate.");
    const args = ["org", "login", "sfdx-url", "--sfdx-url-stdin"];
    if (alias)
        args.push("--alias", alias);
    if (setDefault)
        args.push("--set-default");
    const result = exec("sf", args, `${authUrl}\n`);
    if (result.status !== 0) {
        fail(`sf org login sfdx-url failed (exit ${result.status}): ${result.output.trim()}`);
    }
}
// --- Main / Post entry points ---
async function runMain() {
    const poolTag = getInput("pool-tag");
    if (!poolTag)
        fail('Input "pool-tag" is required.');
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
        }
        else {
            console.log(`Found ${candidates.length} Available candidate(s); attempting atomic claim.`);
            for (const candidate of candidates) {
                const outcome = await attemptClaim(auth, candidate);
                if (outcome === "won") {
                    console.log(`Atomically claimed scratch org: ${candidate.SignupUsername} (Id=${candidate.Id})`);
                    loginToScratch(candidate.SfdxAuthUrl__c, scratchAlias, setDefaultTargetOrg);
                    setOutput("scratch-username", candidate.SignupUsername);
                    setOutput("scratch-alias", scratchAlias || candidate.SignupUsername);
                    setState("scratch-username", candidate.SignupUsername);
                    setState("devhub-alias", devhubAlias);
                    return;
                }
                if (outcome === "raced") {
                    console.log(`Raced on ${candidate.SignupUsername} (If-Unmodified-Since 412); trying next candidate.`);
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
function runPost() {
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
