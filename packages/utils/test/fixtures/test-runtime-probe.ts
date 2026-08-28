import { isBunTestRuntime } from "@chudware/utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
