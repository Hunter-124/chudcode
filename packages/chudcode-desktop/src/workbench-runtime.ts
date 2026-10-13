import { register } from "@oh-my-pi/pi-utils/postmortem";
import { DESKTOP_PROTOCOL_VERSION } from "./protocol";
import { createDesktopRuntime } from "./runtime";
import { type DesktopRuntimeHost, type DesktopServerHandle, startDesktopServer } from "./server";
import { ServiceRouter } from "./service-router";

/** Run the real desktop services for the lifetime of the owning stdin pipe. */
export async function runWorkbenchRuntime(workspace: string, writeReady: (line: string) => void): Promise<void> {
	let ownerDisconnected = false;
	const { promise: disconnected, resolve } = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	const disconnectOwner = (): void => {
		ownerDisconnected = true;
		resolve();
	};
	const unregister = register(
		"workbench-service",
		() => {
			disconnectOwner();
			return finished.promise;
		},
		{ exitOnly: true },
	);
	process.stdin.once("end", disconnectOwner);
	process.stdin.once("close", disconnectOwner);
	process.stdin.once("error", disconnectOwner);
	process.stdout.once("error", disconnectOwner);
	process.stdin.resume();
	if (process.stdin.readableEnded || process.stdin.destroyed) disconnectOwner();

	let runtime: DesktopRuntimeHost | undefined;
	let server: DesktopServerHandle | undefined;
	try {
		if (ownerDisconnected) return;
		runtime = await createDesktopRuntime({ cwd: workspace });
		if (ownerDisconnected) return;
		const services = new ServiceRouter({ runtime });
		runtime = services;
		await services.openWorkspace(workspace);
		if (ownerDisconnected) return;
		server = await startDesktopServer({
			cwd: workspace,
			runtime: services,
			port: 0,
			singleInstance: false,
			websocketOnly: true,
		});
		if (ownerDisconnected) return;
		writeReady(
			`${JSON.stringify({
				type: "ready",
				protocol: DESKTOP_PROTOCOL_VERSION,
				url: server.url,
				wsUrl: `${server.url.replace("http:", "ws:")}/ws`,
				token: server.token,
			})}\n`,
		);
		await disconnected;
	} finally {
		try {
			if (server) await server.stop();
			else await runtime?.dispose();
		} finally {
			process.stdin.pause();
			process.stdin.removeListener("end", disconnectOwner);
			process.stdin.removeListener("close", disconnectOwner);
			process.stdin.removeListener("error", disconnectOwner);
			process.stdout.removeListener("error", disconnectOwner);
			unregister();
			finished.resolve();
		}
	}
}
