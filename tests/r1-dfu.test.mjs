import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  R1_PINNED_RELEASE,
  R1_PINNED_RELEASES,
  R1_DFU_OBJECT_ATTEMPTS,
  R1_DFU_PACKET_RECEIPT_INTERVAL,
  R1SecureDfuSession,
  assertPinnedR1Release,
  crc32,
  parseDfuResponse,
  prepareR1DfuPackage,
} from "../src/lib/r1Dfu.js";

function checksumResponse(offset, checksum) {
  const bytes = new Uint8Array(11);
  bytes.set([0x60, 0x03, 0x01]);
  const view = new DataView(bytes.buffer);
  view.setUint32(3, offset, true);
  view.setUint32(7, checksum, true);
  return view;
}

const archivePath = new URL(
  "../public/firmware-updates/r1/2.2.9.0003/r1-2.2.9.0003-eac75275743ed88ed52704cf5079d4d5.zip",
  import.meta.url,
);

test("reviewed R1 archive and both Nordic DFU components verify exactly", async () => {
  const archive = await readFile(archivePath);
  const prepared = await prepareR1DfuPackage(archive, R1_PINNED_RELEASE);
  assert.equal(R1_PINNED_RELEASE.version, "2.2.9.0003");
  assert.equal(prepared.application.length, 654716);
  assert.equal(prepared.initPacket.length, 141);
});

test("every API-visible R1 release remains pinned and available for recovery", async () => {
  assert.equal(R1_PINNED_RELEASES.length, 12);
  assert.equal(R1_PINNED_RELEASES.at(-1).version, "2.0.3.0013");

  for (const release of R1_PINNED_RELEASES) {
    const releasePath = new URL(
      `../public/firmware-updates/r1/${release.version}/${release.fileName}`,
      import.meta.url,
    );
    const prepared = await prepareR1DfuPackage(await readFile(releasePath), release);
    assert.equal(prepared.application.length, release.application.binSize);
    assert.equal(prepared.initPacket.length, release.application.datSize);
  }
});

test("the shipped R1 catalog exactly matches the compiled trust pins", async () => {
  const catalog = JSON.parse(
    await readFile(
      new URL("../public/firmware-updates/index.json", import.meta.url),
      "utf8",
    ),
  ).ringReleases;

  assert.deepEqual(
    catalog.map(({ id, version, fileName, size, md5, sha256, format, application }) => ({
      id,
      version,
      fileName,
      size,
      md5,
      sha256,
      format,
      application,
    })),
    R1_PINNED_RELEASES,
  );
});

test("R1 release trust cannot be widened by the catalog", () => {
  assert.throws(
    () => assertPinnedR1Release({ ...R1_PINNED_RELEASE, version: "9.9.9" }),
    /did not match/,
  );
  assert.throws(
    () => assertPinnedR1Release({ id: "r1-owner-recovery-2.2.7.0005" }),
    /not trusted/,
  );
});

test("Nordic CRC32 and Secure DFU response parsing match the wire contract", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const response = new DataView(Uint8Array.from([0x60, 0x06, 0x01, 0xaa]).buffer);
  assert.deepEqual([...parseDfuResponse(response, 0x06)], [0xaa]);
  assert.throws(
    () => parseDfuResponse(new DataView(Uint8Array.from([0x60, 0x04, 0x05]).buffer), 0x04),
    /rejected operation/,
  );
});

class RecordingDfuSession extends R1SecureDfuSession {
  constructor(selection) {
    super({}, { firstObjectSettleMs: 0, objectRetrySettleMs: 0 });
    this.selection = selection;
    this.events = [];
  }

  async selectObject(type) {
    this.events.push(["select", type]);
    return this.selection;
  }

  async createObject(type, size) {
    this.events.push(["create", type, size]);
  }

  async writePackets(bytes) {
    this.events.push(["write", [...bytes]]);
  }

  async verifyOffset(offset, crc) {
    this.events.push(["verify", offset, crc]);
  }

  async command(bytes) {
    this.events.push(["command", [...bytes]]);
    return new Uint8Array();
  }
}

test("R1 DFU resumes a matching init packet at its recorded offset", async () => {
  const packet = Uint8Array.from([1, 2, 3, 4, 5]);
  const session = new RecordingDfuSession({
    maximumSize: 256,
    offset: 3,
    crc: crc32(packet.subarray(0, 3)),
  });

  await session.transferInitPacket(packet);

  assert.deepEqual(session.events, [
    ["select", 1],
    ["write", [4, 5]],
    ["verify", 5, crc32(packet)],
    ["command", [0x04]],
  ]);
});

test("R1 DFU commits a matching boundary before creating the next data object", async () => {
  const application = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const session = new RecordingDfuSession({
    maximumSize: 4,
    offset: 4,
    crc: crc32(application.subarray(0, 4)),
  });

  await session.transferApplication(application);

  assert.deepEqual(session.events, [
    ["select", 2],
    ["command", [0x04]],
    ["create", 2, 4],
    ["write", [5, 6, 7, 8]],
    ["verify", 8, crc32(application)],
    ["command", [0x04]],
  ]);
});

