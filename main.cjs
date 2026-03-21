const { runMain } = require('./pool.cjs')

runMain().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`::error::${message}`)
    process.exit(1)
})
