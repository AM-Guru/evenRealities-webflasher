import assert from "node:assert/strict";
import test from "node:test";

import {
  compareTempleSerials,
  decodeGlassesSerial,
  describeGlassesSerial,
  normalizeGlassesSerial,
  sameGlassesVariant,
  templeSerialMismatchWarning,
} from "../src/lib/glassesVariant.js";
import {
  EVEN_COMPANY_IDENTIFIER,
  G2_NAME_PATTERN,
  buildG2ChooserFilters,
  decodeDeviceInformationString,
  evaluateG2PairIdentity,
  g2NameToken,
  g2SideNamePrefixes,
  glassesSerialChooserFilter,
  isBlocklistedCharacteristicError,
  readG2AdvertisedSerial,
  readG2TempleIdentity,
  requestG2BleDevice,
} from "../src/lib/g2BleOta.js";
import { buildDeviceFingerprint } from "../src/lib/deviceIdentity.js";

// Serials observed on real hardware. S211GBBC180304 is a G2 Frame B in brown.
const G2_B_BROWN = "S211GBBC180304";
const G2_B_GREEN = "S211GCBC300403";

test("decodes an observed G2 serial into family, frame and colourway", () => {
  const decoded = decodeGlassesSerial(G2_B_BROWN);
  assert.equal(decoded.family, "g2");
  assert.equal(decoded.frame, "b");
  assert.equal(decoded.frameShape, "square");
  assert.equal(decoded.colorway, "brown");
  assert.equal(decoded.modelCode, "S211");
  assert.equal(decoded.productName, "Even G2 B");
  assert.equal(decoded.displayName, "Even G2 B · Brown");
  assert.equal(decoded.variantSummary, "Frame B (square) · Brown");
});

test("takes the colourway from the sixth character", () => {
  assert.equal(decodeGlassesSerial("S211GAAA000001").colorway, "grey");
  assert.equal(decodeGlassesSerial(G2_B_BROWN).colorway, "brown");
  assert.equal(decodeGlassesSerial(G2_B_GREEN).colorway, "green");
});

test("maps every known frame prefix, and Frame A is the round one", () => {
  assert.equal(decodeGlassesSerial("S201GAAA000001").frame, "a");
  assert.equal(decodeGlassesSerial("S281GAAA000001").frame, "a");
  assert.equal(decodeGlassesSerial("S211GAAA000001").frame, "b");
  assert.equal(decodeGlassesSerial("S291GAAA000001").frame, "b");
  assert.equal(decodeGlassesSerial("S221GAAA000001").frame, "c");
  assert.equal(decodeGlassesSerial("S201GAAA000001").frameShape, "round");
  assert.equal(decodeGlassesSerial("S211GAAA000001").frameShape, "square");
});

// The vendor app defaults an unknown prefix to Frame A. A flashing tool must
// not tell an operator they are holding a shape the serial never claimed.
test("an unrecognised model code keeps the family but claims no shape", () => {
  const decoded = decodeGlassesSerial("S231GBAA000001");
  assert.equal(decoded.family, "g2");
  assert.equal(decoded.frame, null);
  assert.equal(decoded.colorway, "brown");
  assert.equal(decoded.productName, "Even G2");
  assert.equal(decoded.variantSummary, "Brown");
});

test("an unrecognised colour byte claims no finish", () => {
  const decoded = decodeGlassesSerial("S211GZAA000001");
  assert.equal(decoded.frame, "b");
  assert.equal(decoded.colorway, null);
  assert.equal(decoded.displayName, "Even G2 B");
});

test("decodes G1 and the R1 ring families", () => {
  assert.equal(decodeGlassesSerial("S110GAAA000001").family, "g1");
  assert.equal(decodeGlassesSerial("S110GAAA000001").frame, "b");
  assert.equal(decodeGlassesSerial("S100GAAA000001").frame, "a");
  const ring = decodeGlassesSerial("B210GAAA000001");
  assert.equal(ring.family, "r1");
  assert.equal(ring.frame, null);
  assert.equal(ring.colorway, null);
  assert.equal(ring.displayName, "Even R1");
});