test("R1 DFU rewrites a data object whose checksum disagrees instead of aborting", async () => {
  const application = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const session = new RecordingDfuSession({
    maximumSize: 4,
    offset: 0,
    crc: 0,
  });
  let verifies = 0;
  session.verifyOffset = async (offset, crc) => {
    session.events.push(["verify", offset, crc]);
    verifies += 1;
    if (verifies === 1) {
      const error = new Error(
        "R1 DFU verification failed at checksum mismatch at byte 4.",
      );
      error.code = "R1_DFU_CRC_MISMATCH";
      throw error;
    }
  };

  await session.transferApplication(application);

  assert.deepEqual(session.events, [
    ["select", 2],
    ["create", 2, 4],
    ["write", [1, 2, 3, 4]],
    ["verify", 4, crc32(application.subarray(0, 4))],
    // CREATE resets the object's write pointer, so the retry replays exactly
    // the first object's bytes and nothing earlier.
    ["create", 2, 4],
    ["write", [1, 2, 3, 4]],
    ["verify", 4, crc32(application.subarray(0, 4))],
    ["command", [0x04]],
    ["create", 2, 4],
    ["write", [5, 6, 7, 8]],
    ["verify", 8, crc32(application)],
    ["command", [0x04]],
  ]);
});

test("a persistent R1 object checksum failure stays bounded and surfaces", async () => {
  const application = Uint8Array.from([1, 2, 3, 4]);
  const session = new RecordingDfuSession({
    maximumSize: 4,
    offset: 0,
    crc: 0,
  });
  let creates = 0;
  const originalCreate = session.createObject.bind(session);
  session.createObject = async (type, size) => {
    creates += 1;
    await originalCreate(type, size);
  };
  session.verifyOffset = async () => {
    const error = new Error("R1 DFU verification failed at byte 4.");
    error.code = "R1_DFU_CRC_MISMATCH";
    throw error;
  };

  await assert.rejects(
    session.transferApplication(application),
    /verification failed/,
  );
  assert.equal(creates, R1_DFU_OBJECT_ATTEMPTS);
});

test("R1 DFU keeps PRNs disabled for init and enables the Nordic 12-packet window for data", async () => {
  class OrderedDfuSession extends R1SecureDfuSession {
    constructor() {
      super({});
      this.events = [];
    }

    async connect() {
      this.events.push(["connect"]);
      await this.setPacketReceiptNotifications(0);
    }

    async setPacketReceiptNotifications(interval) {
      this.activePacketReceiptInterval = interval;
      this.events.push(["prn", interval]);
    }

    async transferInitPacket() {
      this.events.push(["init", this.activePacketReceiptInterval]);
    }

    async transferApplication() {
      this.events.push(["application", this.activePacketReceiptInterval]);
    }
  }

  const session = new OrderedDfuSession();
  await session.flash({
    initPacket: Uint8Array.from([1]),
    application: Uint8Array.from([2]),
  });

  assert.equal(R1_DFU_PACKET_RECEIPT_INTERVAL, 12);
  assert.deepEqual(session.events, [
    ["connect"],
    ["prn", 0],
    ["init", 0],
    ["prn", 12],
    ["application", 12],
  ]);
});

test("R1 DFU packet receipts bound write-without-response bursts below the observed queue limit", async () => {
  const application = Uint8Array.from(
    { length: 4096 },
    (_unused, index) => index & 0xff,
  );
  const received = [];
  let packetsSinceReceipt = 0;
  let queuedPackets = 0;
  let maximumQueuedPackets = 0;
  let session;

  const packet = {
    properties: { writeWithoutResponse: true },
    async writeValueWithoutResponse(chunk) {
      queuedPackets += 1;
      maximumQueuedPackets = Math.max(maximumQueuedPackets, queuedPackets);
      assert.ok(queuedPackets < 63, "the browser queue must be drained before 63 packets");
      received.push(...chunk);
      packetsSinceReceipt += 1;
      if (packetsSinceReceipt === R1_DFU_PACKET_RECEIPT_INTERVAL) {
        packetsSinceReceipt = 0;
        const offset = received.length;
        const checksum = crc32(Uint8Array.from(received));
        queueMicrotask(() => {
          queuedPackets = 0;
          session.handleNotification({
            target: { value: checksumResponse(offset, checksum) },
          });
        });
      }
    },
  };

  session = new R1SecureDfuSession({}, { packetReceiptTimeoutMs: 100 });
  session.packet = packet;
  session.activePacketReceiptInterval = R1_DFU_PACKET_RECEIPT_INTERVAL;
  await session.writePackets(application, { checksumSource: application });

  assert.deepEqual(Uint8Array.from(received), application);
  assert.equal(maximumQueuedPackets, R1_DFU_PACKET_RECEIPT_INTERVAL);
  assert.equal(session.pendingPacketReceipt, null);
});

test("R1 DFU fails at the first packet receipt whose device offset loses bytes", async () => {
  const application = Uint8Array.from(
    { length: 4096 },
    (_unused, index) => index & 0xff,
  );
  let writes = 0;
  let session;
  session = new R1SecureDfuSession({}, { packetReceiptTimeoutMs: 100 });
  session.activePacketReceiptInterval = R1_DFU_PACKET_RECEIPT_INTERVAL;
  session.packet = {
    properties: { writeWithoutResponse: true },
    async writeValueWithoutResponse() {
      writes += 1;
      if (writes === R1_DFU_PACKET_RECEIPT_INTERVAL) {
        const reportedOffset = 220;
        queueMicrotask(() => {
          session.handleNotification({
            target: {
              value: checksumResponse(
                reportedOffset,
                crc32(application.subarray(0, reportedOffset)),
              ),
            },
          });
        });
      }
    },
  };

  await assert.rejects(
    () => session.writePackets(application, { checksumSource: application }),
    /packet-receipt verification failed at byte 220 \(expected 240\)/,
  );
  assert.equal(writes, R1_DFU_PACKET_RECEIPT_INTERVAL);
});
