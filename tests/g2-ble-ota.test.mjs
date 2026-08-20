import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  G2_BLE_BEGIN_ATTEMPTS,
  G2_BLE_BLOCK_BYTES,
  G2_BLE_LOSS_RECONNECT_DELAY_MS,
  G2_BLE_POST_UPDATE_RECONNECT_ATTEMPTS,
  G2_BLE_POST_UPDATE_RECONNECT_INTERVAL_MS,
  G2BleOtaError,
  G2BleOtaSession,
  assertPinnedG2BleBundle,
  crc16CcittFalse,
  flashG2BleSessionsConcurrently,
  g2BleDeviceSide,
  g2BleRoutesAwaitingCaseVerification,
  g2BleTargetVersionProof,
  isG2BleConnectionLoss,
  makeBleControlFrames,
  makeBleEnvelopeFrames,
  parseBleAck,
  probeAuthorizedG2BleDevices,
  requestG2BleDevice,
} from "../src/lib/g2BleOta.js";
import {
  EXPECTED_COMPONENTS,
  EXPECTED_COMPONENT_TYPES,
  parseFirmwareInput,
} from "../src/lib/firmware.js";

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

test("probes only previously authorized G2 handles and verifies application GATT", async () => {
  const services = [];
  const makeDevice = (name, id, reachable = true) => ({
    name,
    id,
    gatt: {
      async connect() {
        if (!reachable) throw new Error("not advertising");
        return {
          async getPrimaryService(service) {
            services.push({ id, service });
            return {};
          },
        };
      },
      disconnect() {},
    },
  });
  const bluetooth = {
    async getDevices() {
      return [
        makeDevice("Even G2_32_L_AAAAAA", "left"),
        makeDevice("Even G2_32_R_BBBBBB", "right", false),
        makeDevice("Unrelated", "other"),
      ];
    },
  };
  const result = await probeAuthorizedG2BleDevices({ bluetooth });
  assert.deepEqual(result.authorizedSides, ["left", "right"]);
  assert.deepEqual(result.reachableSides, ["left"]);
  assert.equal(result.bothApplicationsReachable, false);
  assert.equal(result.chooserRequired, false);
  assert.match(result.results.right.error, /not advertising/);
  assert.equal(services.length, 1);
});

test("matches the captured G2 AA21 CRC and envelope vectors", () => {
  assert.equal(crc16CcittFalse(Buffer.from("123456789")), 0x29b1);
  assert.equal(crc16CcittFalse(Uint8Array.of(0)), 0xe1f0);
  assert.deepEqual(
    makeBleControlFrames(0x00, new Uint8Array(), 1).map(hex),
    ["aa2101030101c00000f0e1"],
  );
  assert.deepEqual(
    makeBleEnvelopeFrames(
      0x80,
      Uint8Array.from([0x08, 0x0e, 0x10, 0x26, 0x6a, 0x00]),
      { sequence: 2 },
    ).map(hex),
    ["aa21020801018000080e10266a00da07"],
  );
});

test("splits a 233-byte payload exactly like the reviewed flasher", () => {
  const frames = makeBleEnvelopeFrames(
    0xc1,
    Uint8Array.from({ length: 233 }, (_, index) => index),
    { sequence: 0xfe },
  );
  assert.equal(frames.length, 2);
  assert.deepEqual(
    [...frames[0].subarray(0, 8)],
    [0xaa, 0x21, 0xfe, 232, 2, 1, 0xc1, 0],
  );
  assert.equal(frames[0][8], 0);
  assert.equal(frames[0].at(-1), 231);
  assert.equal(hex(frames[1]), "aa21fe030202c100e83e4a");
});

test("unwraps AA12 acknowledgement payloads", () => {
  const ack = parseBleAck(
    Uint8Array.from([
      0xaa, 0x12, 0x44, 0x04, 0x01, 0x01, 0xc0, 0x00,
      0x02, 0x07, 0x00, 0x00,
    ]),
  );
  assert.equal(ack.sequence, 0x44);
  assert.equal(ack.sid, 0xc0);
  assert.equal(ack.opcode, 0x02);
  assert.equal(ack.status, 0x07);
  assert.equal(parseBleAck(Uint8Array.of(0xaa, 0x21)), null);
});

