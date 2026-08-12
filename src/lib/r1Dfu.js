import { unzipSync } from "fflate";

export const R1_DFU_SERVICE_UUID = "0000fe59-0000-1000-8000-00805f9b34fb";
export const R1_DFU_CONTROL_POINT_UUID =
  "8ec90001-f315-4f60-9fb8-838830daea50";
export const R1_DFU_PACKET_UUID = "8ec90002-f315-4f60-9fb8-838830daea50";
export const R1_BUTTONLESS_DFU_UUID =
  "8ec90003-f315-4f60-9fb8-838830daea50";

function pinnedR1Release({
  version,
  size,
  md5,
  sha256,
  binSize,
  binSha256,
  datSha256,
}) {
  return Object.freeze({
    id: `r1-official-${version}`,
    version,
    fileName: `r1-${version}-${md5}.zip`,
    size,
    md5,
    sha256,
    format: "nordic-secure-dfu",
    application: Object.freeze({
      binFile: "application.bin",
      binSize,
      binSha256,
      datFile: "application.dat",
      datSize: 141,
      datSha256,
    }),
  });
}

export const R1_PINNED_RELEASES = Object.freeze([
  pinnedR1Release({
    version: "2.2.8.0002",
    size: 650915,
    md5: "ce5aa289bf6c95a293d41bd48c123e40",
    sha256: "662ca213e628f6bd82b8cd930bd63d6c1efe00b6f470fd6ed21e6367712bfdb7",
    binSize: 650284,
    binSha256: "41ea4fdcf1b2d1d3702c41669983b4ef0817ee4eb789f8eebc7dd6102609e274",
    datSha256: "1b9ede75c2d95b6d97e5b51dc396e0433d2575c4e04f63cc77e26218ccf13ea8",
  }),
  pinnedR1Release({
    version: "2.2.7.0005",
    size: 650007,
    md5: "be359b28954f8fe4a94ec21a58415d59",
    sha256: "6222e4bb334b531c3d2cfedfae2a26f609f0ffd99bd60a50bc8cced645c9eba5",
    binSize: 649376,
    binSha256: "2d38253e00b887ced3f1e2c049db21254b0974091bc954a82c13e21c48b064c2",
    datSha256: "68447d4dfc0ad7d77270797fe0dbf4311faef7eb5e275342033e5b373be93be9",
  }),
  pinnedR1Release({
    version: "2.2.6.0009",
    size: 647039,
    md5: "9eca8ae9d5117abda4f72f39bdb44ad2",
    sha256: "492baf487734720732f82f404624e0c3b3af3b01d30727366238e154164ad0dd",
    binSize: 646408,
    binSha256: "0e788d433ea50fd36edb8f21a9c18b6062211e4a36dbc5bd7695ea5827f3aa1a",
    datSha256: "305da36784e527b3e434f2cf45019a290bf5c14cbceb2e57c9e61dcdfdb1f253",
  }),
  pinnedR1Release({
    version: "2.2.5.0005",
    size: 644583,
    md5: "83038dad13c339f9e5f2e5fc828a00b3",
    sha256: "46102dd54d86fb24fb5f1a2c8ba9f9d54e6a603659240dd59fc43b1ee564e778",
    binSize: 643952,
    binSha256: "221fb44aa6ff954dc73978d3848ed466913e2bebcfada4aaa8984610d7e2a6e2",
    datSha256: "e4518bc50ee225024cca96dd581d955f9650dc8b0450060fa7b22b9ccf4c0847",
  }),
  pinnedR1Release({
    version: "2.2.4.0003",
    size: 638259,
    md5: "248978eb758a342a0254d6dae45bfdb2",
    sha256: "549d60061c1cc9cde94da5c3c0efc0e7220272aca6c872c49bde0ec30ae16dcc",
    binSize: 637628,
    binSha256: "a347128b46bfb01e6c02bc2a93768bc0838ae73c1e7ad401dd29841cc930647f",
    datSha256: "56f017384d7bbc73f47f018b601dd13bceda3f27f4b09f2f89586981c1429e0e",
  }),
  pinnedR1Release({
    version: "2.2.0.0014",
    size: 633367,
    md5: "9ae5429275afdcb2ff86c53152bef1cb",
    sha256: "9ce535518d1321a27186394355e05aff7b4ba76be58c8de1a0dfcf3b01395d00",
    binSize: 632736,
    binSha256: "590584f3d56dc4b495d6454823fe177f042225b55c7d098abab479041f641d36",
    datSha256: "e77d2fdf34eb94e3d955e0b23e0913b4622d46c9f9aa5b5ff0b8cc29f23a85c1",
  }),
  pinnedR1Release({
    version: "2.0.8.0012",
    size: 626207,
    md5: "90a6479e4d736365192f30556cba44a5",
    sha256: "6bc6567f656d3905683000278af529ad516f45d8e9516618ffad2cb4ea7adf2b",
    binSize: 625576,
    binSha256: "8a3db3c56bf4cddd0a02eebc4090857f6e8907ae2108ce9487f8b8bdee7c96df",
    datSha256: "fb80c99d3eba14e8ae80ca7908bdb3bb928e5829968f37f247a8b7e3041f7c63",
  }),
  pinnedR1Release({
    version: "2.0.7.0004",
    size: 628831,
    md5: "692af8c7baed67e20c5920d350dd466e",
    sha256: "ba499025ab86cf3679eb5f19e6322422c1ef7f3304ce386f7e1e1dddf7ef5e08",
    binSize: 628200,
    binSha256: "1045569b5ca10cdb6c3991304f8b7273c18cd302b28d65f2647ed947984c8f2a",
    datSha256: "3b9fc345ca31f709732debfa5cc81b00dfb78ed56f90e592ca82287249fd4dcc",
  }),
  pinnedR1Release({
    version: "2.0.6.0005",
    size: 622931,
    md5: "37c8d118670c97f3e218c4a5f2f30951",
    sha256: "5ef38db1e80a40859dd14e2914732193d8e3162ef118e37173e3fa45125d1d85",
    binSize: 622300,
    binSha256: "5ef4eb77076c1054bf95c7781787963607a6a61af4b338cb98c39ca7fa7831b6",
    datSha256: "376d60acc327068dd7c1fe4d3133c32a512b762bde19ef00866432f71e2aba4d",
  }),
  pinnedR1Release({
    version: "2.0.5.0004",
    size: 618755,
    md5: "3f7990f1d725be5c544103dc03e1ae54",
    sha256: "893e9c72e5ad1ef2950309c4ed48a81af8bbedd920240d8bf6ebf4be122b5763",
    binSize: 618124,
    binSha256: "5fb80f2f4f1cc37299bdfc9695d08c13d5d5052dfd64d485852aba098d66dcec",
    datSha256: "afa75e575683db8a219c4b01ac9a0b32c76c6dcea2ea71f7db5ccf7bdd632eba",
  }),
  pinnedR1Release({
    version: "2.0.3.0013",
    size: 619023,
    md5: "da3c754078c1e9dd0b2fe282e4614783",
    sha256: "a24ddd6c580a2706f98c06b6504bb34af7159024ad8bb066eca6ae684e533c6f",
    binSize: 618392,
    binSha256: "c74c61beb5c30f671d2094a3f9a9310dbb556e7cf01d73c77dfca66d31a2b590",
    datSha256: "816e350b7d36240b7e33252141680baf39da06f7619bb1e51d80df83d73068b5",
  }),
]);

