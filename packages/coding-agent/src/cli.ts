#!/usr/bin/env bun
import { isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";
import { runCliEntry } from "./cli-runtime";

// Windows compiled entries and worker re-entry may report import.meta.main false.
// Imported dispatchers never execute this admission logic.
const args = process.argv.slice(2);
if (import.meta.main || process.env.PI_COMPILED === "true" || (!Bun.isMainThread && isWorkerHostSelector(args[0]))) {
	runCliEntry(args);
}
