"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pool_1 = require("./pool");
try {
    (0, pool_1.runPost)();
}
catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exit(1);
}
