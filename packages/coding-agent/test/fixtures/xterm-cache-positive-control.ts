import { statSync } from "node:fs";
import "@chudware/utils/vterm";

const paths = Object.keys(require.cache)
	.filter(modulePath => modulePath.replaceAll("\\", "/").includes("/packages/utils/src/vterm"))
	.sort();
const bytes = paths.reduce((total, modulePath) => total + statSync(modulePath).size, 0);
const memory = process.memoryUsage();
process.stdout.write(
	JSON.stringify({ modules: paths.length, bytes, rss: memory.rss, heapUsed: memory.heapUsed, paths }),
);