export const R1_PINNED_RELEASE = R1_PINNED_RELEASES[0];

const RESPONSE = 0x60;
const SUCCESS = 0x01;
const OP_CREATE = 0x01;
const OP_SET_PRN = 0x02;
const OP_CALCULATE_CRC = 0x03;
const OP_EXECUTE = 0x04;
const OP_SELECT = 0x06;
const OBJECT_COMMAND = 0x01;
const OBJECT_DATA = 0x02;
const PACKET_BYTES = 20;
export const R1_DFU_PACKET_RECEIPT_INTERVAL = 12;
const PACKET_RECEIPT_TIMEOUT_MS = 10000;

function asBytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function littleEndian32(value) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function concatBytes(...parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of asBytes(bytes)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 is unavailable. Open WebFlasher over HTTPS in Chrome.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", asBytes(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assertExact(value, expected, label) {
  if (value !== expected) {
    throw new Error(`R1 ${label} did not match the reviewed update package.`);
  }
}

export function assertPinnedR1Release(release) {
  const pinned = R1_PINNED_RELEASES.find((candidate) => candidate.id === release?.id);
  if (!pinned) {
    throw new Error("The selected R1 release is not trusted by this WebFlasher build.");
  }
  for (const key of ["version", "fileName", "size", "md5", "sha256", "format"]) {
    assertExact(release[key], pinned[key], key);
  }
  const application = release.application ?? {};
  for (const key of [
    "binFile",
    "binSize",
    "binSha256",
    "datFile",
    "datSize",
    "datSha256",
  ]) {
    assertExact(application[key], pinned.application[key], `application ${key}`);
  }
  return release;
}

