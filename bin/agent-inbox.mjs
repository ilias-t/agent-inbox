#!/usr/bin/env node
// agent-inbox CLI. Logic lives in cli/; see `agent-inbox help` and README.
import { main } from "../cli/main.mjs";

process.exitCode = await main(process.argv.slice(2));
