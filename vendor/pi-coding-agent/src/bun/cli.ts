#!/usr/bin/env node
import { registerBunOAuthFlows } from "../../../pi-ai/src/bun-oauth.ts";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

registerBunOAuthFlows();

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

await import("./register-bedrock.ts");
await import("../cli.ts");