export async function prepareR1DfuPackage(archive, release) {
  assertPinnedR1Release(release);
  const bytes = asBytes(archive);
  assertExact(bytes.length, release.size, "archive size");
  assertExact(await sha256(bytes), release.sha256, "archive SHA-256");

  let files;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error(`The R1 update ZIP could not be opened: ${error.message}`);
  }
  const names = Object.keys(files).sort();
  const expectedNames = ["application.bin", "application.dat", "manifest.json"];
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error("The R1 update ZIP contains an unexpected file set.");
  }
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  const declared = manifest?.manifest?.application;
  assertExact(declared?.bin_file, release.application.binFile, "manifest binary");
  assertExact(declared?.dat_file, release.application.datFile, "manifest init packet");

  const application = files[release.application.binFile];
  const initPacket = files[release.application.datFile];
  assertExact(application.length, release.application.binSize, "application size");
  assertExact(initPacket.length, release.application.datSize, "init-packet size");
  assertExact(
    await sha256(application),
    release.application.binSha256,
    "application SHA-256",
  );
  assertExact(
    await sha256(initPacket),
    release.application.datSha256,
    "init-packet SHA-256",
  );
  return { application, initPacket };
}

function requireWebBluetooth() {
  if (!navigator.bluetooth) {
    throw new Error("R1 updates require Web Bluetooth in desktop Chrome or Edge.");
  }
}

export async function requestR1ApplicationDevice() {
  requireWebBluetooth();
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: "EVEN R1" }, { namePrefix: "BCL60" }],
    optionalServices: [R1_DFU_SERVICE_UUID],
  });
  if (!/^(EVEN R1|BCL60)/i.test(device.name ?? "")) {
    throw new Error("The selected Bluetooth device is not an R1 ring.");
  }
  return device;
}

export async function requestR1DfuDevice() {
  requireWebBluetooth();
  return navigator.bluetooth.requestDevice({
    filters: [{ services: [R1_DFU_SERVICE_UUID] }],
  });
}

function waitForDisconnect(device, timeoutMs = 15000) {
  if (!device.gatt?.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      device.removeEventListener("gattserverdisconnected", disconnected);
      reject(new Error("The R1 did not restart into DFU mode."));
    }, timeoutMs);
    const disconnected = () => {
      clearTimeout(timeout);
      resolve();
    };
    device.addEventListener("gattserverdisconnected", disconnected, { once: true });
  });
}

export async function enterR1DfuMode(device) {
  if (!device) throw new Error("Select the connected R1 ring first.");
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  const service = await server.getPrimaryService(R1_DFU_SERVICE_UUID);
  const buttonless = await service.getCharacteristic(R1_BUTTONLESS_DFU_UUID);
  await buttonless.startNotifications();
  const disconnected = waitForDisconnect(device);
  await buttonless.writeValueWithResponse(new Uint8Array([0x01]));
  await disconnected;
}

export function parseDfuResponse(value, expectedOperation) {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length < 3 || bytes[0] !== RESPONSE) return null;
  if (bytes[1] !== expectedOperation) {
    throw new Error(
      `R1 DFU replied to operation 0x${bytes[1].toString(16)} while 0x${expectedOperation.toString(16)} was pending.`,
    );
  }
  if (bytes[2] !== SUCCESS) {
    throw new Error(
      `R1 DFU rejected operation 0x${expectedOperation.toString(16)} with status 0x${bytes[2].toString(16)}.`,
    );
  }
  return bytes.subarray(3);
}

