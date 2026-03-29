"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractScratchUsername = extractScratchUsername;
exports.buildPoolFetchArgs = buildPoolFetchArgs;
exports.buildReleaseArgs = buildReleaseArgs;
exports.runMain = runMain;
exports.runPost = runPost;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
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
function exec(command, args) {
    console.log(`$ ${command} ${args.join(" ")}`);
    const result = (0, node_child_process_1.spawnSync)(command, args, { encoding: "utf8", stdio: "pipe" });
    if (result.error) {
        fail(result.error.message);
    }
    return {
        status: result.status ?? 1,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
}
// --- Exported pure functions (testable) ---
function extractScratchUsername(output) {
    try {
        const parsed = JSON.parse(output);
        const username = parsed?.username ?? parsed?.result?.username;
        return typeof username === "string" && username.trim() ? username.trim() : null;
    }
    catch {
        return null;
    }
}
function buildPoolFetchArgs(poolTag, devhubAlias, scratchAlias, setDefaultTargetOrg) {
    const args = ["pool", "fetch", "-t", poolTag];
    if (devhubAlias)
        args.push("-v", devhubAlias);
    if (scratchAlias)
        args.push("-a", scratchAlias);
    if (setDefaultTargetOrg)
        args.push("-d");
    args.push("--json");
    return args;
}
function buildReleaseArgs(devhubAlias, username) {
    const args = ["data", "update", "record"];
    if (devhubAlias)
        args.push("--target-org", devhubAlias);
    args.push("--sobject", "ScratchOrgInfo", "--where", `SignupUsername='${username.replace(/'/g, "\\'")}'`, "--values", "Allocation_status__c='Available'");
    return args;
}
// --- Main / Post entry points ---
function sleep(seconds) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
async function runMain() {
    const poolTag = getInput("pool-tag");
    if (!poolTag)
        fail('Input "pool-tag" is required.');
    const devhubAlias = getInput("devhub-alias");
    const scratchAlias = getInput("scratch-alias", "scratch");
    const setDefaultTargetOrg = getInput("set-default-target-org", "true") === "true";
    const maxAttempts = Math.max(1, parseInt(getInput("fetch-attempts", "1"), 10) || 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`Pool fetch attempt ${attempt}/${maxAttempts}...`);
        const result = exec("sfp", buildPoolFetchArgs(poolTag, devhubAlias, scratchAlias, setDefaultTargetOrg));
        if (result.status === 0) {
            const username = extractScratchUsername(result.output);
            if (username) {
                console.log(`Fetched pooled scratch org: ${username}`);
                const aliasOutput = scratchAlias || username;
                setOutput("scratch-username", username);
                setOutput("scratch-alias", aliasOutput);
                setState("scratch-username", username);
                setState("devhub-alias", devhubAlias);
                return;
            }
        }
        else {
            console.log(result.output.trim());
        }
        if (attempt < maxAttempts) {
            console.log("No pooled scratch org available yet. Waiting 60s before retry.");
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
