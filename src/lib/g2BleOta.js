import {
  EXPECTED_COMPONENTS,
  EXPECTED_COMPONENT_TYPES,
  findG2FirmwareRevocation,
} from "./firmware.js";
import {
  GLASSES_SERIAL_MIN_LENGTH,
  compareTempleSerials,
  decodeGlassesSerial,
  normalizeGlassesSerial,
  templeSerialMismatchWarning,
} from "./glassesVariant.js";

export const G2_BLE_DATA_SERVICE =
  "00002760-08c2-11e1-9073-0e8ac72e1001";
export const G2_BLE_DATA_WRITE =
  "00002760-08c2-11e1-9073-0e8ac72e0001";
export const G2_BLE_DATA_NOTIFY =
  "00002760-08c2-11e1-9073-0e8ac72e0002";
export const G2_BLE_CONTROL_SERVICE =
  "00002760-08c2-11e1-9073-0e8ac72e5450";
export const G2_BLE_CONTROL_WRITE =
  "00002760-08c2-11e1-9073-0e8ac72e5401";
export const G2_BLE_CONTROL_NOTIFY =
  "00002760-08c2-11e1-9073-0e8ac72e5402";

// Standard Bluetooth SIG Device Information Service. The temple's own product
// serial lives here, and it is the ONLY place this tool can obtain it: the USB
// factory console reports the Charging Case's STM32 UID, and the pogo version
// frame carries firmware/hardware bytes only. Reading it turns "some G2" into
// the exact SKU, and lets the two sides be checked against each other.
export const G2_BLE_DEVICE_INFO_SERVICE = "device_information";
export const G2_BLE_SERIAL_NUMBER_CHARACTERISTIC = "serial_number_string";
export const G2_BLE_MODEL_NUMBER_CHARACTERISTIC = "model_number_string";
export const G2_BLE_HARDWARE_REVISION_CHARACTERISTIC = "hardware_revision_string";
export const G2_BLE_FIRMWARE_REVISION_CHARACTERISTIC = "firmware_revision_string";

// Even Realities' company identifier, as it appears in the G2 advertisement's
// Manufacturer Specific Data element. Confirmed from an HCI capture:
//
//   18 ff 45 52 53 32 31 31 47 42 42 43 31 38 30 33 30 34 e0 ec b6 14 12 e0 02
//   |  |  |____| |_______________________________________| |______________| |
//   |  |  company  SN(14) ASCII "S211GBBC180304"            MAC(6, LE)      flag
//   |  AD type 0xFF = Manufacturer Specific Data
//   AD element length 0x18 = 24
//
// The two company bytes are 0x45 0x52, which spell "ER" when read in order;
// as the little-endian uint16 the Bluetooth spec defines for that field they
// are 0x5245. Web Bluetooth wants the number, not the letters.
export const EVEN_COMPANY_IDENTIFIER = 0x5245;
export const EVEN_ADVERTISED_SERIAL_LENGTH = 14;

export const G2_BLE_BLOCK_BYTES = 4096;
export const G2_BLE_ENVELOPE_CHUNK_BYTES = 232;
export const G2_BLE_BLOCK_ACK_TIMEOUT_MS = 4000;
export const G2_BLE_CONTROL_ACK_TIMEOUT_MS = 8000;
export const G2_BLE_HEARTBEAT_INTERVAL_MS = 12000;
export const G2_BLE_BLOCK_NAK_ATTEMPTS = 3;
export const G2_BLE_COMPONENT_ATTEMPTS = 3;
export const G2_BLE_LOSS_RECONNECT_DELAY_MS = 10000;
export const G2_BLE_REBOOT_SETTLE_MS = G2_BLE_LOSS_RECONNECT_DELAY_MS;
export const G2_BLE_RECONNECT_INTERVAL_MS = 2500;
export const G2_BLE_RECONNECT_ATTEMPTS = 8;
export const G2_BLE_VISIBILITY_RESUME_SETTLE_MS = 250;
export const G2_BLE_TARGET_PROOF_MAX_AGE_MS = 15 * 60 * 1000;

export const G2_BLE_OTA_STATUS = Object.freeze({
  0: "SUCCESS",
  1: "HEADER_ERR",
  2: "PATH_ERR",
  3: "CRC_ERR",
  4: "TIMEOUT",
  5: "NO_RESOURCES",
  6: "FLASH_WRITE_ERR",
  7: "CHECK_FAIL",
  8: "UPDATING",
  9: "SYS_RESTART",
  10: "FAIL",
});

const END_OK = new Set([0, 8, 9]);
const HEARTBEAT_PAYLOAD = Uint8Array.from([
  0x08, 0x0e, 0x10, 0x26, 0x6a, 0x00,
]);

// Device Information characteristics are UTF-8 strings, but firmware commonly
// pads or NUL-terminates them into a fixed buffer. Cut at the first NUL and
// strip the control bytes rather than carrying them into a comparison, which
// is what would make two readings of one serial look like two devices.
export function decodeDeviceInformationString(value) {
  if (!value) return null;
  const bytes = asBytes(
    value instanceof DataView
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : value,
  );
  const terminator = bytes.indexOf(0);
  const body = terminator >= 0 ? bytes.subarray(0, terminator) : bytes;
  const text = new TextDecoder()
    .decode(body)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  return text || null;
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return Uint8Array.from(input ?? []);
}

