import { ENV_TELEMETRY, getInstallTelemetryUrl } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env[ENV_TELEMETRY],
): boolean {
	const hasTelemetryEndpoint = Boolean(getInstallTelemetryUrl());
	if (!hasTelemetryEndpoint) {
		return false;
	}
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