export class R1SecureDfuSession {
  constructor(
    device,
    {
      onProgress = () => {},
      packetReceiptInterval = R1_DFU_PACKET_RECEIPT_INTERVAL,
      packetReceiptTimeoutMs = PACKET_RECEIPT_TIMEOUT_MS,
    } = {},
  ) {
    if (
      !Number.isInteger(packetReceiptInterval)
      || packetReceiptInterval < 1
      || packetReceiptInterval > 0xffff
    ) {
      throw new Error("R1 DFU packet-receipt interval must be between 1 and 65535.");
    }
    if (!Number.isFinite(packetReceiptTimeoutMs) || packetReceiptTimeoutMs <= 0) {
      throw new Error("R1 DFU packet-receipt timeout must be positive.");
    }
    this.device = device;
    this.onProgress = onProgress;
    this.configuredPacketReceiptInterval = packetReceiptInterval;
    this.activePacketReceiptInterval = 0;
    this.packetReceiptTimeoutMs = packetReceiptTimeoutMs;
    this.control = null;
    this.packet = null;
    this.pendingResponse = null;
    this.pendingPacketReceipt = null;
    this.handleNotification = this.handleNotification.bind(this);
  }

  handleNotification(event) {
    const value = event.target.value;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (
      this.pendingPacketReceipt
      && bytes.length >= 2
      && bytes[0] === RESPONSE
      && bytes[1] === OP_CALCULATE_CRC
    ) {
      const pending = this.pendingPacketReceipt;
      this.pendingPacketReceipt = null;
      clearTimeout(pending.timeout);
      try {
        pending.resolve(parseDfuResponse(value, OP_CALCULATE_CRC));
      } catch (error) {
        pending.reject(error);
      }
      return;
    }
    if (!this.pendingResponse) return;
    try {
      const payload = parseDfuResponse(
        value,
        this.pendingResponse.operation,
      );
      if (!payload) return;
      const pending = this.pendingResponse;
      this.pendingResponse = null;
      clearTimeout(pending.timeout);
      pending.resolve(payload);
    } catch (error) {
      const pending = this.pendingResponse;
      this.pendingResponse = null;
      if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
    }
  }

  async connect() {
    if (!this.device?.gatt) throw new Error("Select the R1 DFU device first.");
    const server = this.device.gatt.connected
      ? this.device.gatt
      : await this.device.gatt.connect();
    const service = await server.getPrimaryService(R1_DFU_SERVICE_UUID);
    this.control = await service.getCharacteristic(R1_DFU_CONTROL_POINT_UUID);
    this.packet = await service.getCharacteristic(R1_DFU_PACKET_UUID);
    this.control.addEventListener("characteristicvaluechanged", this.handleNotification);
    await this.control.startNotifications();
    // Nordic's reference updater disables PRNs for the short command object,
    // then enables them only after the signed init packet has executed. That
    // keeps the packet counter aligned to the application data stream.
    await this.setPacketReceiptNotifications(0);
  }

