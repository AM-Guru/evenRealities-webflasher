export const YHM_PROFILE_REVIEWED_22 = "reviewed-22";
export const YHM_PROFILE_OBSERVED_33 = "observed-33";
export const YHM_PROFILE_OBSERVED_45 = "observed-45";

export const YHM_REVIEWED_REGISTER_8 = 0x22;

const REVIEWED_22_BASELINES = Object.freeze([
  "811104afaf038d2022ff",
  "810004aeae03812022ff",
  "811104afaf03812022ff",
  "810104afae03812022ff",
  "811004aeaf03812022ff",
]);

// This list mirrors the five-slot baseline table baked into the pinned SRAM
// bridges byte-for-byte. An observed profile is derived from the reviewed
// build by patching the register-8 byte of entries 2-5 (the 0x8d entry 1 is
// never patched), so every derived table keeps entry 1 verbatim.
//
// Register 8 is a per-Case persistent YHM2510 identity byte, not a protocol
// byte: unrelated Cases have shipped 0x22, 0x33 (case 00240024514250032037384b,
// 2026-07-28), and 0x45 (case 001d00115845501820373941, 2026-07-28), each held
// constant through every settle attempt and bilateral reset while the charging
// bytes cycled normally. Profiles therefore verify the PROTOCOL - retained
// zero-write/zero-transmission proof plus an exact structural match of the
// other nine baseline bytes - and accept any register-8 value that proof
// produces. No profile is ever selected from a Case or Smart Glasses serial
// number; structural deviations in the other bytes remain fail-closed.

const OBSERVED_PROFILE_PATTERN = /^observed-([0-9a-f]{2})$/;

export function yhmObservedProfile(register8) {
  if (
    !Number.isInteger(register8) ||
    register8 < 0 ||
    register8 > 0xff ||
    register8 === YHM_REVIEWED_REGISTER_8
  ) {
    throw new Error(
      `An observed YHM profile needs a non-reviewed register-8 byte, not ${register8}.`,
    );
  }
  return `observed-${register8.toString(16).padStart(2, "0")}`;
}

export function yhmProfileRegister8(profile) {
  if (profile === YHM_PROFILE_REVIEWED_22) return YHM_REVIEWED_REGISTER_8;
  const match = OBSERVED_PROFILE_PATTERN.exec(String(profile ?? ""));
  if (!match) {
    throw new Error(`Unsupported YHM baseline profile ${profile ?? "unknown"}.`);
  }
  const register8 = Number.parseInt(match[1], 16);
  if (register8 === YHM_REVIEWED_REGISTER_8) {
    throw new Error(
      "The reviewed register-8 byte selects the reviewed-22 profile, not an observed one.",
    );
  }
  return register8;
}

export function requireYhmProfile(profile) {
  yhmProfileRegister8(profile);
  return profile;
}

export function yhmProfileBaselines(profile) {
  const register8 = yhmProfileRegister8(profile);
  if (register8 === YHM_REVIEWED_REGISTER_8) return REVIEWED_22_BASELINES;
  const suffix = `${register8.toString(16).padStart(2, "0")}ff`;
  return Object.freeze([
    REVIEWED_22_BASELINES[0],
    ...REVIEWED_22_BASELINES.slice(1).map(
      (baseline) => `${baseline.slice(0, -4)}${suffix}`,
    ),
  ]);
}

export const YHM_PROFILE_BASELINES = Object.freeze({
  [YHM_PROFILE_REVIEWED_22]: REVIEWED_22_BASELINES,
  [YHM_PROFILE_OBSERVED_33]: yhmProfileBaselines(YHM_PROFILE_OBSERVED_33),
  [YHM_PROFILE_OBSERVED_45]: yhmProfileBaselines(YHM_PROFILE_OBSERVED_45),
});

export function identifyYhmBaselineProfile(baselineHex) {
  const normalized = String(baselineHex ?? "").toLowerCase();
  if (REVIEWED_22_BASELINES.includes(normalized)) return YHM_PROFILE_REVIEWED_22;
  if (!/^[0-9a-f]{20}$/.test(normalized)) return null;
  if (!normalized.endsWith("ff")) return null;
  const register8 = Number.parseInt(normalized.slice(-4, -2), 16);
  if (register8 === YHM_REVIEWED_REGISTER_8) return null;
  const structural = `${normalized.slice(0, -4)}22ff`;
  // Entry 1 (the 0x8d variant) is never patched in the derived bridge tables,
  // so only register-8 variants of entries 2-5 can be served by a derived
  // bridge; everything else stays fail-closed.
  if (!REVIEWED_22_BASELINES.slice(1).includes(structural)) return null;
  return yhmObservedProfile(register8);
}

export function isYhmBaselineAllowed(profile, baselineHex) {
  requireYhmProfile(profile);
  return yhmProfileBaselines(profile).includes(
    String(baselineHex ?? "").toLowerCase(),
  );
}
