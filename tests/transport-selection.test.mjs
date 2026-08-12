import assert from "node:assert/strict";
import test from "node:test";

import { preferredG2CaseTransport } from "../src/lib/serial.js";

test("WebUSB is the preferred G2 Case transport when both APIs are available", () => {
  assert.equal(
    preferredG2CaseTransport({ webUsb: true, webSerial: true }),
    "webusb",
  );
});

test("Web Serial remains the compatibility fallback", () => {
  assert.equal(
    preferredG2CaseTransport({ webUsb: false, webSerial: true }),
    "serial",
  );
  assert.equal(
    preferredG2CaseTransport({ webUsb: false, webSerial: false }),
    null,
  );
});
