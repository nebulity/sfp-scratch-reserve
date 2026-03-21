import { runMain } from "./pool";

runMain().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::${message}`);
  process.exit(1);
});
