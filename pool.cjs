const { spawnSync } = require('node:child_process')
const { appendFileSync, existsSync } = require('node:fs')
const path = require('node:path')

function fail(message) {
    console.error(`::error::${message}`)
    throw new Error(message)
}

function resolveInputEnvKeys(name) {
    const canonical = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
    const underscoreVariant = canonical.replace(/-/g, '_')

    if (underscoreVariant === canonical) {
        return [canonical]
    }

    return [canonical, underscoreVariant]
}

function getInput(name, fallbackValue = '') {
    for (const key of resolveInputEnvKeys(name)) {
        const value = process.env[key]
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim()
        }
    }

    return fallbackValue
}

function parsePositiveInteger(raw, inputName) {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        fail(`Input "${inputName}" must be a positive integer. Received "${raw}".`)
    }

    return parsed
}

function parseRequiredString(raw, inputName) {
    const value = raw.trim()
    if (value.length === 0) {
        fail(`Input "${inputName}" is required.`)
    }

    return value
}

function parseBooleanInput(raw, inputName) {
    const normalized = raw.trim().toLowerCase()
    if (normalized === 'true') {
        return true
    }

    if (normalized === 'false') {
        return false
    }

    fail(`Input "${inputName}" must be either "true" or "false". Received "${raw}".`)
}

function parseJsonObjectFromOutput(output) {
    const lines = output.split(/\r?\n/)

    for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].trim().startsWith('{')) {
            continue
        }

        const candidate = lines.slice(i).join('\n').trim()
        try {
            const parsed = JSON.parse(candidate)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed
            }
        } catch {
            // Continue scanning in case logs precede valid JSON.
        }
    }

    return null
}

function extractScratchUsername(output) {
    const parsed = parseJsonObjectFromOutput(output)
    if (!parsed || typeof parsed !== 'object') {
        return null
    }

    if (typeof parsed.username === 'string' && parsed.username.trim().length > 0) {
        return parsed.username.trim()
    }

    if (parsed.result && typeof parsed.result === 'object' && !Array.isArray(parsed.result)) {
        const nested = parsed.result
        if (typeof nested.username === 'string' && nested.username.trim().length > 0) {
            return nested.username.trim()
        }
    }

    return null
}

function isSfpPoolCommandUnavailable(output) {
    return (
        /is not a sf command/i.test(output) ||
        /CLIError:\s*command\s+[^\n]+?\s+not found/i.test(output) ||
        /\bcommand\s+[^\n]+?\s+not found\b/i.test(output)
    )
}

function sleep(seconds) {
    return new Promise(resolve => {
        setTimeout(resolve, seconds * 1000)
    })
}

function requireEnv(name) {
    const value = process.env[name]
    if (!value) {
        fail(`Missing required environment variable: ${name}`)
    }

    return value
}

function appendEnvironmentFile(filePath, line) {
    appendFileSync(filePath, `${line}\n`, 'utf8')
}

function setOutput(name, value) {
    const outputPath = requireEnv('GITHUB_OUTPUT')
    appendEnvironmentFile(outputPath, `${name}=${value}`)
}

function setState(name, value) {
    const statePath = requireEnv('GITHUB_STATE')
    appendEnvironmentFile(statePath, `${name}=${value}`)
}

