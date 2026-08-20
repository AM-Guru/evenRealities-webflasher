import assert from "node:assert/strict";
import test from "node:test";
import { Stm32Bootloader } from "../src/lib/serial.js";

const ACK = 0x79;
const GO = 0x21;

// Mirrors the transport's timeout wording so the staged tags are exercised by
// the same failure shape the remote Case link produces (a single lost ACK).
class ScriptedTransport {
  constructor(reads) {
    this.reads = [...reads];
    this.writes = [];
  }

  async write(bytes) {
    this.writes.push([...bytes]);
  }

  async readExact(count, timeoutMs, label) {
    const next = this.reads.shift();
    if (next === "timeout" || next === undefined) {
      throw new Error(
        `Timed out reading ${label}: received 0 of ${count} bytes.`,
      );
    }
    return Uint8Array.from(next);
  }

  async setSignals() {}
  async close() {}
  clear() {}
}

function makeLoader(transport) {
  const loader = new Stm32Bootloader({}, () => {});
  loader.transport = transport;
  loader.commands = [GO];
  return loader;
}

test("go tags a lost command ACK as a pre-jump failure", async () => {
  const loader = makeLoader(new ScriptedTransport(["timeout"]));
  await assert.rejects(loader.go(0x20011000), (error) => {
    assert.match(error.message, /Go command ACK/);
    assert.equal(error.romGoStage, "command");
    return true;
  });
});

test("go tags a lost address ACK as an ambiguous-jump failure", async () => {
  const loader = makeLoader(new ScriptedTransport([[ACK], "timeout"]));
  await assert.rejects(loader.go(0x20011000), (error) => {
    assert.match(error.message, /Go address ACK/);
    assert.equal(error.romGoStage, "address");
    return true;
  });
});

test("goWithLostAckRecovery reissues Go after a command-stage loss", async () => {
  const retryTransport = new ScriptedTransport([[ACK], [ACK]]);
  const loader = makeLoader(new ScriptedTransport(["timeout"]));
  let reconnects = 0;
  loader.close = async () => {};
  loader.connect = async () => {
    reconnects += 1;
    loader.transport = retryTransport;
  };
  const result = await loader.goWithLostAckRecovery(0x20011000);
  assert.deepEqual(result, { goAckLost: false });
  assert.equal(reconnects, 1);
  assert.deepEqual(retryTransport.writes[0], [GO, GO ^ 0xff]);
});

test("goWithLostAckRecovery never reissues Go after an address-stage loss", async () => {
  const transport = new ScriptedTransport([[ACK], "timeout"]);
  const loader = makeLoader(transport);
  let reconnects = 0;
  loader.connect = async () => {
    reconnects += 1;
  };
  const result = await loader.goWithLostAckRecovery(0x20011000);
  assert.deepEqual(result, { goAckLost: true });
  assert.equal(reconnects, 0);
  const goCommandWrites = transport.writes.filter(
    (bytes) => bytes[0] === GO && bytes[1] === (GO ^ 0xff),
  );
  assert.equal(goCommandWrites.length, 1);
});

test("goWithLostAckRecovery surfaces a persistent command-stage failure", async () => {
  const loader = makeLoader(new ScriptedTransport(["timeout"]));
  loader.close = async () => {};
  loader.connect = async () => {
    loader.transport = new ScriptedTransport(["timeout"]);
  };
  await assert.rejects(loader.goWithLostAckRecovery(0x20011000), (error) => {
    assert.equal(error.romGoStage, "command");
    return true;
  });
});