test("normalises the arm suffix and casing away", () => {
  assert.equal(normalizeGlassesSerial(`${G2_B_BROWN}_L_1`), G2_B_BROWN);
  assert.equal(
    decodeGlassesSerial(` ${G2_B_BROWN.toLowerCase()} `).serial,
    G2_B_BROWN,
  );
});

test("rejects values that are not Even serials", () => {
  assert.equal(decodeGlassesSerial("EVEN_G2_ALPHA"), null);
  assert.equal(decodeGlassesSerial("S211G"), null);
  assert.equal(decodeGlassesSerial(""), null);
  assert.equal(decodeGlassesSerial(null), null);
  assert.equal(describeGlassesSerial(null), null);
  assert.match(describeGlassesSerial("ZZ9999999"), /unrecognised serial format/);
});

test("compares temple serials across the arm suffix", () => {
  assert.equal(
    compareTempleSerials(`${G2_B_BROWN}_L_1`, G2_B_BROWN.toLowerCase()).verdict,
    "matched",
  );
  assert.equal(compareTempleSerials(G2_B_BROWN, G2_B_GREEN).verdict, "mismatched");
  assert.equal(compareTempleSerials(G2_B_BROWN, null).verdict, "unknown");
  assert.equal(compareTempleSerials("  ", G2_B_BROWN).verdict, "unknown");
});

test("the mismatch warning names both serials and the visible difference", () => {
  assert.equal(templeSerialMismatchWarning({ verdict: "matched" }), null);
  const warning = templeSerialMismatchWarning(
    compareTempleSerials(G2_B_BROWN, "S201GCBC300403"),
  );
  assert.match(warning, /S211GBBC180304/);
  assert.match(warning, /S201GCBC300403/);
  assert.match(warning, /Even G2 B · Brown/);
  assert.match(warning, /Even G2 A · Green/);
});

test("same-variant is about the SKU, never about the pair", () => {
  // Two different pairs of the identical SKU: same variant, still not a pair.
  assert.equal(sameGlassesVariant(G2_B_BROWN, "S211GBBC999999"), true);
  assert.equal(
    compareTempleSerials(G2_B_BROWN, "S211GBBC999999").verdict,
    "mismatched",
  );
  assert.equal(sameGlassesVariant(G2_B_BROWN, G2_B_GREEN), false);
  assert.equal(sameGlassesVariant(G2_B_BROWN, "nonsense"), null);
});

// MARK: Device Information reads

test("decodes NUL-padded Device Information strings", () => {
  const padded = new Uint8Array(16);
  padded.set(new TextEncoder().encode(G2_B_BROWN));
  const view = new DataView(padded.buffer);
  assert.equal(decodeDeviceInformationString(view), G2_B_BROWN);
  assert.equal(
    decodeDeviceInformationString(new TextEncoder().encode(` ${G2_B_BROWN} `)),
    G2_B_BROWN,
  );
  assert.equal(decodeDeviceInformationString(new Uint8Array(8)), null);
  assert.equal(decodeDeviceInformationString(null), null);
});

// MARK: Chooser filtering
//
// The advertisement below is a real HCI capture of the S211GBBC180304 pair:
//
//   18 ff 45 52 53 32 31 31 47 42 42 43 31 38 30 33 30 34 e0 ec b6 14 12 e0 02
//   \_/ \_/ \___/ \_______________________________________/ \______________/ \/
//   len type comp  SN(14) ASCII                              MAC(6, LE)     flag
//
// The filter has to reproduce the company identifier and the serial bytes
// exactly, so it is asserted against those captured bytes rather than against
// a value derived the same way the implementation derives it.
const CAPTURED_ADVERTISEMENT = Uint8Array.from([
  0x18, 0xff, 0x45, 0x52, 0x53, 0x32, 0x31, 0x31, 0x47, 0x42, 0x42, 0x43,
  0x31, 0x38, 0x30, 0x33, 0x30, 0x34, 0xe0, 0xec, 0xb6, 0x14, 0x12, 0xe0,
  0x02,
]);