test("uses one shared sequence for a block marker and all block fragments", async () => {
  const written = [];
  const characteristic = {
    writeValueWithoutResponse: async (frame) => written.push(frame.slice()),
  };
  const session = new G2BleOtaSession(
    { name: "Even G2_32_R_693CCB" },
    { side: "right" },
  );
  session.dataWrite = characteristic;
  session.waitForAck = async () => 0;
  const status = await session.sendBlock(
    new Uint8Array(G2_BLE_BLOCK_BYTES),
  );
  assert.equal(status, 0);
  assert.equal(written.length, 19);
  assert.equal(written[0][6], 0xc0);
  assert.equal(written[1][6], 0xc1);
  assert.ok(written.every((frame) => frame[2] === 1));
});

test("an explicit block NAK is safely resent in place", async () => {
  const statuses = [3, 0];
  const session = new G2BleOtaSession(
    { name: "Even G2_32_R_693CCB" },
    {
      side: "right",
      componentAttempts: 1,
      blockNakAttempts: 3,
    },
  );
  const controls = [];
  let blockCalls = 0;
  session.sendControl = async (opcode) => {
    controls.push(opcode);
    return opcode === 0x03 ? 8 : 0;
  };
  session.sendBlock = async () => {
    blockCalls += 1;
    return statuses.shift();
  };
  const totals = {
    totalBytes: 4,
    completedBeforeComponent: 0,
    highWater: 0,
  };
  const result = await session.flashComponent(
    {
      name: "firmware/test.bin",
      header: new Uint8Array(128),
      payload: Uint8Array.of(1, 2, 3, 4),
    },
    0,
    totals,
  );
  assert.equal(blockCalls, 2);
  assert.deepEqual(controls, [0x01, 0x03]);
  assert.equal(result.endStatus, 8);
});

test("an ambiguous block timeout restarts the component from FILE_CHECK", async () => {
  const session = new G2BleOtaSession(
    { name: "Even G2_32_R_693CCB" },
    {
      side: "right",
      componentAttempts: 2,
      componentRetrySettleMs: 0,
    },
  );
  const controls = [];
  let blockCalls = 0;
  session.sendControl = async (opcode) => {
    controls.push(opcode);
    return opcode === 0x03 ? 8 : 0;
  };
  session.sendBlock = async () => {
    blockCalls += 1;
    if (blockCalls === 1) {
      throw new G2BleOtaError("lost ack", {
        code: "ACK_TIMEOUT",
        opcode: 0x02,
      });
    }
    return 0;
  };
  await session.flashComponent(
    {
      name: "firmware/test.bin",
      header: new Uint8Array(128),
      payload: Uint8Array.of(1, 2, 3, 4),
    },
    0,
    {
      totalBytes: 4,
      completedBeforeComponent: 0,
      highWater: 0,
    },
  );
  assert.equal(blockCalls, 2);
  assert.deepEqual(controls, [0x01, 0x01, 0x03]);
});

test("a hidden WebFlasher pauses before starting the next BLE block", async () => {
  const listeners = new Set();
  const documentObject = {
    visibilityState: "hidden",
    addEventListener(type, listener) {
      assert.equal(type, "visibilitychange");
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "visibilitychange");
      listeners.delete(listener);
    },
  };
  const written = [];
  const logs = [];
  const session = new G2BleOtaSession(
    { name: "Even G2_32_R_693CCB" },
    {
      side: "right",
      documentObject,
      visibilityResumeSettleMs: 0,
      log: (message, tone) => logs.push({ message, tone }),
    },
  );
  session.dataWrite = {
    writeValueWithoutResponse: async (frame) => written.push(frame.slice()),
  };
  session.waitForAck = async () => 0;

  const pending = session.sendBlock(new Uint8Array(G2_BLE_BLOCK_BYTES));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written.length, 0);
  assert.equal(listeners.size, 1);
  assert.match(logs[0].message, /paused before the next 4 KB block/);

  documentObject.visibilityState = "visible";
  for (const listener of [...listeners]) listener();
  assert.equal(await pending, 0);
  assert.equal(written.length, 19);
  assert.equal(listeners.size, 0);
  assert.equal(session.foregroundPauses, 1);
  assert.match(logs.at(-1).message, /resuming/);
});

