const { runPost } = require('./pool.cjs')

try {
    runPost()
} catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`::error::${message}`)
    process.exit(1)
}
