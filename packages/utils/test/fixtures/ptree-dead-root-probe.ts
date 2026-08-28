const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"], {
	stdin: "ignore",
	stdout: "inherit",
	stderr: "inherit",
	windowsHide: true,
});

process.stdout.write(`${child.pid}\n`);
process.exit(0);