test("a failed BLE bundle retains every component with verified END evidence", async () => {
  const target = { imageSha256: "a".repeat(64) };
  const firmware = {
    templeFlashEligible: true,
    templeFlashTarget: target,
    fileSha256: target.imageSha256,
    g2Version: "2.2.6.11",
    componentImages: EXPECTED_COMPONENTS.map((name, index) => ({
      name,
      typeId: EXPECTED_COMPONENT_TYPES[index],
      header: new Uint8Array(128),
      payload: Uint8Array.of(index),
      payloadSize: 1,
    })),
  };
  const session = new G2BleOtaSession(
    { name: "Even G2_32_R_693CCB" },
    { side: "right" },
  );
  session.connect = async () => {};
  session.startHeartbeat = () => {};
  session.stopHeartbeat = () => {};
  session.sendControl = async () => 0;
  session.flashComponent = async (component, index, totals) => {
    if (index === 1) {
      throw new G2BleOtaError("component failed", {
        code: "COMPONENT_FAILED",
        componentIndex: index,
        componentName: component.name,
        attempts: 3,
        cause: new G2BleOtaError("block rejected", {
          code: "BLOCK_REJECTED",
          status: 4,
          blockIndex: 14,
          blockAttempts: 3,
        }),
      });
    }
    totals.completedBeforeComponent += component.payload.length;
    totals.highWater = totals.completedBeforeComponent;
    return {
      name: component.name,
      payloadBytes: component.payload.length,
      blocks: 1,
      endStatus: 8,
      attempts: 1,
    };
  };

  let failure;
  try {
    await session.flashBundle(firmware);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "COMPONENT_FAILED");
  assert.equal(failure.partialResult.outcome, "failed_or_partial");
  assert.equal(failure.partialResult.completedComponentCount, 1);
  assert.equal(failure.partialResult.components[0].name, EXPECTED_COMPONENTS[0]);
  assert.equal(failure.partialResult.components[0].endStatus, 8);
  assert.equal(failure.partialResult.blockAcks, 1);
  assert.equal(failure.partialResult.verifiedPayloadBytes, 1);
  assert.equal(failure.partialResult.failure.componentName, EXPECTED_COMPONENTS[1]);
  assert.deepEqual(failure.partialResult.failure.cause, {
    message: "block rejected",
    code: "BLOCK_REJECTED",
    status: 4,
    blockIndex: 14,
    blockAttempts: 3,
    opcode: null,
  });
});

test("left and right BLE sessions flash concurrently and settle independently", async () => {
  let releaseLeft;
  const leftGate = new Promise((resolve) => {
    releaseLeft = resolve;
  });
  const started = [];
  const disconnected = [];
  const settledSides = [];
  let completed = false;
  const entries = ["left", "right"].map((side) => ({
    side,
    device: { id: `${side}-id`, name: `Even G2_32_${side[0].toUpperCase()}_TEST` },
    session: {
      async flashBundle() {
        started.push(side);
        if (side === "left") {
          await leftGate;
          return { side, outcome: "success" };
        }
        throw new G2BleOtaError("right stopped", {
          code: "COMPONENT_FAILED",
          partialResult: {
            side,
            components: [{ name: "firmware/codec.bin", endStatus: 8 }],
            outcome: "failed_or_partial",
          },
        });
      },
      async disconnect() {
        disconnected.push(side);
      },
    },
  }));

  const pending = flashG2BleSessionsConcurrently(entries, {}, {
    onSettled: ({ side, status }) => settledSides.push({ side, status }),
  }).then((value) => {
    completed = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["left", "right"]);
  assert.equal(completed, false);
  assert.deepEqual(settledSides, [{ side: "right", status: "rejected" }]);

  releaseLeft();
  const outcomes = await pending;
  assert.equal(completed, true);
  assert.deepEqual(disconnected.sort(), ["left", "right"]);
  assert.equal(outcomes[0].side, "left");
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[0].value.outcome, "success");
  assert.equal(outcomes[1].side, "right");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(outcomes[1].reason.message, "right stopped");
  assert.deepEqual(settledSides, [
    { side: "right", status: "rejected" },
    { side: "left", status: "fulfilled" },
  ]);
  assert.equal(
    outcomes[1].reason.partialResult.components[0].endStatus,
    8,
  );
});

