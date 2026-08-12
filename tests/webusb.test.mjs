import assert from "node:assert/strict";
import test from "node:test";

import {
  G2CaseWebUsbPort,
  ch341Divisor,
  ch341LineControl,
  isG2CaseUsbDevice,
} from "../src/lib/webusb.js";

function makeMockDevice({ version = 0x30, reads = [] } = {}) {
  const alternate = {
    alternateSetting: 0,
    interfaceClass: 0xff,
    endpoints: [
      { endpointNumber: 1, direction: "in", type: "interrupt", packetSize: 8 },
      { endpointNumber: 2, direction: "out", type: "bulk", packetSize: 32 },
      { endpointNumber: 2, direction: "in", type: "bulk", packetSize: 32 },
    ],
  };
  const usbInterface = {
    interfaceNumber: 0,
    alternate,
    alternates: [alternate],
  };
  const configuration = {
    configurationValue: 1,
    interfaces: [usbInterface],
  };
  return {
    vendorId: 0x1a86,
    productId: 0x7523,
    opened: false,
    configuration: null,
    configurations: [configuration],
    calls: [],
    writes: [],
    reads: [...reads],
    pendingRead: null,
    async open() {
      this.calls.push(["open"]);
      this.opened = true;
    },
    async selectConfiguration(value) {
      this.calls.push(["selectConfiguration", value]);
      this.configuration = configuration;
    },
    async claimInterface(value) {
      this.calls.push(["claimInterface", value]);
    },
    async releaseInterface(value) {
      this.calls.push(["releaseInterface", value]);
    },
    async close() {
      this.calls.push(["close"]);
      this.opened = false;
      this.configuration = null;
      this.pendingRead?.({
        status: "stall",
        data: new DataView(new ArrayBuffer(0)),
      });
      this.pendingRead = null;
    },
    async controlTransferIn(setup, length) {
      this.calls.push(["controlIn", setup, length]);
      return {
        status: "ok",
        data: new DataView(Uint8Array.from([version, 0]).buffer),
      };
    },
    async controlTransferOut(setup) {
      this.calls.push(["controlOut", setup]);
      return { status: "ok", bytesWritten: 0 };
    },
    async transferOut(endpoint, input) {
      const bytes = new Uint8Array(
        input.buffer,
        input.byteOffset,
        input.byteLength,
      ).slice();
      this.writes.push({ endpoint, bytes });
      return { status: "ok", bytesWritten: bytes.length };
    },
    async transferIn(endpoint, length) {
      this.calls.push(["transferIn", endpoint, length]);
      if (this.reads.length) {
        const bytes = Uint8Array.from(this.reads.shift());
        return {
          status: "ok",
          data: new DataView(bytes.buffer),
        };
      }
      return new Promise((resolve) => {
        this.pendingRead = resolve;
      });
    },
  };
}

test("recognizes only the reviewed G2 Case CH340 identity", () => {
  assert.equal(isG2CaseUsbDevice({ vendorId: 0x1a86, productId: 0x7523 }), true);
  assert.equal(isG2CaseUsbDevice({ vendorId: 0x1a86, productId: 0x5523 }), false);
  assert.equal(isG2CaseUsbDevice(null), false);
});

test("encodes the hardware-proven CH340 baud rates", () => {
  assert.equal(ch341Divisor(1_000_000, 0x30), 0xfa83);
  assert.equal(ch341Divisor(115_200, 0x30), 0xcc83);
  assert.throws(() => ch341Divisor(0), /baud rate/i);
  assert.throws(() => ch341Divisor(3_000_001), /baud rate/i);
});

test("encodes 8N1 and STM32 8E1 line control", () => {
  assert.equal(ch341LineControl({ dataBits: 8, stopBits: 1, parity: "none" }), 0xc3);
  assert.equal(ch341LineControl({ dataBits: 8, stopBits: 1, parity: "even" }), 0xdb);
  assert.throws(
    () => ch341LineControl({ dataBits: 9, stopBits: 1, parity: "none" }),
    /data bits/i,
  );
});

test("opens CH340 at 1 Mbaud and exposes exact bulk writes", async () => {
  const device = makeMockDevice();
  const port = new G2CaseWebUsbPort(device);
  await port.open({
    baudRate: 1_000_000,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
    bufferSize: 4096,
  });

  assert.deepEqual(port.getInfo(), {
    usbVendorId: 0x1a86,
    usbProductId: 0x7523,
    transport: "webusb",
  });
  const controls = device.calls
    .filter(([kind]) => kind === "controlOut")
    .map(([, setup]) => setup);
  assert.deepEqual(
    controls.map(({ request, value, index }) => [request, value, index]),
    [
      [0xa1, 0, 0],
      [0x9a, 0x1312, 0xfa83],
      [0x9a, 0x2518, 0xc3],
      [0x9a, 0x2727, 0],
      [0xa4, 0xffff, 0],
    ],
  );

  const writer = port.writable.getWriter();
  await writer.write(Uint8Array.from([0x44, 0x45, 0x41, 0x30, 0x0a]));
  writer.releaseLock();
  assert.equal(device.writes[0].endpoint, 2);
  assert.deepEqual(
    [...device.writes[0].bytes],
    [0x44, 0x45, 0x41, 0x30, 0x0a],
  );
  await port.close();
});

test("configures STM32 ROM framing and inverts DTR/RTS control bits", async () => {
  const device = makeMockDevice();
  const port = new G2CaseWebUsbPort(device);
  await port.open({
    baudRate: 115_200,
    dataBits: 8,
    stopBits: 1,
    parity: "even",
    flowControl: "none",
  });
  await port.setSignals({
    dataTerminalReady: true,
    requestToSend: true,
  });

  const controls = device.calls
    .filter(([kind]) => kind === "controlOut")
    .map(([, setup]) => setup);
  assert.equal(
    controls.some(
      ({ request, value, index }) =>
        request === 0x9a && value === 0x1312 && index === 0xcc83,
    ),
    true,
  );
  assert.equal(
    controls.some(
      ({ request, value, index }) =>
        request === 0x9a && value === 0x2518 && index === 0xdb,
    ),
    true,
  );
  assert.deepEqual(
    [controls.at(-1).request, controls.at(-1).value],
    [0xa4, 0xff9f],
  );
  await port.close();
});

test("streams bulk input and cancels a pending WebUSB read cleanly", async () => {
  const device = makeMockDevice({ reads: [[0xde, 0xa0, 0x0a]] });
  const port = new G2CaseWebUsbPort(device);
  await port.open({
    baudRate: 1_000_000,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
    bufferSize: 64,
  });

  const reader = port.readable.getReader();
  const { value, done } = await reader.read();
  assert.equal(done, false);
  assert.deepEqual([...value], [0xde, 0xa0, 0x0a]);
  await reader.cancel();
  reader.releaseLock();

  assert.equal(device.opened, false);
  assert.equal(
    device.calls.some(([kind, endpoint]) => kind === "transferIn" && endpoint === 2),
    true,
  );
});
