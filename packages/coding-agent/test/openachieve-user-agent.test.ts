import { describe, expect, it } from "vitest";
import { getOpenachieveUserAgent } from "../src/utils/openachieve-user-agent.ts";

describe("getOpenachieveUserAgent", () => {
	it("formats the Openachieve user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getOpenachieveUserAgent("1.2.3");

		expect(userAgent).toBe(`oa/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^oa\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