  command(bytes, operation, timeoutMs = 10000) {
    if (this.pendingResponse) {
      throw new Error("An R1 DFU control operation is already pending.");
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingResponse?.operation === operation) this.pendingResponse = null;
        reject(new Error(`R1 DFU operation 0x${operation.toString(16)} timed out.`));
      }, timeoutMs);
      this.pendingResponse = { operation, resolve, reject, timeout };
      this.control.writeValueWithResponse(bytes).catch((error) => {
        if (this.pendingResponse?.operation === operation) this.pendingResponse = null;
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async selectObject(type) {
    const response = await this.command(new Uint8Array([OP_SELECT, type]), OP_SELECT);
    if (response.length < 12) throw new Error("R1 DFU returned a short SELECT response.");
    const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
    return {
      maximumSize: view.getUint32(0, true),
      offset: view.getUint32(4, true),
      crc: view.getUint32(8, true),
    };
  }

  async createObject(type, size) {
    await this.command(
      concatBytes(new Uint8Array([OP_CREATE, type]), littleEndian32(size)),
      OP_CREATE,
    );
  }

  async setPacketReceiptNotifications(interval) {
    if (!Number.isInteger(interval) || interval < 0 || interval > 0xffff) {
      throw new Error("R1 DFU packet-receipt interval is invalid.");
    }
    await this.command(
      new Uint8Array([OP_SET_PRN, interval & 0xff, (interval >>> 8) & 0xff]),
      OP_SET_PRN,
    );
    this.activePacketReceiptInterval = interval;
  }

  waitForPacketReceipt() {
    if (this.pendingPacketReceipt) {
      throw new Error("An R1 DFU packet receipt is already pending.");
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingPacketReceipt?.reject === reject) {
          this.pendingPacketReceipt = null;
        }
        reject(new Error("R1 DFU packet-receipt notification timed out."));
      }, this.packetReceiptTimeoutMs);
      this.pendingPacketReceipt = { resolve, reject, timeout };
    });
  }

  rejectPendingPacketReceipt(error) {
    const pending = this.pendingPacketReceipt;
    if (!pending) return;
    this.pendingPacketReceipt = null;
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  verifyChecksumPayload(payload, expectedOffset, expectedCrc, label = "verification") {
    if (payload.length < 8) throw new Error("R1 DFU returned a short CRC response.");
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const actualOffset = view.getUint32(0, true);
    const actualCrc = view.getUint32(4, true);
    if (actualOffset !== expectedOffset || actualCrc !== expectedCrc) {
      const detail = actualOffset === expectedOffset
        ? `checksum mismatch at byte ${actualOffset}`
        : `byte ${actualOffset} (expected ${expectedOffset})`;
      throw new Error(
        `R1 DFU ${label} failed at ${detail}. Re-enter DFU mode and retry.`,
      );
    }
  }

  async writePackets(bytes, { baseOffset = 0, checksumSource = bytes } = {}) {
    const data = asBytes(bytes);
    const source = asBytes(checksumSource);
    if (
      !Number.isInteger(baseOffset)
      || baseOffset < 0
      || baseOffset + data.length > source.length
    ) {
      throw new Error("R1 DFU packet checksum range is invalid.");
    }

    let packetsSinceReceipt = 0;
    for (let offset = 0; offset < data.length; offset += PACKET_BYTES) {
      const end = Math.min(offset + PACKET_BYTES, data.length);
      const chunk = data.subarray(offset, end);
      packetsSinceReceipt += 1;
      const receiptExpected =
        this.activePacketReceiptInterval > 0
        && packetsSinceReceipt === this.activePacketReceiptInterval;
      // Register before the boundary packet is written: a fast bootloader may
      // notify before Chrome resolves writeValueWithoutResponse().
      const receipt = receiptExpected ? this.waitForPacketReceipt() : null;
      try {
        const supportsWriteWithoutResponse =
          typeof this.packet.writeValueWithoutResponse === "function"
          && this.packet.properties?.writeWithoutResponse !== false;
        if (supportsWriteWithoutResponse) {
          await this.packet.writeValueWithoutResponse(chunk);
        } else {
          await this.packet.writeValueWithResponse(chunk);
        }
      } catch (error) {
        if (receipt) {
          this.rejectPendingPacketReceipt(error);
          await receipt.catch(() => {});
        }
        throw error;
      }

      if (receipt) {
        const expectedOffset = baseOffset + end;
        const payload = await receipt;
        this.verifyChecksumPayload(
          payload,
          expectedOffset,
          crc32(source.subarray(0, expectedOffset)),
          "packet-receipt verification",
        );
        packetsSinceReceipt = 0;
      }
    }
  }

  async verifyOffset(expectedOffset, expectedCrc) {
    const response = await this.command(new Uint8Array([OP_CALCULATE_CRC]), OP_CALCULATE_CRC);
    this.verifyChecksumPayload(response, expectedOffset, expectedCrc);
  }

  async transferInitPacket(initPacket) {
    const selected = await this.selectObject(OBJECT_COMMAND);
    if (selected.maximumSize < initPacket.length) {
      throw new Error("The R1 bootloader command object is too small for this signed init packet.");
    }
    if (selected.offset <= initPacket.length) {
      const expectedCrc = crc32(initPacket.subarray(0, selected.offset));
      if (selected.crc === expectedCrc && selected.offset > 0) {
        if (selected.offset < initPacket.length) {
          await this.writePackets(initPacket.subarray(selected.offset), {
            baseOffset: selected.offset,
            checksumSource: initPacket,
          });
          await this.verifyOffset(initPacket.length, crc32(initPacket));
        }
        // A matching complete command may have disconnected before EXECUTE was
        // acknowledged. Nordic's reference implementation executes it again.
        await this.command(new Uint8Array([OP_EXECUTE]), OP_EXECUTE);
        return;
      }
    }
    await this.createObject(OBJECT_COMMAND, initPacket.length);
    await this.writePackets(initPacket);
    await this.verifyOffset(initPacket.length, crc32(initPacket));
    await this.command(new Uint8Array([OP_EXECUTE]), OP_EXECUTE);
  }

  async transferApplication(application) {
    const selected = await this.selectObject(OBJECT_DATA);
    if (!selected.maximumSize) throw new Error("The R1 bootloader reported a zero-size data object.");
    if (selected.offset > application.length) {
      throw new Error("The R1 bootloader offset is beyond the reviewed application image.");
    }

    let offset = selected.offset;
    const resumeCrcMatches = selected.crc === crc32(application.subarray(0, offset));
    if (!resumeCrcMatches && offset > 0) {
      // Recreate only the current object, matching Nordic's bounded CRC recovery.
      // At an exact boundary SELECT refers to the just-written object, which may
      // not yet have executed, so replay that object rather than the next one.
      const remainder = offset % selected.maximumSize;
      offset = remainder === 0
        ? Math.max(0, offset - selected.maximumSize)
        : offset - remainder;
    } else if (resumeCrcMatches && offset === application.length && offset > 0) {
      await this.command(new Uint8Array([OP_EXECUTE]), OP_EXECUTE);
      return;
    } else if (
      resumeCrcMatches
      && offset > 0
      && offset % selected.maximumSize === 0
    ) {
      // SELECT reports bytes written even when the final EXECUTE response was
      // lost. Commit that full object before creating the next one.
      await this.command(new Uint8Array([OP_EXECUTE]), OP_EXECUTE);
    } else if (resumeCrcMatches && offset % selected.maximumSize !== 0) {
      const boundary = Math.min(
        application.length,
        offset + (selected.maximumSize - (offset % selected.maximumSize)),
      );
      await this.writePackets(application.subarray(offset, boundary), {
        baseOffset: offset,
        checksumSource: application,
      });
      offset = boundary;
      await this.verifyOffset(offset, crc32(application.subarray(0, offset)));
      await this.command(new Uint8Array([OP_EXECUTE]), OP_EXECUTE);
      this.onProgress(offset / application.length, `Resumed at ${offset.toLocaleString()} bytes`);
    }

    while (offset < application.length) {
      const end = Math.min(offset + selected.maximumSize, application.length);
      await this.createObject(OBJECT_DATA, end - offset);
      if (offset === 0) {
        // Nordic's updater gives SDK 15/16 bootloaders time to prepare the first
        // data object; without this pause initial packets can be discarded.
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await this.writePackets(application.subarray(offset, end), {
        baseOffset: offset,
        checksumSource: application,
      });
      offset = end;
      await this.verifyOffset(offset, crc32(application.subarray(0, offset)));
      await this.command(new Uint8Array([OP_EXECUTE]), OP_EXECUTE);
      this.onProgress(
        offset / application.length,
        `Transferred ${offset.toLocaleString()} of ${application.length.toLocaleString()} bytes`,
      );
    }
  }

  async flash({ initPacket, application }) {
    try {
      this.onProgress(0, "Connecting to the R1 bootloader");
      await this.connect();
      this.onProgress(0.01, "Sending the signed R1 init packet");
      await this.transferInitPacket(asBytes(initPacket));
      await this.setPacketReceiptNotifications(
        this.configuredPacketReceiptInterval,
      );
      this.onProgress(0.02, "Transferring the reviewed R1 application");
      await this.transferApplication(asBytes(application));
      this.onProgress(1, "R1 update transferred; the ring is restarting");
    } finally {
      if (this.control) {
        this.control.removeEventListener(
          "characteristicvaluechanged",
          this.handleNotification,
        );
      }
      this.pendingResponse = null;
      if (this.pendingPacketReceipt) {
        clearTimeout(this.pendingPacketReceipt.timeout);
        this.pendingPacketReceipt = null;
      }
    }
  }
}

export async function flashR1SecureDfu(device, firmware, options) {
  const session = new R1SecureDfuSession(device, options);
  await session.flash(firmware);
}
