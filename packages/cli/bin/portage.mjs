#!/usr/bin/env node
// Runs the TypeScript CLI through tsx, so the repo works straight after `npm install` with no build step.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