function concatBytes(...parts) {
  const normalized = parts.map(asBytes);
  const output = new Uint8Array(
    normalized.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of normalized) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function crc16CcittFalse(input) {
  let crc = 0xffff;
  for (const byte of asBytes(input)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc =
        crc & 0x8000
          ? ((crc << 1) ^ 0x1021) & 0xffff
          : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function makeBleEnvelopeFrames(
  sid,
  payload,
  { sequence, flag = 0 } = {},
) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xff) {
    throw new Error("A one-byte G2 BLE transport sequence is required.");
  }
  const pb = asBytes(payload);
  const crc = crc16CcittFalse(pb);
  const body = concatBytes(pb, [crc & 0xff, (crc >>> 8) & 0xff]);
  const totalFragments = Math.max(
    1,
    Math.ceil(body.length / G2_BLE_ENVELOPE_CHUNK_BYTES),
  );
  const frames = [];
  for (let index = 0; index < totalFragments; index += 1) {
    const chunk = body.subarray(
      index * G2_BLE_ENVELOPE_CHUNK_BYTES,
      (index + 1) * G2_BLE_ENVELOPE_CHUNK_BYTES,
    );
    frames.push(
      concatBytes(
        [
          0xaa,
          0x21,
          sequence,
          chunk.length,
          totalFragments,
          index + 1,
          sid,
          flag,
        ],
        chunk,
      ),
    );
  }
  return frames;
}

export function makeBleControlFrames(opcode, data, sequence) {
  return makeBleEnvelopeFrames(
    0xc0,
    concatBytes([opcode], data ?? []),
    { sequence },
  );
}

export function parseBleAck(input) {
  const frame = asBytes(input);
  if (
    frame.length < 10 ||
    frame[0] !== 0xaa ||
    frame[1] !== 0x12
  ) {
    return null;
  }
  const frameLength = frame[3];
  const payloadLength = Math.max(0, frameLength - 2);
  if (frame.length < 8 + payloadLength) return null;
  const payload = frame.slice(8, 8 + payloadLength);
  return {
    sequence: frame[2],
    sid: frame[6],
    flag: frame[7],
    payload,
    opcode: payload[0] ?? null,
    status: payload[1] ?? null,
  };
}

export function g2BleStatusName(status) {
  return G2_BLE_OTA_STATUS[status] ?? `0x${Number(status)
    .toString(16)
    .padStart(2, "0")}`;
}

export function isG2BleConnectionLoss(error, device = null) {
  if (device?.gatt?.connected === false) return true;
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (
      current.code === 19 ||
      current.name === "NetworkError" ||
      /(?:bluetooth device is no longer in range|gatt.*disconnected|not connected to gatt|connection (?:is |was )?(?:lost|closed|unavailable)|device.*disconnected)/i.test(
        current.message ?? "",
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function g2BleSupported(bluetooth = globalThis.navigator?.bluetooth) {
  return Boolean(bluetooth?.requestDevice);
}

export async function probeAuthorizedG2BleDevices({
  bluetooth = globalThis.navigator?.bluetooth,
  devices = null,
} = {}) {
  let candidates = devices
    ? Object.entries(devices)
        .filter(([, device]) => Boolean(device))
        .map(([side, device]) => ({ side, device }))
    : [];
  if (!candidates.length && typeof bluetooth?.getDevices === "function") {
    const authorized = await bluetooth.getDevices();
    candidates = authorized
      .map((device) => ({ side: g2BleDeviceSide(device?.name), device }))
      .filter(({ side }) => Boolean(side));
  }

  const results = { left: null, right: null };
  for (const { side: expectedSide, device } of candidates) {
    const observedSide = g2BleDeviceSide(device?.name);
    const side = observedSide ?? expectedSide;
    if (!results[side] && ["left", "right"].includes(side)) {
      const result = {
        side,
        deviceId: device?.id ?? null,
        deviceName: device?.name ?? null,
        authorized: true,
        reachable: false,
        applicationGattVerified: false,
        error: null,
      };
      try {
        if (!device?.gatt?.connect) {
          throw new Error("The authorized Bluetooth handle has no GATT connection.");
        }
        const server = await device.gatt.connect();
        // A successful primary-service lookup proves more than a cached device
        // handle: the normal G2 application is accepting its OTA GATT service.
        await server.getPrimaryService(G2_BLE_CONTROL_SERVICE);
        result.reachable = true;
        result.applicationGattVerified = true;
      } catch (error) {
        result.error = error?.message ?? String(error);
      } finally {
        try {
          device?.gatt?.disconnect?.();
        } catch {
          // A failed connection is already disconnected.
        }
      }
      results[side] = result;
    }
  }

  const authorizedSides = ["left", "right"].filter(
    (side) => results[side]?.authorized,
  );
  const reachableSides = ["left", "right"].filter(
    (side) => results[side]?.applicationGattVerified,
  );
  return {
    supported: Boolean(bluetooth),
    permissionApiAvailable: typeof bluetooth?.getDevices === "function",
    authorizedSides,
    reachableSides,
    bothApplicationsReachable: reachableSides.length === 2,
    chooserRequired: authorizedSides.length < 2,
    results,
  };
}

// G2 advertised names are `Even G2_<token>_<side>_<addressTail>`, for example
// `Even G2_32_L_4FB39E`.
//
// The trailing hex is the last three bytes of THAT ARM's Bluetooth address, so
// it is per-arm and the two temples of one pair do not share it. Confirmed on
// hardware and in the field capture, where one pair reports:
//
//   Glasses::S211GBBC180304, Even G2_32_L_4FB39E-none, Even G2_32_R_1412E0-none
//   :4F:B3:9E, remote device = Even G2_32_L_4FB39E
//
// Nothing about one arm's name predicts the other's. The pair identity lives in
// the serial (identical on both arms, in the advertisement's manufacturer data
// and in Device Information), never in the name.
//
// The token has been `32` on every advertised name recorded so far, which is
// what makes a side-specific name PREFIX possible at all - see
// g2SideNamePrefixes.
export const G2_NAME_PATTERN =
  /^(?:Even\s+)?G2_([0-9A-Za-z]+)_(L|R)_([0-9A-Fa-f]+)$/;

// Tokens seen in the field. Used only to build side-specific name prefixes for
// the FIRST arm, where nothing else is known yet. A G2 advertising an
// unrecorded token is invisible to a prefix built from this list. Remembered
// names therefore contribute both an exact-name hint and their token's broad
// side prefix, and `g2NameToken` feeds newly observed tokens back in.
export const G2_KNOWN_NAME_TOKENS = Object.freeze(["32"]);

export function g2NameToken(name) {
  const match = G2_NAME_PATTERN.exec(String(name ?? "").trim());
  return match ? match[1] : null;
}

// Name prefixes that admit one side only.
//
// `_L_` sits in the middle of the name, after a variable token, and Web
// Bluetooth's filter grammar has no substring match - only exact `name` and
// `namePrefix`. Enumerating the observed tokens is what turns the side marker
// into something a prefix CAN express.
export function g2SideNamePrefixes(side, tokens = G2_KNOWN_NAME_TOKENS) {
  const marker = side === "left" ? "L" : "R";
  const unique = [...new Set((tokens ?? []).filter(Boolean))];
  return unique.flatMap((token) => [
    `Even G2_${token}_${marker}_`,
    `G2_${token}_${marker}_`,
  ]);
}

// Assemble the chooser filters for one side.
//
// Criteria inside a single filter are ANDed and filters are ORed, so a side
// prefix and a serial can be combined into "this pair, this side" while still
// offering one filter per known token spelling.
export function buildG2ChooserFilters(
  side,
  { expectedSerial = null, expectedName = null, tokens = G2_KNOWN_NAME_TOKENS } = {},
) {
  const serialFilter = glassesSerialChooserFilter(expectedSerial);
  const filters = [];
  // A remembered name is useful as the strongest first choice, but it must not
  // be the only choice. Stock and the retired advertised-name CFW builds can
  // give one physical arm different trailing name bytes. Treating the old
  // exact name as exclusive made a healthy temple disappear from Chrome's
  // chooser after a firmware transition.
  const remembered = String(expectedName ?? "").trim();
  let rememberedToken = null;
  if (remembered && G2_NAME_PATTERN.test(remembered)) {
    const marker = side === "left" ? "L" : "R";
    // Refuse a remembered name for the wrong side rather than pinning the
    // chooser to the opposite temple.
    if (G2_NAME_PATTERN.exec(remembered)[2] === marker) {
      rememberedToken = g2NameToken(remembered);
      filters.push({ name: remembered, ...(serialFilter ?? {}) });
    }
  }
  const prefixes = g2SideNamePrefixes(side, [
    ...(tokens ?? []),
    rememberedToken,
  ]);
  if (prefixes.length) {
    filters.push(
      ...prefixes.map((namePrefix) => ({
        namePrefix,
        ...(serialFilter ?? {}),
      })),
    );
    return filters;
  }
  // No token to build a side prefix from. Fall back to the pair-wide filters;
  // the post-chooser side check still refuses a wrong-side selection.
  return serialFilter
    ? [serialFilter]
    : [{ namePrefix: "Even G2" }, { namePrefix: "G2_" }];
}

export function g2BleDeviceSide(name) {
  const normalized = String(name ?? "").trim().toUpperCase();
  if (!/^(?:EVEN\s+)?G2(?:[\s_-]|$)/.test(normalized)) return null;
  const markers = [
    ...normalized.matchAll(
      /(?:^|[\s_-])(LEFT|RIGHT|L|R)(?=[\s_-]|$)/g,
    ),
  ].map((match) =>
    ["LEFT", "L"].includes(match[1]) ? "left" : "right",
  );
  const unique = [...new Set(markers)];
  return unique.length === 1 ? unique[0] : null;
}

export function g2BleTargetVersionProof(
  routeResults,
  targetVersion,
  {
    now = Date.now(),
    maxAgeMs = G2_BLE_TARGET_PROOF_MAX_AGE_MS,
  } = {},
) {
  const version = routeResults?.version;
  const observedAt = Date.parse(version?.observedAt ?? "");
  const ageMs = now - observedAt;
  return Boolean(
    targetVersion &&
      !routeResults?.lastProbeFailure &&
      version?.decoded?.firmwareVersion === targetVersion &&
      version?.transportProof?.restoredMask === 0x3ff &&
      Number.isFinite(observedAt) &&
      ageMs >= 0 &&
      ageMs <= maxAgeMs,
  );
}

export function g2BleTargetReportedVersion(firmware) {
  return firmware?.templeFlashTarget?.reportedVersion ?? firmware?.g2Version ?? null;
}

// A verified final END proves that every package byte was accepted, but it
// does not prove that the rebooted Application image is reachable. Keep that
// distinction explicit so the UI cannot call a transfer "complete" while the
// exact failure operators care about — a temple disappearing after reboot —
// is still unresolved. A fresh Case version/liveness interrogation is the
// authoritative fallback when the bounded GATT reconnect is exhausted.
export function g2BleRoutesAwaitingCaseVerification(routes) {
  return ["left", "right"].filter((side) => {
    const route = routes?.[side];
    if (!route || route.skipped || route.outcome !== "success") return false;
    const postUpdate = route.components?.at(-1)?.postUpdate;
    return Boolean(
      postUpdate?.freshReconnectAttempted && !postUpdate.reconnected,
    );
  });
}

// Build the chooser filter that admits only one specific pair.
//
// This is the closest a web page can get to "show the serial in the chooser".
// Chrome's device chooser is browser UI: a page cannot relabel its entries, and
// the advertised name it displays (`Even G2_32_L_4FB39E`) carries a side marker
// and a per-arm hex tail but NOT the product serial. What a page can decide is
// which devices are eligible to appear at all — and the serial is right there
// in the advertisement to filter on. Given a serial, the chooser lists that one
// pair, so picking a stranger's glasses stops being possible rather than merely
// being detectable afterwards.
//
// Returns null for anything that is not a usable serial, so callers fall back
// to the name filters instead of opening a chooser that can never populate.
export function glassesSerialChooserFilter(serial) {
  const normalized = normalizeGlassesSerial(serial);
  if (normalized.length < GLASSES_SERIAL_MIN_LENGTH) return null;
  return {
    manufacturerData: [
      {
        companyIdentifier: EVEN_COMPANY_IDENTIFIER,
        // dataPrefix matches the bytes that follow the company identifier,
        // which is exactly where the ASCII serial begins. A partial serial is
        // a legitimate prefix match; a full one pins a single pair.
        dataPrefix: new TextEncoder().encode(
          normalized.slice(0, EVEN_ADVERTISED_SERIAL_LENGTH),
        ),
      },
    ],
  };
}

export async function requestG2BleDevice(
  side,
  bluetooth = globalThis.navigator?.bluetooth,
  {
    expectedSerial = null,
    expectedName = null,
    tokens = G2_KNOWN_NAME_TOKENS,
  } = {},
) {
  if (!["left", "right"].includes(side)) {
    throw new Error("Choose the left or right G2 temple.");
  }
  if (!g2BleSupported(bluetooth)) {
    throw new Error(
      "Web Bluetooth is unavailable. Open the WebFlasher in current Chrome.",
    );
  }
  const device = await bluetooth.requestDevice({
    // Side-specific by construction: the LEFT button offers only `_L_` names
    // and the RIGHT button only `_R_` names. See buildG2ChooserFilters for how
    // a mid-string marker is expressed in a grammar that has only prefixes.
    //
    // The post-chooser side check below is NOT redundant. These filters depend
    // on the observed token list, and a G2 advertising an unrecorded token
    // falls back to pair-wide filters that cannot express the side.
    filters: buildG2ChooserFilters(side, {
      expectedSerial,
      expectedName,
      tokens,
    }),
    optionalServices: [
      G2_BLE_DATA_SERVICE,
      G2_BLE_CONTROL_SERVICE,
    ],
  });
  const observedSide = g2BleDeviceSide(device?.name);
  if (observedSide !== side) {
    device?.gatt?.disconnect();
    const error = new Error(
      observedSide
        ? `Select the ${side} temple. Chrome returned ${JSON.stringify(device?.name ?? "unnamed G2")}, which identifies the ${observedSide} temple. The ${side} pairing accepts only an explicit ${side}-side name.`
        : `Select the ${side} temple. Chrome returned ${JSON.stringify(device?.name ?? "unnamed G2")} without one unambiguous Left/Right marker. The ${side} pairing accepts only a G2 device whose advertised name explicitly identifies the ${side} side.`,
    );
    error.code = observedSide ? "WRONG_G2_SIDE" : "AMBIGUOUS_G2_SIDE";
    error.requestedSide = side;
    error.observedSide = observedSide;
    error.deviceName = device?.name ?? null;
    throw error;
  }
  return device;
}

// Chrome blocks the standard Serial Number String characteristic (0x2A25) on
// every web page. It is on the Web Bluetooth GATT blocklist, listed under
// "Block access to standardized unique identifiers, for privacy reasons", so
// no permission, flag or user gesture makes it readable. The iOS app reads it
// happily because CoreBluetooth has no such blocklist; a browser never will.
export function isBlocklistedCharacteristicError(failure) {
  if (!failure) return false;
  return (
    failure.name === "SecurityError" ||
    /blocklist|blocked/i.test(failure.message ?? "")
  );
}

export const G2_ADVERTISEMENT_SERIAL_TIMEOUT_MS = 6000;

// Read the serial out of the advertisement instead.
//
// The blocklist governs GATT attributes, not advertisement data, and the G2
// puts its serial in Manufacturer Specific Data - the same bytes the iOS app
// reads at scan time. Web Bluetooth exposes them through watchAdvertisements(),
// keyed by company identifier, with the company bytes stripped, so the value
// begins at the serial.
//
// Advisory like every other identity read: unsupported browser, a device that
// has stopped advertising, or a silent timeout all return null and leave the
// operator able to flash.
export async function readG2AdvertisedSerial(
  device,
  {
    side = null,
    log = () => {},
    timeoutMs = G2_ADVERTISEMENT_SERIAL_TIMEOUT_MS,
  } = {},
) {
  const label = side ? `${side}: ` : "";
  if (typeof device?.watchAdvertisements !== "function") {
    log(
      `${label}this Chrome build cannot read Bluetooth advertisements from a web page (watchAdvertisements is unavailable), so the serial cannot be read automatically.`,
      "warn",
    );
    return null;
  }
  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    // Counted so a failure can say WHICH failure it was. "No advertisements at
    // all" (temple not advertising) and "advertisements without Even's
    // manufacturer data" (the page was never granted that company identifier)
    // are different problems that previously produced the same message.
    let advertisements = 0;
    let withEvenData = 0;
    const finish = (serial) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      device.removeEventListener?.("advertisementreceived", onAdvertisement);
      try {
        controller?.abort();
      } catch {
        // Aborting a watch that already ended is not an error worth raising.
      }
      resolve(serial);
    };
    function onAdvertisement(event) {
      advertisements += 1;
      const data = event?.manufacturerData?.get?.(EVEN_COMPANY_IDENTIFIER);
      if (!data) return;
      withEvenData += 1;
      const bytes = new Uint8Array(
        data.buffer ?? data,
        data.byteOffset ?? 0,
        data.byteLength ?? data.length ?? 0,
      );
      // "ER" is the company identifier and is the map key, so these bytes
      // start at the serial rather than two bytes into it.
      const serial = decodeDeviceInformationString(
        bytes.subarray(0, EVEN_ADVERTISED_SERIAL_LENGTH),
      );
      if (serial) finish(serial);
    }
    device.addEventListener?.("advertisementreceived", onAdvertisement);
    timer = setTimeout(() => {
      const seconds = Math.round(timeoutMs / 1000);
      log(
        advertisements === 0
          ? `${label}no advertisements at all arrived within ${seconds}s. A connected temple stops advertising, so this is expected if it is already linked to a phone or the Even app.`
          : withEvenData === 0
            ? `${label}${advertisements} advertisement(s) arrived in ${seconds}s but none carried Even's manufacturer data (company 0x${EVEN_COMPANY_IDENTIFIER.toString(16)}). The page is not being given that data.`
            : `${label}${withEvenData} Even advertisement(s) arrived in ${seconds}s but none held a readable serial.`,
        "warn",
      );
      finish(null);
    }, timeoutMs);
    Promise.resolve(
      device.watchAdvertisements(controller ? { signal: controller.signal } : undefined),
    ).catch((error) => {
      log(
        `${label}could not watch this temple's advertisements (${error?.name ?? "Error"}: ${error?.message ?? String(error)}); continuing without an automatic serial read.`,
        "warn",
      );
      finish(null);
    });
  });
}

// Read the temple's own product identity from the standard Device Information
// Service and decode the SKU from its serial.
//
// Advisory by construction. Every failure path returns null and logs at warn:
// firmware that does not publish 0x180A, a Chrome build that refuses the
// service, or a serial in a format we have never seen must all leave the
// operator able to flash — the broken states this tool exists to repair are
// exactly the ones least likely to answer. What it buys is that when it DOES
// work, the tool names the exact glasses on the bench and can catch a pair
// assembled from two different sets.
export async function readG2DeviceInformation(
  server,
  { side = null, log = () => {} } = {},
) {
  if (!server?.getPrimaryService) return null;
  const label = side ? `${side}: ` : "";
  let service;
  try {
    service = await server.getPrimaryService(G2_BLE_DEVICE_INFO_SERVICE);
  } catch (error) {
    log(
      `${label}this temple does not publish the standard Device Information service (${error?.message ?? String(error)}); continuing without an automatic model check.`,
      "warn",
    );
    return null;
  }
  // Never swallow the reason. An earlier revision returned null for every
  // failure, which turned "Chrome refuses this characteristic" into "the
  // glasses answered without a serial" - a message that blamed the hardware
  // for a browser policy and made the real cause undiagnosable from the log.
  const failures = [];
  const readString = async (characteristic) => {
    try {
      const value = await (
        await service.getCharacteristic(characteristic)
      ).readValue();
      return decodeDeviceInformationString(value);
    } catch (error) {
      failures.push({
        characteristic,
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
      });
      return null;
    }
  };
  const serialNumber = await readString(G2_BLE_SERIAL_NUMBER_CHARACTERISTIC);
  const identity = {
    side,
    serialNumber,
    modelNumber: await readString(G2_BLE_MODEL_NUMBER_CHARACTERISTIC),
    hardwareRevision: await readString(
      G2_BLE_HARDWARE_REVISION_CHARACTERISTIC,
    ),
    firmwareRevision: await readString(
      G2_BLE_FIRMWARE_REVISION_CHARACTERISTIC,
    ),
    variant: decodeGlassesSerial(serialNumber),
    observedAt: new Date().toISOString(),
  };
  if (!serialNumber) {
    const serialFailure = failures.find(
      (failure) => failure.characteristic === G2_BLE_SERIAL_NUMBER_CHARACTERISTIC,
    );
    log(
      isBlocklistedCharacteristicError(serialFailure)
        ? `${label}Chrome refuses to read the standard Serial Number characteristic (0x2A25) from any web page — it is on the Web Bluetooth blocklist as a "standardized unique identifier", blocked for privacy. The glasses answered normally; the browser blocked it. Falling back to the serial in the advertisement.`
        : `${label}the Device Information service returned no serial number${
            serialFailure ? ` (${serialFailure.name}: ${serialFailure.message})` : ""
          }; continuing without an automatic model check.`,
      "warn",
    );
  } else if (identity.variant?.variantSummary) {
    log(
      `${label}temple identified as ${identity.variant.displayName} · ${identity.variant.variantSummary} · serial ${identity.variant.serial}.`,
      "success",
    );
  } else {
    log(
      `${label}serial ${serialNumber} does not match any Even model code this tool knows; continuing without a decoded frame or colour.`,
      "warn",
    );
  }
  return identity;
}

// Learn what this temple is, read-only, at selection time.
//
// Two sources, because neither is sufficient alone:
//
//   * the advertisement, which carries the serial and is NOT blocklisted, but
//     only while the temple is still advertising, and only in Chrome builds
//     that expose watchAdvertisements(); and
//   * Device Information over GATT, which survives a connected temple and
//     supplies model/hardware/firmware strings, but whose serial characteristic
//     Chrome blocks outright.
//
// The advertisement is read FIRST and while still disconnected, because
// connecting is what stops a peripheral advertising.
export async function readG2TempleIdentity(
  device,
  { side = null, log = () => {} } = {},
) {
  if (!device?.gatt) return null;
  const advertisedSerial = await readG2AdvertisedSerial(device, { side, log });
  if (advertisedSerial) {
    const variant = decodeGlassesSerial(advertisedSerial);
    log(
      variant?.variantSummary
        ? `${side ? `${side}: ` : ""}temple identified from its advertisement as ${variant.displayName} · ${variant.variantSummary} · serial ${variant.serial}.`
        : `${side ? `${side}: ` : ""}advertised serial ${advertisedSerial} does not match any Even model code this tool knows.`,
      variant?.variantSummary ? "success" : "warn",
    );
  }
  const wasConnected = Boolean(device.gatt.connected);
  try {
    const server = wasConnected ? device.gatt : await device.gatt.connect();
    const information = await readG2DeviceInformation(server, { side, log });
    if (!advertisedSerial) return information;
    // The advertisement is authoritative for the serial: it is the only source
    // a browser is permitted to read.
    const serialNumber = information?.serialNumber ?? advertisedSerial;
    return {
      ...(information ?? { side, modelNumber: null, hardwareRevision: null, firmwareRevision: null }),
      serialNumber,
      serialSource: information?.serialNumber
        ? "device-information"
        : "advertisement",
      variant: decodeGlassesSerial(serialNumber),
      observedAt: information?.observedAt ?? new Date().toISOString(),
    };
  } catch (error) {
    log(
      `${side ? `${side}: ` : ""}could not read this temple's Device Information over Bluetooth (${error?.message ?? String(error)}). This does not block flashing.`,
      "warn",
    );
    // A GATT failure must not discard a serial the advertisement already gave.
    return advertisedSerial
      ? {
          side,
          serialNumber: advertisedSerial,
          serialSource: "advertisement",
          modelNumber: null,
          hardwareRevision: null,
          firmwareRevision: null,
          variant: decodeGlassesSerial(advertisedSerial),
          observedAt: new Date().toISOString(),
        }
      : null;
  } finally {
    // Leave the link exactly as it was found. A temple that was already
    // connected for another reason must not be dropped by an advisory read.
    if (!wasConnected) {
      try {
        device.gatt.disconnect();
      } catch {
        // The read may already have lost the link; nothing to undo.
      }
    }
  }
}

// Identity established by the chooser filter rather than by reading anything.
//
// Stock Chrome permits no way to read a G2's serial: the standard Serial Number
// characteristic is blocklisted, and watchAdvertisements() - the one API that
// exposes the advertisement carrying it - is behind the experimental-features
// flag. So on a default browser, both automatic sources are closed.
//
// What is still available is the chooser filter. `requestDevice` was given a
// manufacturerData filter pinned to this serial, and the browser matched it
// against the real advertisement before listing the device. A device that came
// back through that chooser has therefore PROVEN it advertises this serial -
// the browser did the comparison we are not allowed to do ourselves.
//
// Weaker than a read, and honestly labelled: it confirms the temple against a
// serial the operator supplied, so a typo yields an empty chooser rather than a
// false match. It cannot discover an unknown serial.
export function chooserProvenIdentity(side, serial) {
  const normalized = normalizeGlassesSerial(serial);
  if (normalized.length < GLASSES_SERIAL_MIN_LENGTH) return null;
  return {
    side,
    serialNumber: normalized,
    serialSource: "chooser-filter",
    modelNumber: null,
    hardwareRevision: null,
    firmwareRevision: null,
    variant: decodeGlassesSerial(normalized),
    observedAt: new Date().toISOString(),
  };
}

// Decide whether the two temples an operator has connected may be flashed as
// one pair.
//
// Advisory-by-absence, blocking-by-evidence. A temple that never reported a
// serial yields "unverified" and must not stop the work — plenty of firmware
// states cannot answer a Device Information read, including the broken ones
// this tool exists to repair. But two serials that positively disagree is
// evidence, and the operator should be stopped and told, because from here the
// tool would otherwise drive two halves of two different pairs.
export function evaluateG2PairIdentity(left, right) {
  const leftSerial = left?.serialNumber ?? null;
  const rightSerial = right?.serialNumber ?? null;
  const comparison = compareTempleSerials(leftSerial, rightSerial);
  if (comparison.verdict === "mismatched") {
    return {
      status: "mismatched",
      comparison,
      blocking: true,
      message: templeSerialMismatchWarning(comparison),
    };
  }
  if (comparison.verdict === "matched") {
    const variant = decodeGlassesSerial(comparison.serial);
    return {
      status: "matched",
      comparison,
      blocking: false,
      serial: comparison.serial,
      variant,
      message: variant?.variantSummary
        ? `Both temples report serial ${comparison.serial} · ${variant.displayName} · ${variant.variantSummary}. This is one matched pair.`
        : `Both temples report serial ${comparison.serial}. This is one matched pair.`,
    };
  }
  const missing = [
    leftSerial ? null : "left",
    rightSerial ? null : "right",
  ].filter(Boolean);
  return {
    status: "unverified",
    comparison,
    blocking: false,
    message: missing.length
      ? `No serial number from the ${missing.join(" or ")} temple, so the two sides cannot be confirmed as one pair. Check the serial printed inside each temple by hand before flashing both sides.`
      : null,
  };
}

export function assertPinnedG2BleBundle(firmware) {
  const revocation = findG2FirmwareRevocation(firmware?.fileSha256);
  if (revocation) {
    throw new Error(
      `G2 firmware ${revocation.version} is revoked from Bluetooth recovery: ${revocation.reason}`,
    );
  }
  if (
    !firmware?.templeFlashEligible ||
    !firmware?.templeFlashTarget ||
    firmware.fileSha256 !== firmware.templeFlashTarget.imageSha256
  ) {
    throw new Error(
      "Direct Bluetooth recovery is restricted to an exact hash-pinned G2 temple bundle.",
    );
  }
  const components = firmware.componentImages;
  if (!Array.isArray(components) || components.length !== EXPECTED_COMPONENTS.length) {
    throw new Error(
      `Direct Bluetooth recovery requires the complete ${EXPECTED_COMPONENTS.length}-component G2 package.`,
    );
  }
  for (const [index, component] of components.entries()) {
    if (
      component?.name !== EXPECTED_COMPONENTS[index] ||
      component?.typeId !== EXPECTED_COMPONENT_TYPES[index] ||
      !(component.header instanceof Uint8Array) ||
      component.header.length !== 128 ||
      !(component.payload instanceof Uint8Array) ||
      component.payload.length !== component.payloadSize
    ) {
      throw new Error(
        `G2 Bluetooth component ${index + 1} does not match the reviewed package topology.`,
      );
    }
  }
  return firmware;
}

export class G2BleOtaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "G2BleOtaError";
    Object.assign(this, details);
  }
}