test("the company identifier is the little-endian pair from the capture", () => {
  const [low, high] = CAPTURED_ADVERTISEMENT.subarray(2, 4);
  assert.equal(EVEN_COMPANY_IDENTIFIER, low | (high << 8));
  // Those same bytes spell "ER" in order, which is why the project decoder
  // reads them as a literal prefix. They are the company field all the same.
  assert.equal(String.fromCharCode(low, high), "ER");
});

test("the serial filter matches the captured advertisement bytes", () => {
  const filter = glassesSerialChooserFilter(G2_B_BROWN);
  assert.equal(filter.manufacturerData[0].companyIdentifier, 0x5245);
  assert.deepEqual(
    [...filter.manufacturerData[0].dataPrefix],
    // Everything after the company identifier, up to the end of the serial.
    [...CAPTURED_ADVERTISEMENT.subarray(4, 18)],
  );
});

test("a partial serial is a legal prefix, junk is not a filter at all", () => {
  const partial = glassesSerialChooserFilter("S211GB");
  assert.deepEqual(
    [...partial.manufacturerData[0].dataPrefix],
    [...new TextEncoder().encode("S211GB")],
  );
  assert.equal(glassesSerialChooserFilter("S211"), null);
  assert.equal(glassesSerialChooserFilter(""), null);
  assert.equal(glassesSerialChooserFilter(null), null);
});

test("a known serial narrows the chooser to that pair, and that side", async () => {
  let options = null;
  const device = { name: "Even G2_32_L_4FB39E", id: "left", gatt: {} };
  await requestG2BleDevice(
    "left",
    {
      requestDevice: async (value) => {
        options = value;
        return device;
      },
    },
    { expectedSerial: G2_B_BROWN },
  );
  // Every filter carries BOTH criteria. Web Bluetooth ANDs criteria within one
  // filter and ORs between filters, so a serial-only filter alongside a
  // side-only filter would admit either on its own - it has to be per-filter.
  for (const filter of options.filters) {
    assert.match(filter.namePrefix, /_L_$/);
    assert.equal(
      filter.manufacturerData[0].companyIdentifier,
      EVEN_COMPANY_IDENTIFIER,
    );
  }
});

test("the chooser does not request manufacturer-data access", async () => {
  for (const expectedSerial of [null, G2_B_BROWN]) {
    let options = null;
    await requestG2BleDevice(
      "left",
      {
        requestDevice: async (value) => {
          options = value;
          return { name: "Even G2_32_L_ACD458", id: "left", gatt: {} };
        },
      },
      { expectedSerial },
    );
    assert.equal(options.optionalManufacturerData, undefined);
  }
});

test("without a serial the chooser still restricts to the chosen side", async () => {
  let options = null;
  const device = { name: "Even G2_32_L_4FB39E", id: "left", gatt: {} };
  for (const expectedSerial of [null, "", "not-a-serial"]) {
    await requestG2BleDevice(
      "left",
      {
        requestDevice: async (value) => {
          options = value;
          return device;
        },
      },
      { expectedSerial },
    );
    assert.deepEqual(
      options.filters.map((filter) => filter.namePrefix),
      ["Even G2_32_L_", "G2_32_L_"],
      `expectedSerial ${JSON.stringify(expectedSerial)} must still keep the side filter`,
    );
  }
});

// MARK: Side-specific chooser filters

test("each side's chooser offers only that side's name prefixes", () => {
  assert.deepEqual(g2SideNamePrefixes("left"), [
    "Even G2_32_L_",
    "G2_32_L_",
  ]);
  assert.deepEqual(g2SideNamePrefixes("right"), [
    "Even G2_32_R_",
    "G2_32_R_",
  ]);
  // Every prefix carries the side marker, which is the whole point.
  for (const prefix of g2SideNamePrefixes("left", ["32", "40"])) {
    assert.match(prefix, /_L_$/);
  }
});