function runCommandAllowFailure(command, args, captureOutput = false, stdin = '') {
    const hasStdinInput = stdin.length > 0
    const stdio = captureOutput ? 'pipe' : hasStdinInput ? ['pipe', 'inherit', 'inherit'] : 'inherit'
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        stdio,
        input: hasStdinInput ? stdin : undefined
    })

    if (result.error) {
        fail(result.error.message)
    }

    return {
        status: result.status ?? 1,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`
    }
}

function runCommand(command, args, captureOutput = false, stdin = '') {
    const result = runCommandAllowFailure(command, args, captureOutput, stdin)

    if (result.status !== 0) {
        if (captureOutput && result.output.trim().length > 0) {
            console.error(result.output)
        }
        fail(`Command failed (${result.status}): ${command} ${args.join(' ')}`)
    }

    return result.output
}

function authenticateDevHubIfNeeded(options) {
    const sfdxAuthUrl = getInput('devhub-sfdx-auth-url', '')
    if (!sfdxAuthUrl) {
        return
    }

    const probe = runCommandAllowFailure('sf', buildDevHubProbeArgs(options.devhubAlias), true)
    if (probe.status === 0) {
        if (options.devhubAlias) {
            console.log(`Dev Hub alias "${options.devhubAlias}" is already authenticated. Skipping login.`)
        } else {
            console.log('Default Dev Hub context is already authenticated. Skipping login.')
        }
        return
    }

    if (options.devhubAlias) {
        console.log(`Authenticating Dev Hub alias "${options.devhubAlias}" from action input...`)
    } else {
        console.log('Authenticating Dev Hub from action input without explicit alias...')
    }

    runCommand('sf', buildDevHubLoginArgs(options.devhubAlias, options.setDefaultDevHub), false, `${sfdxAuthUrl}\n`)
}

function escapeSingleQuotes(raw) {
    return raw.replace(/'/g, "\\'")
}

function updateAllocationStatus(devhubAlias, username, action) {
    const statusValue = action === 'reserve' ? 'Reserve' : 'Return'
    const escapedUsername = escapeSingleQuotes(username)

    runCommand('sf', buildScratchOrgUpdateArgs(devhubAlias, escapedUsername, statusValue))
}

async function reservePooledScratchOrg(options) {
    const sfpCommand = resolveSfpCommand()

    for (let attempt = 1; attempt <= options.fetchAttempts; attempt += 1) {
        console.log(`Pool fetch attempt ${attempt}/${options.fetchAttempts}...`)

        const output = runCommand(sfpCommand, buildPoolFetchArgs(options.poolTag, options.devhubAlias), true)

        if (isSfpPoolCommandUnavailable(output)) {
            fail(`sfp pool command is unavailable for pool "${options.poolTag}".`)
        }

        const scratchUsername = extractScratchUsername(output)
        if (scratchUsername) {
            console.log(`Fetched pooled scratch org: ${scratchUsername}`)
            updateAllocationStatus(options.devhubAlias, scratchUsername, 'reserve')
            return scratchUsername
        }

        if (attempt < options.fetchAttempts) {
            console.log(`No pooled scratch org available yet. Waiting ${options.fetchRetrySeconds}s before retry.`)
            await sleep(options.fetchRetrySeconds)
        }
    }

    fail(
        `Timed out after ${options.fetchAttempts * options.fetchRetrySeconds} seconds waiting for an available scratch org in pool "${options.poolTag}".`
    )
}

function getState(name) {
    const key = `STATE_${name.replace(/-/g, '_').toUpperCase()}`
    const value = process.env[key]
    if (typeof value !== 'string') {
        return ''
    }

    return value.trim()
}

function readActionOptions() {
    const poolTag = parseRequiredString(getInput('pool-tag', ''), 'pool-tag')
    const devhubAlias = getInput('devhub-alias', '')
    const fetchAttempts = parsePositiveInteger(getInput('fetch-attempts', '30'), 'fetch-attempts')
    const fetchRetrySeconds = parsePositiveInteger(getInput('fetch-retry-seconds', '60'), 'fetch-retry-seconds')
    const scratchAlias = getInput('scratch-alias', 'scratch')
    const setDefaultTargetOrg = parseBooleanInput(getInput('set-default-target-org', 'true'), 'set-default-target-org')
    const setDefaultDevHub = parseBooleanInput(getInput('set-default-devhub', 'false'), 'set-default-devhub')

    return {
        poolTag,
        devhubAlias,
        fetchAttempts,
        fetchRetrySeconds,
        scratchAlias,
        setDefaultTargetOrg,
        setDefaultDevHub
    }
}

function configureScratchAliasAndDefaultTargetOrg(options, scratchUsername) {
    const normalizedAlias = options.scratchAlias.trim()
    const targetOrgValue = normalizedAlias.length > 0 ? normalizedAlias : scratchUsername

    if (normalizedAlias.length > 0) {
        runCommand('sf', ['alias', 'set', `${normalizedAlias}=${scratchUsername}`])
    }

    if (options.setDefaultTargetOrg) {
        runCommand('sf', ['config', 'set', `target-org=${targetOrgValue}`])
    }

    return targetOrgValue
}

async function runMain() {
    const options = readActionOptions()
    authenticateDevHubIfNeeded(options)
    const scratchUsername = await reservePooledScratchOrg(options)
    const targetOrgValue = configureScratchAliasAndDefaultTargetOrg(options, scratchUsername)
    setOutput('scratch-username', scratchUsername)
    setOutput('scratch-alias', targetOrgValue)
    setState('scratch-username', scratchUsername)
    setState('devhub-alias', options.devhubAlias)
}

function runPost() {
    const scratchUsername = getState('scratch-username')
    if (!scratchUsername) {
        console.log('No reserved scratch org found in state. Skipping pool release.')
        return
    }

    const devhubAlias = getState('devhub-alias') || getInput('devhub-alias', '')
    console.log(`Returning scratch org to pool: ${scratchUsername}`)
    updateAllocationStatus(devhubAlias, scratchUsername, 'release')
}

function buildPoolFetchArgs(poolTag, devhubAlias) {
    const args = ['pool:fetch', '-t', poolTag]
    if (devhubAlias) {
        args.push('-v', devhubAlias)
    }
    args.push('--json')
    return args
}

function buildScratchOrgUpdateArgs(devhubAlias, escapedUsername, statusValue) {
    const args = ['data', 'update', 'record']
    if (devhubAlias) {
        args.push('--target-org', devhubAlias)
    }
    args.push('--sobject', 'ScratchOrgInfo', '--where', `SignupUsername='${escapedUsername}'`)
    args.push('--values', `Allocation_status__c='${statusValue}'`)
    return args
}

function buildDevHubProbeArgs(devhubAlias) {
    if (devhubAlias) {
        return ['org', 'display', '--target-org', devhubAlias, '--json']
    }

    return ['org', 'display', '--target-dev-hub', '--json']
}

function buildDevHubLoginArgs(devhubAlias, setDefaultDevHub) {
    const args = ['org', 'login', 'sfdx-url']
    if (devhubAlias) {
        args.push('--alias', devhubAlias)
    }
    if (setDefaultDevHub) {
        args.push('--set-default-dev-hub')
    }
    args.push('--sfdx-url-stdin', '-')
    return args
}

function resolveSfpCommand() {
    const workspaceRoot = process.env.GITHUB_WORKSPACE?.trim()
    if (workspaceRoot) {
        const workspaceCommand = path.join(workspaceRoot, 'forks', 'sfp', 'bin', 'run')
        if (existsSync(workspaceCommand)) {
            return workspaceCommand
        }
    }

    return 'sfp'
}

module.exports = {
    buildDevHubLoginArgs,
    buildDevHubProbeArgs,
    buildPoolFetchArgs,
    buildScratchOrgUpdateArgs,
    extractScratchUsername,
    isSfpPoolCommandUnavailable,
    parseBooleanInput,
    parseRequiredString,
    parseJsonObjectFromOutput,
    parsePositiveInteger,
    resolveSfpCommand,
    resolveInputEnvKeys,
    runMain,
    runPost
}