export class G2BleOtaSession {
  constructor(
    device,
    {
      side,
      log = () => {},
      progress = () => {},
      blockAckTimeoutMs = G2_BLE_BLOCK_ACK_TIMEOUT_MS,
      controlAckTimeoutMs = G2_BLE_CONTROL_ACK_TIMEOUT_MS,
      heartbeatIntervalMs = G2_BLE_HEARTBEAT_INTERVAL_MS,
      blockNakAttempts = G2_BLE_BLOCK_NAK_ATTEMPTS,
      componentAttempts = G2_BLE_COMPONENT_ATTEMPTS,
      componentRetrySettleMs = 1500,
      rebootSettleMs = G2_BLE_REBOOT_SETTLE_MS,
      lossReconnectDelayMs = G2_BLE_LOSS_RECONNECT_DELAY_MS,
      reconnectIntervalMs = G2_BLE_RECONNECT_INTERVAL_MS,
      reconnectAttempts = G2_BLE_RECONNECT_ATTEMPTS,
      initialConnectAttempts = G2_BLE_RECONNECT_ATTEMPTS,
      visibilityResumeSettleMs = G2_BLE_VISIBILITY_RESUME_SETTLE_MS,
      documentObject =
        typeof document === "undefined" ? null : document,
    } = {},
  ) {
    this.device = device;
    this.side = side;
    this.log = log;
    this.progress = progress;
    this.blockAckTimeoutMs = blockAckTimeoutMs;
    this.controlAckTimeoutMs = controlAckTimeoutMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.blockNakAttempts = blockNakAttempts;
    this.componentAttempts = componentAttempts;
    this.componentRetrySettleMs = componentRetrySettleMs;
    this.rebootSettleMs = rebootSettleMs;
    this.lossReconnectDelayMs = lossReconnectDelayMs;
    this.reconnectIntervalMs = reconnectIntervalMs;
    this.reconnectAttempts = reconnectAttempts;
    this.initialConnectAttempts = initialConnectAttempts;
    this.visibilityResumeSettleMs = visibilityResumeSettleMs;
    this.documentObject = documentObject;
    this.foregroundPauses = 0;
    this.sequence = 0;
    this.ackQueue = [];
    this.ackWaiters = [];
    this.writeTail = Promise.resolve();
    this.heartbeatTimer = null;
    this.heartbeatError = null;
    this.connectionRecoveries = 0;
    this.selectedDeviceId = device?.id ?? null;
    // Filled by readDeviceIdentity() on connect; stays null when the temple
    // does not publish Device Information.
    this.dataNotifyHandler = (event) => {
      const value = event?.target?.value;
      const ack = parseBleAck(value);
      if (!ack || ack.opcode === null || ack.status === null) return;
      const waiterIndex = this.ackWaiters.findIndex(
        (waiter) => waiter.opcode === ack.opcode,
      );
      if (waiterIndex >= 0) {
        const [waiter] = this.ackWaiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(ack.status);
      } else {
        this.ackQueue.push(ack);
      }
    };
  }

