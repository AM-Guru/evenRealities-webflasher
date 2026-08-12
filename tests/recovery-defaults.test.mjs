import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TEMPLE_FLASH_MODE,
  DEFAULT_TEMPLE_FLASH_ROUTE,
  findDefaultFirmwareRelease,
  findLatestCaseFirmwareRelease,
  findLatestOfficialStockRelease,
  firmwareReleaseDisplayName,
} from "../src/lib/recoveryDefaults.js";

test("defaults recovery to a complete bilateral temple restore", () => {
  assert.equal(DEFAULT_TEMPLE_FLASH_ROUTE, "both");
  assert.equal(DEFAULT_TEMPLE_FLASH_MODE, "complete");
});

test("selects the newest official Stock release independent of catalog order", () => {
  const releases = [
    {
      id: "cfw",
      channel: "custom",
      version: "2.2.6.11",
      caseRecoveryEligible: false,
    },
    {
      id: "stock-old",
      channel: "official",
      version: "2.2.4.34",
      caseRecoveryEligible: true,
    },
    {
      id: "stock-new",
      channel: "official",
      version: "2.2.6.10",
      caseRecoveryEligible: true,
    },
  ];
  assert.equal(findLatestOfficialStockRelease(releases)?.id, "stock-new");
});

test("defaults the firmware selector to the newest official Stock release", () => {
  const releases = [
    {
      id: "stock",
      channel: "official",
      trust: "official-pinned",
      version: "2.2.6.10",
      caseRecoveryEligible: true,
    },
    {
      id: "cfw-old",
      channel: "custom",
      trust: "reviewed-custom",
      version: "2.2.6.10",
      caseRecoveryEligible: false,
    },
    {
      id: "cfw-current",
      channel: "custom",
      trust: "reviewed-custom",
      version: "2.2.6.11",
      displayName: "Historical test firmware (2.2.6.11)",
      caseRecoveryEligible: false,
    },
  ];
  assert.equal(findDefaultFirmwareRelease(releases)?.id, "stock");
  assert.equal(
    firmwareReleaseDisplayName(findDefaultFirmwareRelease(releases)),
    "Stock · G2 2.2.6.10",
  );
});

test("selects the newest Case firmware before using glasses version as a tie-breaker", () => {
  const releases = [
    {
      id: "newer-glasses-older-case",
      channel: "official",
      version: "2.3.0.0",
      caseVersion: "1.2.56",
      caseRecoveryEligible: true,
    },
    {
      id: "older-glasses-newer-case",
      channel: "official",
      version: "2.2.6.10",
      caseVersion: "1.2.57",
      caseRecoveryEligible: true,
    },
    {
      id: "custom",
      channel: "custom",
      version: "9.9.9.9",
      caseVersion: "9.9.9",
      caseRecoveryEligible: false,
    },
  ];
  assert.equal(
    findLatestCaseFirmwareRelease(releases)?.id,
    "older-glasses-newer-case",
  );
});