test("the left chooser cannot admit a right-side name, and vice versa", async () => {
  for (const [side, wrongName] of [
    ["left", "Even G2_32_R_4FB39E"],
    ["right", "Even G2_32_L_4FB39E"],
  ]) {
    let options = null;
    await assert.rejects(
      requestG2BleDevice(side, {
        requestDevice: async (value) => {
          options = value;
          // Chrome could only return this if the filters admitted it; the
          // post-chooser check is the backstop that makes the guarantee hold
          // even when the token list cannot express the side.
          return { name: wrongName, id: "wrong-side", gatt: { disconnect() {} } };
        },
      }),
      new RegExp(`Select the ${side} temple`),
    );
    const marker = side === "left" ? "_L_" : "_R_";
    assert.ok(
      options.filters.every((filter) => filter.namePrefix?.includes(marker)),
      `${side} filters must all carry ${marker}: ${JSON.stringify(options.filters)}`,
    );
  }
});

// The trailing hex is the last three bytes of that ARM's Bluetooth address,
// not a pair identifier. One field capture records a single pair as
//   Glasses::S211GBBC180304, Even G2_32_L_4FB39E, Even G2_32_R_1412E0
// so nothing about one arm's name predicts the other's. Guarded by a test
// because an earlier revision of this file assumed the opposite.
test("one arm's name says nothing about the other arm's name", () => {
  const left = "Even G2_32_L_4FB39E";
  const right = "Even G2_32_R_1412E0";
  assert.equal(g2NameToken(left), g2NameToken(right));
  assert.notEqual(
    G2_NAME_PATTERN.exec(left)[3],
    G2_NAME_PATTERN.exec(right)[3],
    "the two arms of one pair carry different address tails",
  );
  assert.equal(g2NameToken("Even G2_32_L_4FB39E"), "32");
  assert.equal(g2NameToken("nonsense"), null);
});

test("this side's remembered name is a hint, not an availability trap", () => {
  const filters = buildG2ChooserFilters("right", {
    expectedName: "Even G2_32_R_1412E0",
  });
  assert.deepEqual(filters, [
    { name: "Even G2_32_R_1412E0" },
    { namePrefix: "Even G2_32_R_" },
    { namePrefix: "G2_32_R_" },
  ]);
  assert.ok(
    filters.some(
      (filter) =>
        filter.namePrefix && "Even G2_32_R_180304".startsWith(filter.namePrefix),
    ),
    "a firmware-changed suffix must still leave the same right temple selectable",
  );
  // A remembered name for the OTHER side must never pin this chooser.
  assert.deepEqual(
    buildG2ChooserFilters("right", {
      expectedName: "Even G2_32_L_4FB39E",
    }).map((filter) => filter.namePrefix),
    ["Even G2_32_R_", "G2_32_R_"],
  );
});

test("a side prefix and a serial are ANDed inside one filter", () => {
  // Criteria within a single filter are ANDed by Web Bluetooth, so this reads
  // as "this pair AND this side" rather than admitting either on its own.
  const filters = buildG2ChooserFilters("left", { expectedSerial: G2_B_BROWN });
  assert.equal(filters.length, 2);
  for (const filter of filters) {
    assert.match(filter.namePrefix, /_L_$/);
    assert.equal(
      filter.manufacturerData[0].companyIdentifier,
      EVEN_COMPANY_IDENTIFIER,
    );
  }
});

// The failure this feature introduces: a G2 whose name token was never
// recorded is invisible to a prefix built from the known list. It must degrade
// to the pair-wide filters rather than to an empty chooser.
test("an empty token list falls back instead of hiding every device", () => {
  const filters = buildG2ChooserFilters("left", { tokens: [] });
  assert.deepEqual(
    filters.map((filter) => filter.namePrefix),
    ["Even G2", "G2_"],
  );
  const withSerial = buildG2ChooserFilters("left", {
    tokens: [],
    expectedSerial: G2_B_BROWN,
  });
  assert.equal(withSerial.length, 1);
  assert.equal(withSerial[0].namePrefix, undefined);
  assert.equal(
    withSerial[0].manufacturerData[0].companyIdentifier,
    EVEN_COMPANY_IDENTIFIER,
  );
});