  nextSequence() {
    this.sequence = (this.sequence + 1) & 0xff;
    return this.sequence;
  }

  drainAcks() {
    this.ackQueue = [];
  }

  assertSelectedDeviceIdentity() {
    if (
      this.selectedDeviceId &&
      this.device?.id !== this.selectedDeviceId
    ) {
      throw new G2BleOtaError(
        `${this.side}: the Bluetooth device identity changed during recovery; refusing to connect to a different temple.`,
        {
          code: "DEVICE_ID_CHANGED",
          expectedDeviceId: this.selectedDeviceId,
          observedDeviceId: this.device?.id ?? null,
        },
      );
    }
    const observedSide = g2BleDeviceSide(this.device?.name);
    if (observedSide && observedSide !== this.side) {
      throw new G2BleOtaError(
        `${this.side}: the saved Bluetooth device now advertises as ${observedSide}; refusing the mismatched endpoint.`,
        {
          code: "DEVICE_SIDE_CHANGED",
          expectedSide: this.side,
          observedSide,
        },
      );
    }
  }

  async waitForForeground(boundary) {
    const page = this.documentObject;
    if (
      page?.visibilityState !== "hidden" ||
      typeof page.addEventListener !== "function"
    ) {
      return;
    }

    this.foregroundPauses += 1;
    this.log(
      `${this.side}: Bluetooth update paused before ${boundary} because the WebFlasher tab is hidden. No new OTA command will start until this tab is visible again.`,
      "warn",
    );
    do {
      await new Promise((resolve) => {
        const handleVisibilityChange = () => {
          if (page.visibilityState === "hidden") return;
          page.removeEventListener?.(
            "visibilitychange",
            handleVisibilityChange,
          );
          resolve();
        };
        page.addEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
        // Avoid missing a transition that happened between the initial check
        // and listener registration.
        handleVisibilityChange();
      });
      if (this.visibilityResumeSettleMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.visibilityResumeSettleMs),
        );
      }
    } while (page.visibilityState === "hidden");
    this.log(
      `${this.side}: WebFlasher is visible; resuming the Bluetooth update from the verified command boundary.`,
      "success",
    );
  }

  async connect() {
    this.assertSelectedDeviceIdentity();
    if (!this.device?.gatt) {
      throw new G2BleOtaError(`The selected ${this.side} temple has no GATT interface.`);
    }
    this.server = this.device.gatt.connected
      ? this.device.gatt
      : await this.device.gatt.connect();
    // Keep discovery and CCCD writes strictly serialized. CoreBluetooth
    // occasionally surfaces concurrent Web Bluetooth GATT operations as
    // "operation already in progress" even though the services are unrelated.
    const dataService = await this.server.getPrimaryService(
      G2_BLE_DATA_SERVICE,
    );
    const controlService = await this.server.getPrimaryService(
      G2_BLE_CONTROL_SERVICE,
    );
    this.dataWrite = await dataService.getCharacteristic(G2_BLE_DATA_WRITE);
    this.dataNotify = await dataService.getCharacteristic(G2_BLE_DATA_NOTIFY);
    this.controlWrite = await controlService.getCharacteristic(
      G2_BLE_CONTROL_WRITE,
    );
    this.controlNotify = await controlService.getCharacteristic(
      G2_BLE_CONTROL_NOTIFY,
    );
    this.dataNotify.addEventListener(
      "characteristicvaluechanged",
      this.dataNotifyHandler,
    );
    await this.dataNotify.startNotifications();
    await this.controlNotify.startNotifications();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    this.drainAcks();
    this.log(
      `${this.side}: direct Bluetooth OTA services and notifications are ready.`,
      "success",
    );
  }

  async connectForTransfer() {
    let lastError = null;
    for (
      let attempt = 1;
      attempt <= this.initialConnectAttempts;
      attempt += 1
    ) {
      if (attempt > 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.reconnectIntervalMs),
        );
      }
      try {
        await this.connect();
        if (attempt > 1) {
          this.log(
            `${this.side}: selected temple became reachable again · initial Bluetooth reconnect ${attempt}/${this.initialConnectAttempts}.`,
            "success",
          );
        }
        return { attempts: attempt };
      } catch (error) {
        lastError = error;
        this.dataNotify?.removeEventListener?.(
          "characteristicvaluechanged",
          this.dataNotifyHandler,
        );
        try {
          this.device?.gatt?.disconnect();
        } catch {
          // The failed connection attempt may already have closed the link.
        }
        this.writeTail = Promise.resolve();
        if (attempt < this.initialConnectAttempts) {
          this.log(
            `${this.side}: selected temple is not reachable yet (${error?.message ?? String(error)}). Waiting for it to advertise · initial Bluetooth reconnect ${attempt + 1}/${this.initialConnectAttempts}.`,
            "warn",
          );
        }
      }
    }
    throw new G2BleOtaError(
      `${this.side}: selected temple did not become reachable after ${this.initialConnectAttempts} bounded Bluetooth connection attempts: ${lastError?.message ?? "unknown connection error"}`,
      {
        code: "INITIAL_CONNECT_FAILED",
        attempts: this.initialConnectAttempts,
        cause: lastError,
      },
    );
  }

  async disconnect() {
    this.stopHeartbeat();
    for (const waiter of this.ackWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new G2BleOtaError(`${this.side}: Bluetooth OTA session closed.`),
      );
    }
    try {
      this.dataNotify?.removeEventListener(
        "characteristicvaluechanged",
        this.dataNotifyHandler,
      );
      await this.dataNotify?.stopNotifications();
    } catch {
      // A successful OTA commonly reboots the temple before cleanup.
    }
    try {
      await this.controlNotify?.stopNotifications();
    } catch {
      // A successful OTA commonly reboots the temple before cleanup.
    }
    try {
      this.device?.gatt?.disconnect();
    } catch {
      // The device may already have rebooted and disconnected.
    }
  }

  async reconnectAfterLoss(context, { reenterPackage = true } = {}) {
    const deviceId = this.selectedDeviceId ?? "unavailable";
    this.log(
      `${this.side}: Bluetooth connection was lost during ${context}. Waiting 10 seconds for the same paired temple to reboot and advertise before reconnecting with saved device ID ${deviceId}; the chooser will not reopen.`,
      "warn",
    );
    this.progress(
      undefined,
      `${this.side}: connection lost · waiting 10 seconds to reconnect the saved endpoint`,
      "reconnecting",
    );
    await this.disconnect();
    this.heartbeatError = null;
    this.writeTail = Promise.resolve();
    if (this.lossReconnectDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.lossReconnectDelayMs),
      );
    }

    let lastError = null;
    for (let attempt = 1; attempt <= this.reconnectAttempts; attempt += 1) {
      if (attempt > 1 && this.reconnectIntervalMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.reconnectIntervalMs),
        );
      }
      try {
        this.assertSelectedDeviceIdentity();
        await this.connect();
        this.startHeartbeat();
        let beginStatus = null;
        if (reenterPackage) {
          beginStatus = await this.sendControl(0x00);
          if (!END_OK.has(beginStatus)) {
            this.log(
              `${this.side}: reconnect BEGIN returned ${beginStatus} (${g2BleStatusName(beginStatus)}); continuing because the next FILE_CHECK remains authoritative.`,
              "warn",
            );
          }
        }
        this.connectionRecoveries += 1;
        this.log(
          `${this.side}: reconnected saved Bluetooth device ID ${deviceId} after the 10-second recovery pause · attempt ${attempt}/${this.reconnectAttempts}. Resuming from the last verified component boundary.`,
          "success",
        );
        this.progress(
          undefined,
          `${this.side}: saved endpoint reconnected · resuming safely`,
          "flashing",
        );
        return {
          attempts: attempt,
          deviceId: this.selectedDeviceId,
          beginStatus,
        };
      } catch (error) {
        lastError = error;
        this.stopHeartbeat();
        this.dataNotify?.removeEventListener?.(
          "characteristicvaluechanged",
          this.dataNotifyHandler,
        );
        try {
          this.device?.gatt?.disconnect();
        } catch {
          // The failed attempt may already have closed its transient link.
        }
        this.writeTail = Promise.resolve();
        if (attempt < this.reconnectAttempts) {
          this.log(
            `${this.side}: saved device ID ${deviceId} is not reachable yet (${error?.message ?? String(error)}) · reconnect attempt ${attempt + 1}/${this.reconnectAttempts} will follow.`,
            "warn",
          );
        }
      }
    }
    throw new G2BleOtaError(
      `${this.side}: the saved Bluetooth device ID ${deviceId} did not reconnect after the 10-second recovery pause and ${this.reconnectAttempts} bounded attempts: ${lastError?.message ?? "unknown connection error"}`,
      {
        code: "RECONNECT_FAILED",
        attempts: this.reconnectAttempts,
        deviceId: this.selectedDeviceId,
        cause: lastError,
      },
    );
  }

  waitForAck(opcode, timeoutMs) {
    const queuedIndex = this.ackQueue.findIndex(
      (ack) => ack.opcode === opcode,
    );
    if (queuedIndex >= 0) {
      const [ack] = this.ackQueue.splice(queuedIndex, 1);
      return Promise.resolve(ack.status);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        opcode,
        resolve,
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        const index = this.ackWaiters.indexOf(waiter);
        if (index >= 0) this.ackWaiters.splice(index, 1);
        reject(
          new G2BleOtaError(
            `${this.side}: no Bluetooth OTA acknowledgement for opcode 0x${opcode
              .toString(16)
              .padStart(2, "0")}.`,
            { code: "ACK_TIMEOUT", opcode },
          ),
        );
      }, timeoutMs);
      this.ackWaiters.push(waiter);
    });
  }

  writeFrames(characteristic, frames) {
    const operation = this.writeTail
      .catch(() => {})
      .then(async () => {
        for (const frame of frames) {
          if (typeof characteristic.writeValueWithoutResponse === "function") {
            await characteristic.writeValueWithoutResponse(frame);
          } else {
            await characteristic.writeValue(frame);
          }
        }
      });
    this.writeTail = operation;
    return operation;
  }

  async sendControl(opcode, data = new Uint8Array(), timeoutMs) {
    await this.waitForForeground("the next control command");
    this.drainAcks();
    const frames = makeBleControlFrames(
      opcode,
      data,
      this.nextSequence(),
    );
    await this.writeFrames(this.dataWrite, frames);
    return this.waitForAck(
      opcode,
      timeoutMs ?? this.controlAckTimeoutMs,
    );
  }

  async sendBlock(block) {
    await this.waitForForeground("the next 4 KB block");
    const sequence = this.nextSequence();
    const frames = [
      ...makeBleControlFrames(0x02, new Uint8Array(), sequence),
      ...makeBleEnvelopeFrames(0xc1, block, { sequence }),
    ];
    this.drainAcks();
    await this.writeFrames(this.dataWrite, frames);
    return this.waitForAck(0x02, this.blockAckTimeoutMs);
  }

  startHeartbeat() {
    this.heartbeatError = null;
    this.heartbeatTimer = setInterval(() => {
      const frames = makeBleEnvelopeFrames(0x80, HEARTBEAT_PAYLOAD, {
        sequence: this.nextSequence(),
      });
      void this.writeFrames(this.controlWrite, frames).catch((error) => {
        this.heartbeatError ??= error;
      });
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async settleFinalUpdate(endStatus) {
    this.stopHeartbeat();
    // A heartbeat may already be queued behind the final END write. Let that
    // queue settle before deciding whether its failure was the expected reboot.
    await this.writeTail.catch(() => {});
    this.log(
      `${this.side}: final END ${endStatus} (${g2BleStatusName(endStatus)}) is verified. Pausing 10 seconds for the temple reboot before reconnecting the same paired device ID ${this.selectedDeviceId ?? "unavailable"}.`,
      "warn",
    );
    this.progress(
      undefined,
      `${this.side}: final END verified · waiting 10 seconds for reboot`,
      "reconnecting",
    );
    await new Promise((resolve) => setTimeout(resolve, this.rebootSettleMs));

    const rebootObserved = !this.device?.gatt?.connected;
    const finalHeartbeatError = this.heartbeatError;
    if (rebootObserved) {
      this.log(
        `${this.side}: final END ${endStatus} (${g2BleStatusName(endStatus)}) triggered the expected temple reboot. The 10-second reboot pause is complete; reconnecting the same paired device ID ${this.selectedDeviceId ?? "unavailable"}.`,
        "warn",
      );
    } else {
      this.log(
        `${this.side}: final END ${endStatus} (${g2BleStatusName(endStatus)}) was verified before a reboot disconnect was observed. Closing the completed OTA link and performing a fresh GATT reconnect without replaying firmware.`,
        "warn",
      );
    }
    // Clear the old notification subscriptions in both cases. A rebooted GATT
    // server invalidates them, while a still-live server is deliberately
    // disconnected so the selected Web Bluetooth handle must prove a fresh
    // post-END connection.
    await this.disconnect();
    let lastError = finalHeartbeatError;
    this.heartbeatError = null;
    this.writeTail = Promise.resolve();
    for (let attempt = 1; attempt <= this.reconnectAttempts; attempt += 1) {
      if (attempt > 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.reconnectIntervalMs),
        );
      }
      try {
        this.assertSelectedDeviceIdentity();
        await this.connect();
        this.log(
          `${this.side}: fresh post-END Bluetooth reconnect ${attempt}/${this.reconnectAttempts} verified GATT liveness on saved device ID ${this.selectedDeviceId ?? "unavailable"}${rebootObserved ? " after the observed firmware reboot and 10-second pause" : " after the completed OTA link was closed"}.`,
          "success",
        );
        return {
          expectedReboot: true,
          rebootObserved,
          freshReconnectAttempted: true,
          reconnected: true,
          reconnectAttempts: attempt,
        };
      } catch (error) {
        lastError = error;
        try {
          this.device?.gatt?.disconnect();
        } catch {
          // The failed attempt may already have closed the transient link.
        }
        if (attempt < this.reconnectAttempts) {
          this.log(
            `${this.side}: saved post-update device ID ${this.selectedDeviceId ?? "unavailable"} is not reachable yet (${error?.message ?? String(error)}) · reconnect attempt ${attempt + 1}/${this.reconnectAttempts} will follow.`,
            "warn",
          );
        }
      }
    }

    // All payload blocks and the final END response are unambiguous. Replaying
    // the package here would be less safe than preserving that proof and using
    // the required Case reset/version interrogation as the authoritative boot
    // check after both temples have been transferred.
    this.log(
      `${this.side}: all final-image blocks and END ${endStatus} were verified, but the temple did not accept a fresh post-END GATT connection within ${this.reconnectAttempts} bounded attempts${lastError?.message ? ` (${lastError.message})` : ""}. No firmware will be replayed; deferring version authority to the final Case check.`,
      "warn",
    );
    return {
      expectedReboot: true,
      rebootObserved,
      freshReconnectAttempted: true,
      reconnected: false,
      reconnectAttempts: this.reconnectAttempts,
      reconnectError: lastError?.message ?? null,
    };
  }

  async flashComponent(component, componentIndex, totals) {
    const blockCount = Math.ceil(
      component.payload.length / G2_BLE_BLOCK_BYTES,
    );
    let lastError = null;
    for (let attempt = 1; attempt <= this.componentAttempts; attempt += 1) {
      let attemptAccepted = 0;
      if (attempt > 1) {
        this.log(
          `${this.side}: restarting ${component.name} from FILE_CHECK · attempt ${attempt}/${this.componentAttempts}.`,
          "warn",
        );
        await new Promise((resolve) =>
          setTimeout(resolve, this.componentRetrySettleMs),
        );
      }
      try {
        const fileCheckStatus = await this.sendControl(
          0x01,
          component.header,
        );
        if (fileCheckStatus !== 0) {
          throw new G2BleOtaError(
            `${this.side}: ${component.name} FILE_CHECK returned ${fileCheckStatus} (${g2BleStatusName(fileCheckStatus)}).`,
            { code: "FILE_CHECK_REJECTED", status: fileCheckStatus },
          );
        }
        for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
          const block = component.payload.subarray(
            blockIndex * G2_BLE_BLOCK_BYTES,
            (blockIndex + 1) * G2_BLE_BLOCK_BYTES,
          );
          let accepted = false;
          let lastStatus = null;
          for (
            let blockAttempt = 1;
            blockAttempt <= this.blockNakAttempts;
            blockAttempt += 1
          ) {
            const status = await this.sendBlock(block);
            lastStatus = status;
            if (status === 0) {
              accepted = true;
              break;
            }
            this.log(
              `${this.side}: ${component.name} block ${blockIndex + 1}/${blockCount} explicitly rejected with ${status} (${g2BleStatusName(status)}) · block attempt ${blockAttempt}/${this.blockNakAttempts}. The rejected block did not advance and may be sent again.`,
              "warn",
            );
          }
          if (!accepted) {
            throw new G2BleOtaError(
              `${this.side}: ${component.name} block ${blockIndex + 1} remained rejected after ${this.blockNakAttempts} block attempts.`,
              {
                code: "BLOCK_REJECTED",
                blockIndex,
                blockAttempts: this.blockNakAttempts,
                status: lastStatus,
              },
            );
          }
          attemptAccepted += block.length;
          const completed =
            totals.completedBeforeComponent + attemptAccepted;
          totals.highWater = Math.max(totals.highWater, completed);
          this.progress(
            totals.highWater / totals.totalBytes,
            `${this.side}: ${component.name} block ${blockIndex + 1}/${blockCount}`,
          );
        }
        const endStatus = await this.sendControl(0x03);
        if (!END_OK.has(endStatus)) {
          throw new G2BleOtaError(
            `${this.side}: ${component.name} END verification returned ${endStatus} (${g2BleStatusName(endStatus)}).`,
            { code: "END_REJECTED", status: endStatus },
          );
        }
        this.log(
          `${this.side}: verified ${component.name} · ${blockCount} block ACKs · END ${endStatus} (${g2BleStatusName(endStatus)}).`,
          "success",
        );
        totals.completedBeforeComponent += component.payload.length;
        totals.highWater = totals.completedBeforeComponent;
        return {
          name: component.name,
          payloadBytes: component.payload.length,
          blocks: blockCount,
          endStatus,
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;
        const connectionLost = isG2BleConnectionLoss(error, this.device);
        if (
          error?.code === "ACK_TIMEOUT" &&
          error?.opcode === 0x02
        ) {
          this.log(
            `${this.side}: ${component.name} block ACK timed out. The write outcome is ambiguous, so this block will not be replayed; the whole component will restart from FILE_CHECK.`,
            "warn",
          );
        } else {
          this.log(
            `${this.side}: ${component.name} attempt ${attempt}/${this.componentAttempts} stopped · ${error.message}`,
            "warn",
          );
        }
        if (connectionLost && attempt < this.componentAttempts) {
          try {
            await this.reconnectAfterLoss(
              `${component.name} attempt ${attempt}/${this.componentAttempts}`,
            );
          } catch (reconnectError) {
            lastError = reconnectError;
            break;
          }
        }
      }
    }
    throw new G2BleOtaError(
      `${this.side}: ${component.name} failed after ${this.componentAttempts} complete component attempts: ${lastError?.message ?? "unknown error"}`,
      {
        code: "COMPONENT_FAILED",
        cause: lastError,
        componentIndex,
        componentName: component.name,
        attempts: this.componentAttempts,
      },
    );
  }

  async flashBundle(firmware, { progressBase = 0, progressSpan = 1 } = {}) {
    assertPinnedG2BleBundle(firmware);
    this.sequence = 0;
    const totalBytes = firmware.componentImages.reduce(
      (sum, component) => sum + component.payload.length,
      0,
    );
    const totals = {
      totalBytes,
      completedBeforeComponent: 0,
      highWater: 0,
    };
    const componentResults = [];
    this.progress(
      progressBase,
      `${this.side}: starting the pinned six-component Bluetooth package`,
    );
    try {
      await this.connectForTransfer();
      this.startHeartbeat();
      let beginStatus;
      try {
        beginStatus = await this.sendControl(0x00);
      } catch (error) {
        if (!isG2BleConnectionLoss(error, this.device)) throw error;
        const recovery = await this.reconnectAfterLoss(
          "the package BEGIN command",
        );
        beginStatus = recovery.beginStatus;
      }
      if (!END_OK.has(beginStatus)) {
        this.log(
          `${this.side}: BEGIN returned ${beginStatus} (${g2BleStatusName(beginStatus)}); continuing because FILE_CHECK remains the authoritative per-component gate.`,
          "warn",
        );
      }
      for (const [index, component] of firmware.componentImages.entries()) {
        const result = await this.flashComponent(
          component,
          index,
          totals,
        );
        componentResults.push(result);
        const localFraction = totals.completedBeforeComponent / totalBytes;
        this.progress(
          progressBase + localFraction * progressSpan,
          `${this.side}: verified ${index + 1}/${firmware.componentImages.length} components`,
        );
        const isFinalComponent =
          index === firmware.componentImages.length - 1;
        if (
          isFinalComponent &&
          (result.endStatus === 8 || result.endStatus === 9)
        ) {
          result.postUpdate = await this.settleFinalUpdate(result.endStatus);
        } else if (this.heartbeatError) {
          const heartbeatError = this.heartbeatError;
          if (!isG2BleConnectionLoss(heartbeatError, this.device)) {
            throw heartbeatError;
          }
          await this.reconnectAfterLoss(
            `the verified ${component.name} boundary`,
          );
        }
      }
    } catch (error) {
      const failureCause = error?.cause;
      const partialResult = {
        side: this.side,
        deviceName: this.device.name,
        imageSha256: firmware.fileSha256,
        version: firmware.g2Version,
        reportedVersion: g2BleTargetReportedVersion(firmware),
        components: [...componentResults],
        completedComponentCount: componentResults.length,
        blockAcks: componentResults.reduce(
          (sum, component) => sum + component.blocks,
          0,
        ),
        verifiedPayloadBytes: componentResults.reduce(
          (sum, component) => sum + component.payloadBytes,
          0,
        ),
        progressHighWaterBytes: totals.highWater,
        foregroundPauses: this.foregroundPauses,
        connectionRecoveries: this.connectionRecoveries,
        failure: {
          message: error?.message ?? String(error),
          code: error?.code ?? null,
          componentIndex: error?.componentIndex ?? null,
          componentName: error?.componentName ?? null,
          attempts: error?.attempts ?? null,
          cause: failureCause
            ? {
                message: failureCause.message ?? String(failureCause),
                code: failureCause.code ?? null,
                status: failureCause.status ?? null,
                blockIndex: failureCause.blockIndex ?? null,
                blockAttempts: failureCause.blockAttempts ?? null,
                opcode: failureCause.opcode ?? null,
              }
            : null,
        },
        outcome: "failed_or_partial",
      };
      if (error && typeof error === "object") {
        error.partialResult = partialResult;
      }
      throw error;
    } finally {
      this.stopHeartbeat();
    }
    this.progress(
      progressBase + progressSpan,
      `${this.side}: all six Bluetooth OTA components verified`,
    );
    return {
      side: this.side,
      deviceName: this.device.name,
      imageSha256: firmware.fileSha256,
      version: firmware.g2Version,
      reportedVersion: g2BleTargetReportedVersion(firmware),
      components: componentResults,
      blockAcks: componentResults.reduce(
        (sum, component) => sum + component.blocks,
        0,
      ),
      foregroundPauses: this.foregroundPauses,
      connectionRecoveries: this.connectionRecoveries,
      outcome: "success",
    };
  }
}

export async function flashG2BleSessionsConcurrently(
  entries,
  firmware,
  { onSettled = () => {} } = {},
) {
  const sessions = Array.isArray(entries) ? entries : [];
  const notifySettled = (outcome) => {
    try {
      onSettled(outcome);
    } catch {
      // Status presentation must never change a hardware outcome.
    }
    return outcome;
  };
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const tasks = sessions.map(({ side, device, session }) =>
      (async () => {
        await startGate;
        try {
          return await session.flashBundle(firmware);
        } finally {
          await session.disconnect();
        }
      })().then(
        (value) => {
          notifySettled({ side, device, status: "fulfilled", value });
          return value;
        },
        (reason) => {
          notifySettled({ side, device, status: "rejected", reason });
          throw reason;
        },
      ),
  );
  // Every side is registered and waiting before either endpoint begins its
  // GATT connection. A failure in one task cannot prevent the other task from
  // crossing this gate or continuing to completion.
  releaseStart();
  const settled = await Promise.allSettled(tasks);
  return settled.map((outcome, index) => ({
    side: sessions[index]?.side ?? null,
    device: sessions[index]?.device ?? null,
    ...outcome,
  }));
}