test("connection-loss recovery waits 10 seconds by default and recognizes Chrome errors", () => {
  const session = new G2BleOtaSession(
    {
      id: "left-id",
      name: "Even G2_32_L_TEST",
      gatt: { connected: true },
    },
    { side: "left" },
  );
  assert.equal(G2_BLE_LOSS_RECONNECT_DELAY_MS, 10_000);
  assert.equal(session.lossReconnectDelayMs, 10_000);
  assert.equal(session.rebootSettleMs, 10_000);
  assert.equal(
    isG2BleConnectionLoss(
      Object.assign(
        new Error("Bluetooth Device is no longer in range."),
        { code: 19 },
      ),
      session.device,
    ),
    true,
  );
  assert.equal(
    isG2BleConnectionLoss(new Error("CRC rejected"), session.device),
    false,
  );
});

test("a lost component connection reuses the selected endpoint and restarts at FILE_CHECK", async () => {
  const device = {
    id: "right-paired-id",
    name: "Even G2_32_R_TEST",
    gatt: { connected: true },
  };
  const session = new G2BleOtaSession(device, {
    side: "right",
    componentAttempts: 2,
    componentRetrySettleMs: 0,
  });
  const controls = [];
  const recoveryContexts = [];
  let blockCalls = 0;
  session.sendControl = async (opcode) => {
    controls.push(opcode);
    return opcode === 0x03 ? 8 : 0;
  };
  session.sendBlock = async () => {
    blockCalls += 1;
    if (blockCalls === 1) {
      device.gatt.connected = false;
      throw Object.assign(
        new Error("Bluetooth Device is no longer in range."),
        { code: 19 },
      );
    }
    return 0;
  };
  session.reconnectAfterLoss = async (context) => {
    recoveryContexts.push(context);
    assert.equal(session.device, device);
    assert.equal(session.selectedDeviceId, "right-paired-id");
    device.gatt.connected = true;
  };

  const result = await session.flashComponent(
    {
      name: "ota/s200_firmware_ota.bin",
      payload: Uint8Array.of(1, 2, 3),
    },
    5,
    { totalBytes: 3, completedBeforeComponent: 0, highWater: 0 },
  );

  assert.equal(result.attempts, 2);
  assert.deepEqual(controls, [0x01, 0x01, 0x03]);
  assert.equal(blockCalls, 2);
  assert.deepEqual(recoveryContexts, [
    "ota/s200_firmware_ota.bin attempt 1/2",
  ]);
});

test("reconnect after loss uses the original paired device ID without a chooser", async () => {
  const logs = [];
  const statuses = [];
  let connectAttempts = 0;
  let heartbeatStarts = 0;
  const device = {
    id: "left-paired-id",
    name: "Even G2_32_L_TEST",
    gatt: {
      connected: false,
      disconnect() {},
    },
  };
  const session = new G2BleOtaSession(device, {
    side: "left",
    lossReconnectDelayMs: 0,
    reconnectIntervalMs: 0,
    reconnectAttempts: 3,
    log: (message, tone) => logs.push({ message, tone }),
    progress: (_fraction, detail, status) =>
      statuses.push({ detail, status }),
  });
  session.disconnect = async () => {};
  session.connect = async () => {
    connectAttempts += 1;
    assert.equal(session.device, device);
    assert.equal(session.device.id, "left-paired-id");
    if (connectAttempts === 1) {
      throw new Error("Bluetooth Device is no longer in range.");
    }
    device.gatt.connected = true;
  };
  session.startHeartbeat = () => {
    heartbeatStarts += 1;
  };
  session.sendControl = async (opcode) => {
    assert.equal(opcode, 0x00);
    return 0;
  };

  assert.deepEqual(await session.reconnectAfterLoss("test boundary"), {
    attempts: 2,
    deviceId: "left-paired-id",
    beginStatus: 0,
  });
  assert.equal(connectAttempts, 2);
  assert.equal(heartbeatStarts, 1);
  assert.deepEqual(
    statuses.map(({ status }) => status),
    ["reconnecting", "flashing"],
  );
  assert.match(logs[0].message, /chooser will not reopen/);
  assert.match(logs.at(-1).message, /left-paired-id/);
});

