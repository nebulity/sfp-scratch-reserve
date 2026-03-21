"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pool_1 = require("./pool");
(0, pool_1.runMain)().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exit(1);
});
