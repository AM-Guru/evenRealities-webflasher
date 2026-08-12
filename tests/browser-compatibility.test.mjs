import assert from "node:assert/strict";
import test from "node:test";

import {
  webFlasherBrowserCapabilities,
  webFlasherBrowserSupported,
} from "../src/lib/browserCompatibility.js";

const secureCrypto = {
  subtle: {
    digest() {},
  },
};

test("accepts each supported WebFlasher hardware route", () => {
  for (const navigatorObject of [
    { bluetooth: { requestDevice() {} } },
    { usb: { requestDevice() {} } },
    { serial: { requestPort() {} } },
  ]) {
    assert.equal(
      webFlasherBrowserSupported({ navigatorObject, cryptoObject: secureCrypto }),
      true,
    );
  }
});

test("rejects a browser without WebFlasher hardware access", () => {
  assert.deepEqual(
    webFlasherBrowserCapabilities({
      navigatorObject: {},
      cryptoObject: secureCrypto,
    }),
    {
      webBluetooth: false,
      webUsb: false,
      webSerial: false,
      secureFirmwareValidation: true,
      supported: false,
    },
  );
});

test("rejects an insecure browser context without firmware hashing", () => {
  assert.equal(
    webFlasherBrowserSupported({
      navigatorObject: { bluetooth: { requestDevice() {} } },
      cryptoObject: {},
    }),
    false,
  );
});

test("requires callable APIs instead of presence-only browser shims", () => {
  assert.equal(
    webFlasherBrowserSupported({
      navigatorObject: {
        bluetooth: { requestDevice: true },
        usb: {},
        serial: { requestPort: null },
      },
      cryptoObject: secureCrypto,
    }),
    false,
  );
});