test("a newly observed token widens the filter for later sessions", () => {
  const filters = buildG2ChooserFilters("left", { tokens: ["32", "40"] });
  assert.deepEqual(
    filters.map((filter) => filter.namePrefix),
    ["Even G2_32_L_", "G2_32_L_", "Even G2_40_L_", "G2_40_L_"],
  );
});

// MARK: Serial sources
//
// Chrome blocks the standard Serial Number characteristic (0x2A25) on every
// web page — it is on the Web Bluetooth GATT blocklist under "standardized
// unique identifiers". Confirmed on hardware: the read throws and the serial
// has to come from the advertisement instead.

test("a blocklisted-characteristic failure is recognised as one", () => {
  assert.equal(
    isBlocklistedCharacteristicError({
      name: "SecurityError",
      message: "getCharacteristic(s) called with blocklisted UUID.",
    }),
    true,
  );
  assert.equal(
    isBlocklistedCharacteristicError({
      name: "NotFoundError",
      message: "No Characteristic matching UUID.",
    }),
    false,
  );
  assert.equal(isBlocklistedCharacteristicError(null), false);
});

function advertisingDevice(serial, { company = EVEN_COMPANY_IDENTIFIER } = {}) {
  const listeners = new Set();
  const payload = new Uint8Array(21);
  payload.set(new TextEncoder().encode(serial));
  return {
    listeners,
    addEventListener: (type, fn) => type === "advertisementreceived" && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    async watchAdvertisements() {
      // Deliver one advertisement, as Chrome would.
      queueMicrotask(() => {
        for (const fn of [...listeners]) {
          fn({ manufacturerData: new Map([[company, new DataView(payload.buffer)]]) });
        }
      });
    },
  };
}

test("the serial is read from the advertisement, which is not blocklisted", async () => {
  const serial = await readG2AdvertisedSerial(advertisingDevice(G2_B_BROWN), {
    side: "left",
  });
  assert.equal(serial, G2_B_BROWN);
});

test("an advertisement from another vendor is ignored", async () => {
  const serial = await readG2AdvertisedSerial(
    advertisingDevice(G2_B_BROWN, { company: 0x004c }),
    { side: "left", timeoutMs: 60 },
  );
  assert.equal(serial, null);
});

test("a Chrome build without watchAdvertisements degrades, it does not throw", async () => {
  const warnings = [];
  const serial = await readG2AdvertisedSerial(
    { addEventListener() {}, removeEventListener() {} },
    { side: "left", log: (message, tone) => warnings.push([tone, message]) },
  );
  assert.equal(serial, null);
  assert.equal(warnings[0][0], "warn");
  assert.match(warnings[0][1], /watchAdvertisements is unavailable/);
});

test("the advertisement supplies the serial when GATT cannot", async () => {
  const advertiser = advertisingDevice(G2_B_BROWN);
  const identity = await readG2TempleIdentity(
    {
      ...advertiser,
      gatt: {
        connected: false,
        // Stands in for the blocklist: the whole GATT path fails.
        async connect() {
          throw Object.assign(new Error("blocked"), { name: "SecurityError" });
        },
        disconnect() {},
      },
    },
    { side: "left" },
  );
  assert.equal(identity.serialNumber, G2_B_BROWN);
  assert.equal(identity.serialSource, "advertisement");
  assert.equal(identity.variant.displayName, "Even G2 B · Brown");
});

// This is the exact hardware case: Device Information resolves, every string
// read except the serial succeeds, and the serial is refused by the browser.
test("a blocked serial read still yields a decoded temple", async () => {
  const advertiser = advertisingDevice(G2_B_BROWN);
  const identity = await readG2TempleIdentity(
    {
      ...advertiser,
      gatt: {
        connected: false,
        async connect() {
          return {
            async getPrimaryService() {
              return {
                async getCharacteristic(name) {
                  if (name === "serial_number_string") {
                    throw Object.assign(
                      new Error("getCharacteristic(s) called with blocklisted UUID."),
                      { name: "SecurityError" },
                    );
                  }
                  return {
                    async readValue() {
                      return new DataView(new TextEncoder().encode("G2").buffer);
                    },
                  };
                },
              };
            },
          };
        },
        disconnect() {},
      },
    },
    { side: "left" },
  );
  assert.equal(identity.serialNumber, G2_B_BROWN);
  assert.equal(identity.serialSource, "advertisement");
  assert.equal(identity.modelNumber, "G2");
  assert.equal(identity.variant.frame, "b");
});