test("an initially unreachable selected temple gets bounded reconnect attempts", async () => {
  const logs = [];
  let connectAttempts = 0;
  let disconnects = 0;
  const session = new G2BleOtaSession(
    {
      name: "Even G2_32_L_ACD458",
      gatt: {
        disconnect() {
          disconnects += 1;
        },
      },
    },
    {
      side: "left",
      initialConnectAttempts: 4,
      reconnectIntervalMs: 0,
      log: (message, tone) => logs.push({ message, tone }),
    },
  );
  session.connect = async () => {
    connectAttempts += 1;
    if (connectAttempts < 3) {
      throw Object.assign(
        new Error("Bluetooth Device is no longer in range."),
        { code: 19 },
      );
    }
  };

  assert.deepEqual(await session.connectForTransfer(), { attempts: 3 });
  assert.equal(connectAttempts, 3);
  assert.equal(disconnects, 2);
  assert.match(logs[0].message, /Waiting for it to advertise/);
  assert.match(logs.at(-1).message, /became reachable again/);
});

test("the post-update reconnect budget outlasts the temple's firmware apply", () => {
  const session = new G2BleOtaSession(
    { name: "Even G2_32_R_693CCB", gatt: {} },
    { side: "right" },
  );
  assert.equal(G2_BLE_POST_UPDATE_RECONNECT_INTERVAL_MS, 5000);
  assert.equal(G2_BLE_POST_UPDATE_RECONNECT_ATTEMPTS, 24);
  assert.equal(G2_BLE_BEGIN_ATTEMPTS, 3);
  assert.equal(session.postUpdateReconnectIntervalMs, 5000);
  assert.equal(session.postUpdateReconnectAttempts, 24);
  assert.equal(session.beginAttempts, 3);
  // The mid-transfer blip budget is deliberately unchanged: a connection that
  // drops during transfer should still resolve or fail quickly.
  assert.equal(session.reconnectAttempts, 8);
  assert.equal(session.reconnectIntervalMs, 2500);
  // END 8 (UPDATING) applies a multi-megabyte staged image; the settle pause
  // plus the reconnect ladder must cover at least two minutes of silence.
  assert.ok(
    session.rebootSettleMs +
      (session.postUpdateReconnectAttempts - 1) *
        session.postUpdateReconnectIntervalMs >=
      120_000,
  );
});

test("a silent BEGIN is retried on a rebuilt link instead of failing the side", async () => {
  const logs = [];
  let rebuilds = 0;
  let heartbeatStarts = 0;
  let disconnects = 0;
  let sends = 0;
  const session = new G2BleOtaSession(
    { name: "Even G2_32_L_BEA504", gatt: { connected: true } },
    { side: "left", log: (message, tone) => logs.push({ message, tone }) },
  );
  session.disconnect = async () => {
    disconnects += 1;
  };
  session.connectForTransfer = async () => {
    rebuilds += 1;
  };
  session.startHeartbeat = () => {
    heartbeatStarts += 1;
  };
  session.sendControl = async (opcode) => {
    assert.equal(opcode, 0x00);
    sends += 1;
    if (sends === 1) {
      throw new G2BleOtaError("left: no Bluetooth OTA acknowledgement for opcode 0x00.", {
        code: "ACK_TIMEOUT",
        opcode: 0x00,
      });
    }
    return 0;
  };

  assert.equal(await session.beginPackage(), 0);
  assert.equal(sends, 2);
  assert.equal(disconnects, 1);
  assert.equal(rebuilds, 1);
  assert.equal(heartbeatStarts, 1);
  assert.match(logs[0].message, /BEGIN attempt 2\/3/);
  assert.match(logs[0].message, /safe to resend/);
});

