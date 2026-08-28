declare module "@chudware/coding-agent/secrets" {
	export function buildSecretObfuscator(
		cwd: string,
		agentDir: string,
		keyDir?: string,
	): Promise<{ obfuscate(text: string): string } | undefined>;
}