// MARK: Pair gate

test("two temples reporting one serial are a matched pair", () => {
  const verdict = evaluateG2PairIdentity(
    { serialNumber: G2_B_BROWN },
    { serialNumber: `${G2_B_BROWN}_R_1` },
  );
  assert.equal(verdict.status, "matched");
  assert.equal(verdict.blocking, false);
  assert.equal(verdict.serial, G2_B_BROWN);
  assert.match(verdict.message, /Even G2 B · Brown/);
  assert.match(verdict.message, /one matched pair/);
});

test("two temples from different pairs block, and the message says why", () => {
  const verdict = evaluateG2PairIdentity(
    { serialNumber: G2_B_BROWN },
    { serialNumber: G2_B_GREEN },
  );
  assert.equal(verdict.status, "mismatched");
  assert.equal(verdict.blocking, true);
  assert.match(verdict.message, /different serial numbers/);
  assert.match(verdict.message, /matched set before flashing/);
});

// Firmware states this tool exists to repair frequently cannot answer a
// Device Information read. Absence of evidence must never stop the work.
test("a temple that reports no serial is unverified, not blocked", () => {
  const verdict = evaluateG2PairIdentity(
    { serialNumber: G2_B_BROWN },
    { serialNumber: null },
  );
  assert.equal(verdict.status, "unverified");
  assert.equal(verdict.blocking, false);
  assert.match(verdict.message, /right temple/);

  const neither = evaluateG2PairIdentity(null, null);
  assert.equal(neither.status, "unverified");
  assert.equal(neither.blocking, false);
});

// MARK: Fingerprint

test("the fingerprint records the decoded variant when the temples were read", () => {
  const fingerprint = buildDeviceFingerprint({
    report: { console: { serialNumber: "00310025514250052037384b" } },
    templeIdentities: {
      left: { serialNumber: G2_B_BROWN },
      right: { serialNumber: G2_B_BROWN },
    },
  });
  assert.equal(fingerprint.frameVariant.value, "B");
  assert.equal(fingerprint.frameVariant.shape, "square");
  assert.equal(fingerprint.frameVariant.colorway, "brown");
  assert.equal(
    fingerprint.frameVariant.source,
    "temple-device-information-serial",
  );
  assert.equal(fingerprint.frameVariant.reason, null);
  assert.equal(fingerprint.glasses.pairVerdict, "matched");
  assert.equal(fingerprint.glasses.serial, G2_B_BROWN);
  assert.equal(fingerprint.glasses.displayName, "Even G2 B · Brown");
});

test("the USB-only fingerprint keeps the honest unknown-variant reason", () => {
  const fingerprint = buildDeviceFingerprint({
    report: { console: { serialNumber: "00310025514250052037384b" } },
  });
  assert.equal(fingerprint.glasses, null);
  assert.equal(fingerprint.frameVariant.value, null);
  assert.match(fingerprint.frameVariant.reason, /operator label/);
  // The Case UID is not a product serial and must never be decoded as one.
  assert.equal(decodeGlassesSerial("00310025514250052037384b"), null);
});

test("a mismatched pair is recorded in the fingerprint, not silently averaged", () => {
  const fingerprint = buildDeviceFingerprint({
    report: { console: { serialNumber: "00310025514250052037384b" } },
    templeIdentities: {
      left: { serialNumber: G2_B_BROWN },
      right: { serialNumber: G2_B_GREEN },
    },
  });
  assert.equal(fingerprint.glasses.pairVerdict, "mismatched");
  assert.equal(fingerprint.glasses.serial, null);
  assert.equal(fingerprint.glasses.leftSerial, G2_B_BROWN);
  assert.equal(fingerprint.glasses.rightSerial, G2_B_GREEN);
});