test("a BEGIN that stays silent is bounded and reports before any firmware moved", async () => {
  const session = new G2BleOtaSession(
    { name: "Even G2_32_L_BEA504", gatt: { connected: true } },
    { side: "left", beginAttempts: 2 },
  );
  session.disconnect = async () => {};
  session.connectForTransfer = async () => {};
  session.startHeartbeat = () => {};
  session.sendControl = async () => {
    throw new G2BleOtaError("left: no Bluetooth OTA acknowledgement for opcode 0x00.", {
      code: "ACK_TIMEOUT",
      opcode: 0x00,
    });
  };

  await assert.rejects(session.beginPackage(), (error) => {
    assert.equal(error.code, "BEGIN_FAILED");
    assert.equal(error.attempts, 2);
    assert.equal(error.cause?.code, "ACK_TIMEOUT");
    assert.match(error.message, /no firmware bytes were sent/);
    return true;
  });
});

test("a BEGIN connection loss still routes through the saved-endpoint recovery", async () => {
  const contexts = [];
  const session = new G2BleOtaSession(
    { name: "Even G2_32_L_BEA504", gatt: { connected: false } },
    { side: "left" },
  );
  session.sendControl = async () => {
    throw Object.assign(
      new Error("Bluetooth Device is no longer in range."),
      { code: 19 },
    );
  };
  session.reconnectAfterLoss = async (context) => {
    contexts.push(context);
    return { attempts: 1, beginStatus: 0 };
  };

  assert.equal(await session.beginPackage(), 0);
  assert.deepEqual(contexts, ["the package BEGIN command"]);
});

test("a final END 8 reboot reconnects instead of surfacing the heartbeat disconnect", async () => {
  const target = {
    imageSha256: "a".repeat(64),
  };
  const firmware = {
    templeFlashEligible: true,
    templeFlashTarget: target,
    fileSha256: target.imageSha256,
    g2Version: "2.2.6.11",
    componentImages: EXPECTED_COMPONENTS.map((name, index) => ({
      name,
      typeId: EXPECTED_COMPONENT_TYPES[index],
      header: new Uint8Array(128),
      payload: Uint8Array.of(index),
      payloadSize: 1,
    })),
  };
  const session = new G2BleOtaSession(
    {
      name: "Even G2_32_R_693CCB",
      gatt: { connected: false },
    },
    { side: "right" },
  );
  session.connect = async () => {};
  session.startHeartbeat = () => {};
  session.stopHeartbeat = () => {};
  session.sendControl = async () => 0;
  let finalSettles = 0;
  session.settleFinalUpdate = async (endStatus) => {
    finalSettles += 1;
    assert.equal(endStatus, 8);
    session.heartbeatError = null;
    return {
      expectedReboot: true,
      reconnected: true,
      reconnectAttempts: 2,
    };
  };
  session.flashComponent = async (component, index, totals) => {
    totals.completedBeforeComponent += component.payload.length;
    totals.highWater = totals.completedBeforeComponent;
    if (index === EXPECTED_COMPONENTS.length - 1) {
      session.heartbeatError = new Error(
        "Bluetooth Device is no longer in range.",
      );
    }
    return {
      name: component.name,
      payloadBytes: component.payload.length,
      blocks: 1,
      endStatus: 8,
      attempts: 1,
    };
  };

  const result = await session.flashBundle(firmware);
  assert.equal(result.outcome, "success");
  assert.equal(result.components.length, EXPECTED_COMPONENTS.length);
  assert.equal(finalSettles, 1);
  assert.deepEqual(result.components.at(-1).postUpdate, {
    expectedReboot: true,
    reconnected: true,
    reconnectAttempts: 2,
  });
});

test("an explicit final END preserves the transfer when bounded reboot reconnect is delayed", async () => {
  const logs = [];
  let connectAttempts = 0;
  const device = {
    name: "Even G2_32_R_693CCB",
    gatt: {
      connected: false,
      async connect() {
        connectAttempts += 1;
        throw new Error("Bluetooth Device is no longer in range.");
      },
      disconnect() {},
    },
  };
  const session = new G2BleOtaSession(device, {
    side: "right",
    log: (message, tone) => logs.push({ message, tone }),
    rebootSettleMs: 0,
    postUpdateReconnectIntervalMs: 0,
    postUpdateReconnectAttempts: 3,
  });
  session.writeTail = Promise.reject(
    new Error("Bluetooth Device is no longer in range."),
  );
  session.heartbeatError = new Error(
    "Bluetooth Device is no longer in range.",
  );

  const result = await session.settleFinalUpdate(8);
  assert.equal(connectAttempts, 3);
  assert.equal(result.expectedReboot, true);
  assert.equal(result.rebootObserved, true);
  assert.equal(result.freshReconnectAttempted, true);
  assert.equal(result.reconnected, false);
  assert.equal(result.reconnectAttempts, 3);
  assert.match(result.reconnectError, /no longer in range/);
  assert.match(logs.at(-1).message, /No firmware will be replayed/);
});

