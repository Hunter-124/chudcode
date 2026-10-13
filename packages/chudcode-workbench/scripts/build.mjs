import * as esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
await fs.mkdir(path.join(dist, "webview"), { recursive: true });
await fs.writeFile(
	path.join(dist, "chudcode.svg"),
	'<svg xmlns="http://www.w3.org/2000/svg" width="50" height="40" viewBox="0 0 50 40"><path fill="#d7dae0" d="M13 8h24v19H24l-7 6v-6h-4V8zm2 2v15h4v4l4-4h12V10H15zm4 5h12v2H19v-2zm0 5h9v2h-9v-2z"/></svg>\n',
);
await Promise.all([
	esbuild.build({
		absWorkingDir: root,
		entryPoints: ["src/extension.ts"],
		outfile: "dist/extension.cjs",
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node22",
		external: ["vscode", "bufferutil", "utf-8-validate"],
		sourcemap: false,
		legalComments: "eof",
		logLevel: "info",
	}),
	esbuild.build({
		absWorkingDir: root,
		entryPoints: ["src/webview/index.tsx"],
		outfile: "dist/webview/index.js",
		bundle: true,
		platform: "browser",
		format: "iife",
		target: "chrome130",
		jsx: "automatic",
		define: { "process.env.NODE_ENV": '"production"' },
		loader: {
			".md": "text",
			".txt": "text",
			".woff": "dataurl",
			".woff2": "dataurl",
			".ttf": "dataurl",
			".otf": "dataurl",
			".svg": "dataurl",
			".png": "dataurl",
			".gif": "dataurl",
			".jpg": "dataurl",
			".jpeg": "dataurl",
			".webp": "dataurl",
		},
		sourcemap: false,
		minify: true,
		legalComments: "eof",
		logLevel: "info",
	}),
]);
// The packager consumes only this self-contained manifest and dist tree.
await fs.access(path.join(dist, "extension.cjs"));
await fs.access(path.join(dist, "webview", "index.js"));
await fs.access(path.join(dist, "webview", "index.css"));
