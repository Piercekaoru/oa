import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

const originalLatestVersionUrl = process.env.OPENACHIEVE_LATEST_VERSION_URL;
const originalSkipVersionCheck = process.env.OPENACHIEVE_SKIP_VERSION_CHECK;
const originalOffline = process.env.OPENACHIEVE_OFFLINE;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalLatestVersionUrl === undefined) {
		delete process.env.OPENACHIEVE_LATEST_VERSION_URL;
	} else {
		process.env.OPENACHIEVE_LATEST_VERSION_URL = originalLatestVersionUrl;
	}
	if (originalSkipVersionCheck === undefined) {
		delete process.env.OPENACHIEVE_SKIP_VERSION_CHECK;
	} else {
		process.env.OPENACHIEVE_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.OPENACHIEVE_OFFLINE;
	} else {
		process.env.OPENACHIEVE_OFFLINE = originalOffline;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		process.env.OPENACHIEVE_LATEST_VERSION_URL = "https://updates.openachieve.example/latest-version";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("skips version checks by default when no Openachieve endpoint is configured", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses the configured Openachieve version check api with an oa user agent", async () => {
		process.env.OPENACHIEVE_LATEST_VERSION_URL = "https://updates.openachieve.example/latest-version";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://updates.openachieve.example/latest-version",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^oa\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the active package metadata from the version check api", async () => {
		process.env.OPENACHIEVE_LATEST_VERSION_URL = "https://updates.openachieve.example/latest-version";
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@openachieve/agent",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: "@openachieve/agent",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		process.env.OPENACHIEVE_LATEST_VERSION_URL = "https://updates.openachieve.example/latest-version";
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.OPENACHIEVE_LATEST_VERSION_URL = "https://updates.openachieve.example/latest-version";
		process.env.OPENACHIEVE_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