test("a completed transfer remains pending when reboot GATT liveness is absent", () => {
  const routes = {
    left: {
      outcome: "success",
      components: [
        {
          postUpdate: {
            freshReconnectAttempted: true,
            reconnected: false,
          },
        },
      ],
    },
    right: {
      outcome: "success",
      components: [
        {
          postUpdate: {
            freshReconnectAttempted: true,
            reconnected: true,
          },
        },
      ],
    },
  };
  assert.deepEqual(g2BleRoutesAwaitingCaseVerification(routes), ["left"]);
  routes.left.skipped = true;
  routes.left.verifiedBy = "fresh-case-version-proof";
  assert.deepEqual(g2BleRoutesAwaitingCaseVerification(routes), []);
});

test("the final reboot reconnect is bounded and succeeds on the selected device handle", async () => {
  let connectAttempts = 0;
  const device = {
    name: "Even G2_32_R_693CCB",
    gatt: {
      connected: false,
      disconnect() {},
    },
  };
  const session = new G2BleOtaSession(device, {
    side: "right",
    rebootSettleMs: 0,
    postUpdateReconnectIntervalMs: 0,
    postUpdateReconnectAttempts: 4,
  });
  session.connect = async () => {
    connectAttempts += 1;
    if (connectAttempts < 3) {
      throw new Error("Bluetooth Device is no longer in range.");
    }
    device.gatt.connected = true;
  };

  const result = await session.settleFinalUpdate(8);
  assert.equal(connectAttempts, 3);
  assert.deepEqual(result, {
    expectedReboot: true,
    rebootObserved: true,
    freshReconnectAttempted: true,
    reconnected: true,
    reconnectAttempts: 3,
  });
});

test("a live final-END link is closed and freshly reconnected without replay", async () => {
  let disconnects = 0;
  let connectAttempts = 0;
  const device = {
    name: "Even G2_32_R_693CCB",
    gatt: { connected: true },
  };
  const session = new G2BleOtaSession(device, {
    side: "right",
    rebootSettleMs: 0,
    postUpdateReconnectIntervalMs: 0,
    postUpdateReconnectAttempts: 3,
  });
  session.disconnect = async () => {
    disconnects += 1;
    device.gatt.connected = false;
  };
  session.connect = async () => {
    connectAttempts += 1;
    device.gatt.connected = true;
  };

  const result = await session.settleFinalUpdate(8);
  assert.equal(disconnects, 1);
  assert.equal(connectAttempts, 1);
  assert.deepEqual(result, {
    expectedReboot: true,
    rebootObserved: false,
    freshReconnectAttempted: true,
    reconnected: true,
    reconnectAttempts: 1,
  });
});

test("the direct BLE writer accepts only the complete pinned topology", () => {
  const target = {
    imageSha256: "a".repeat(64),
  };
  const firmware = {
    templeFlashEligible: true,
    templeFlashTarget: target,
    fileSha256: target.imageSha256,
    componentImages: EXPECTED_COMPONENTS.map((name, index) => ({
      name,
      typeId: EXPECTED_COMPONENT_TYPES[index],
      header: new Uint8Array(128),
      payload: Uint8Array.of(index),
      payloadSize: 1,
    })),
  };
  assert.equal(assertPinnedG2BleBundle(firmware), firmware);
  assert.throws(
    () =>
      assertPinnedG2BleBundle({
        ...firmware,
        componentImages: firmware.componentImages.slice(1),
      }),
    /complete 6-component/,
  );
});

test("the chooser rejects a temple from the wrong side", async () => {
  let disconnected = false;
  const bluetooth = {
    requestDevice: async () => ({
      name: "Even G2_32_L_693CCB",
      gatt: {
        disconnect() {
          disconnected = true;
        },
      },
    }),
  };
  let failure;
  try {
    await requestG2BleDevice("right", bluetooth);
  } catch (caught) {
    failure = caught;
  }
  assert.match(failure?.message ?? "", /Select the right temple/);
  assert.equal(failure.code, "WRONG_G2_SIDE");
  assert.equal(failure.requestedSide, "right");
  assert.equal(failure.observedSide, "left");
  assert.equal(failure.deviceName, "Even G2_32_L_693CCB");
  assert.equal(disconnected, true);
});

test("recognizes relaxed Chrome/CoreBluetooth G2 side-name variants", () => {
  assert.equal(g2BleDeviceSide("Even G2_32_L_693CCB"), "left");
  assert.equal(g2BleDeviceSide("Even G2 32 Right 693CCB"), "right");
  assert.equal(g2BleDeviceSide("G2_7_r_00A19F "), "right");
  assert.equal(g2BleDeviceSide("Even G2"), null);
  assert.equal(g2BleDeviceSide("Even G2_32_L_RIGHT_693CCB"), null);
  assert.equal(g2BleDeviceSide("Unrelated_L_device"), null);
});

test("fresh restored Case proof skips a Bluetooth rewrite only at the exact target", () => {
  const observedAt = "2026-07-30T21:00:00.000Z";
  const results = {
    version: {
      decoded: {
        firmwareVersion: "2.2.6.11",
      },
      transportProof: {
        restoredMask: 0x3ff,
      },
      observedAt,
    },
    lastProbeFailure: null,
  };
  const now = Date.parse(observedAt) + 5 * 60 * 1000;
  assert.equal(
    g2BleTargetVersionProof(results, "2.2.6.11", { now }),
    true,
  );
  assert.equal(
    g2BleTargetVersionProof(results, "2.2.6.10", { now }),
    false,
  );
  assert.equal(
    g2BleTargetVersionProof(
      {
        ...results,
        version: {
          ...results.version,
          transportProof: { restoredMask: 0 },
        },
      },
      "2.2.6.11",
      { now },
    ),
    false,
  );
  assert.equal(
    g2BleTargetVersionProof(
      {
        ...results,
        lastProbeFailure: { message: "no reply" },
      },
      "2.2.6.11",
      { now },
    ),
    false,
  );
  assert.equal(
    g2BleTargetVersionProof(results, "2.2.6.11", {
      now: Date.parse(observedAt) + 16 * 60 * 1000,
    }),
    false,
  );
});

test("requires an explicit matching side marker after the chooser", async () => {
  const device = {
    name: "Even G2",
    id: "shortened-corebluetooth-id",
    gatt: {
      disconnect() {},
    },
  };
  let options = null;
  await assert.rejects(
    requestG2BleDevice("right", {
      requestDevice: async (value) => {
        options = value;
        return device;
      },
    }),
    /without one unambiguous Left\/Right marker.*explicitly identifies the right side/,
  );
  // The chooser is now restricted to the requested side. The rejection above
  // is still what makes the guarantee hold: these prefixes are built from the
  // observed name-token list, so a G2 advertising an unrecorded token falls
  // back to pair-wide filters that cannot express the side at all.
  assert.deepEqual(
    options.filters.map((filter) => filter.namePrefix),
    ["Even G2_32_R_", "G2_32_R_"],
  );
  // Serial verification was removed, so the chooser requests only the two
  // services required by the OTA transport.
  assert.deepEqual(
    options.optionalServices,
    [
      "00002760-08c2-11e1-9073-0e8ac72e1001",
      "00002760-08c2-11e1-9073-0e8ac72e5450",
    ],
  );
});

test("accepts only the requested explicit side", async () => {
  const left = {
    name: "Even G2_32_L_693CCB",
    id: "left-id",
  };
  assert.equal(
    await requestG2BleDevice("left", {
      requestDevice: async () => left,
    }),
    left,
  );
  await assert.rejects(
    requestG2BleDevice("right", {
      requestDevice: async () => left,
    }),
    /identifies the left temple.*right pairing accepts only/,
  );
});
