const G2_CASE_VENDOR_ID = 0x1a86;
const G2_CASE_PRODUCT_ID = 0x7523;

const CH341_REQ_READ_VERSION = 0x5f;
const CH341_REQ_WRITE_REG = 0x9a;
const CH341_REQ_SERIAL_INIT = 0xa1;
const CH341_REQ_MODEM_CTRL = 0xa4;

const CH341_REG_PRESCALER = 0x12;
const CH341_REG_DIVISOR = 0x13;
const CH341_REG_LCR = 0x18;
const CH341_REG_LCR2 = 0x25;
const CH341_REG_FLOW_CTL = 0x27;

const CH341_BIT_DTR = 1 << 5;
const CH341_BIT_RTS = 1 << 6;
const CH341_LCR_ENABLE_RX = 0x80;
const CH341_LCR_ENABLE_TX = 0x40;
const CH341_LCR_MARK_SPACE = 0x20;
const CH341_LCR_PAR_EVEN = 0x10;
const CH341_LCR_ENABLE_PAR = 0x08;
const CH341_LCR_STOP_BITS_2 = 0x04;
const CH341_CLOCK_RATE = 48_000_000;
const CH341_MIN_BAUD_RATE = 46;
const CH341_MAX_BAUD_RATE = 3_000_000;

function usbSetup(request, value = 0, index = 0) {
  return {
    requestType: "vendor",
    recipient: "device",
    request,
    value,
    index,
  };
}

function requireOk(result, label) {
  if (result?.status !== "ok") {
    throw new DOMException(
      `${label} failed with USB status ${result?.status ?? "unknown"}.`,
      "NetworkError",
    );
  }
  return result;
}

function alternateHasBulkPair(alternate) {
  const endpoints = alternate?.endpoints ?? [];
  return (
    endpoints.some(
      (endpoint) => endpoint.type === "bulk" && endpoint.direction === "in",
    ) &&
    endpoints.some(
      (endpoint) => endpoint.type === "bulk" && endpoint.direction === "out",
    )
  );
}

function findTransferInterface(device) {
  for (const usbInterface of device.configuration?.interfaces ?? []) {
    const alternate =
      usbInterface.alternates.find(alternateHasBulkPair) ??
      (alternateHasBulkPair(usbInterface.alternate)
        ? usbInterface.alternate
        : null);
    if (alternate) return { usbInterface, alternate };
  }
  throw new Error("The CH340 USB interface does not expose bulk IN/OUT endpoints.");
}

function findBulkEndpoint(alternate, direction) {
  const endpoint = alternate.endpoints.find(
    (candidate) =>
      candidate.type === "bulk" && candidate.direction === direction,
  );
  if (!endpoint) {
    throw new Error(`The CH340 USB interface has no bulk ${direction} endpoint.`);
  }
  return endpoint;
}

export function isG2CaseUsbDevice(device) {
  return (
    device?.vendorId === G2_CASE_VENDOR_ID &&
    device?.productId === G2_CASE_PRODUCT_ID
  );
}

export function ch341Divisor(baudRate, version = 0x30) {
  if (
    !Number.isInteger(baudRate) ||
    baudRate < CH341_MIN_BAUD_RATE ||
    baudRate > CH341_MAX_BAUD_RATE
  ) {
    throw new RangeError(
      `CH340 baud rate must be an integer from ${CH341_MIN_BAUD_RATE} to ${CH341_MAX_BAUD_RATE}.`,
    );
  }

  let factor = 1;
  let prescaler = 3;
  const minimumRate = (candidate) => {
    const clockDivisor = 1 << (12 - 3 * candidate - 1);
    return Math.ceil(CH341_CLOCK_RATE / (clockDivisor * 512));
  };
  while (prescaler >= 0 && baudRate <= minimumRate(prescaler)) {
    prescaler -= 1;
  }
  if (prescaler < 0) {
    throw new RangeError(`CH340 cannot represent baud rate ${baudRate}.`);
  }

  let clockDivisor = 1 << (12 - 3 * prescaler - factor);
  let divisor = Math.floor(CH341_CLOCK_RATE / (clockDivisor * baudRate));
  if (divisor < 9 || divisor > 255) {
    divisor = Math.floor(divisor / 2);
    clockDivisor *= 2;
    factor = 0;
  }
  if (divisor < 2) {
    throw new RangeError(`CH340 cannot represent baud rate ${baudRate}.`);
  }

  const highRate = CH341_CLOCK_RATE / (clockDivisor * divisor);
  const lowRate = CH341_CLOCK_RATE / (clockDivisor * (divisor + 1));
  if (highRate - baudRate >= baudRate - lowRate) divisor += 1;

  if (factor === 1 && divisor % 2 === 0) {
    divisor /= 2;
    factor = 0;
  }

  let encoded = ((0x100 - divisor) << 8) | (factor << 2) | prescaler;
  // Newer CH340 variants use bit 7 to flush sub-packet writes immediately.
  if (version > 0x27) encoded |= 0x80;
  return encoded;
}

export function ch341LineControl({
  dataBits = 8,
  stopBits = 1,
  parity = "none",
} = {}) {
  if (![5, 6, 7, 8].includes(dataBits)) {
    throw new RangeError("CH340 data bits must be 5, 6, 7, or 8.");
  }
  if (![1, 2].includes(stopBits)) {
    throw new RangeError("CH340 stop bits must be 1 or 2.");
  }
  if (!["none", "odd", "even", "mark", "space"].includes(parity)) {
    throw new RangeError("CH340 parity must be none, odd, even, mark, or space.");
  }

  let value =
    CH341_LCR_ENABLE_RX |
    CH341_LCR_ENABLE_TX |
    (dataBits - 5);
  if (stopBits === 2) value |= CH341_LCR_STOP_BITS_2;
  if (parity !== "none") {
    value |= CH341_LCR_ENABLE_PAR;
    if (parity === "even" || parity === "space") {
      value |= CH341_LCR_PAR_EVEN;
    }
    if (parity === "mark" || parity === "space") {
      value |= CH341_LCR_MARK_SPACE;
    }
  }
  return value;
}

class UsbBulkReadableSource {
  constructor(port) {
    this.port = port;
    this.type = "bytes";
  }

  async pull(controller) {
    try {
      const endpoint = this.port.inEndpoint;
      const desired = Math.max(
        endpoint.packetSize,
        Math.min(
          this.port.bufferSize,
          Math.ceil(
            Math.max(controller.desiredSize ?? 0, endpoint.packetSize) /
              endpoint.packetSize,
          ) * endpoint.packetSize,
        ),
      );
      const result = requireOk(
        await this.port.device.transferIn(endpoint.endpointNumber, desired),
        "CH340 bulk read",
      );
      if (result.data?.byteLength) {
        const bytes = new Uint8Array(
          result.data.buffer,
          result.data.byteOffset,
          result.data.byteLength,
        );
        controller.enqueue(bytes.slice());
      }
    } catch (error) {
      if (this.port.closing) {
        // Deliberate teardown: end the stream so the transport pump observes
        // "done" instead of re-invoking pull against a closed device.
        try {
          controller.close();
        } catch {
          // A prior pull may already have closed or errored the stream.
        }
        return;
      }
      if (!this.port.device.opened) {
        // The device vanished (unplug, reset) outside any deliberate close.
        // Wrap the raw disconnect exception: the transport pump treats
        // NetworkError/AbortError as ordinary teardown noise, so the raw
        // DOMException would be silently discarded and every later read
        // would degrade into a wall-clock timeout with the cause lost.
        controller.error(
          Object.assign(
            new Error(
              `The G2 Case USB device is no longer open (${error?.message ?? String(error)}). It was disconnected or reset outside a deliberate close.`,
            ),
            { cause: error },
          ),
        );
        return;
      }
      controller.error(error);
    }
  }

  async cancel() {
    // WebUSB has no per-transfer cancellation. Closing the USB device is the
    // only portable way to interrupt a pending transferIn during teardown.
    await this.port.closeDevice();
  }
}

class UsbBulkWritableSink {
  constructor(port) {
    this.port = port;
  }

  async write(chunk) {
    const bytes =
      chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const result = requireOk(
      await this.port.device.transferOut(
        this.port.outEndpoint.endpointNumber,
        bytes,
      ),
      "CH340 bulk write",
    );
    if (
      Number.isInteger(result.bytesWritten) &&
      result.bytesWritten !== bytes.byteLength
    ) {
      throw new DOMException(
        `CH340 bulk write accepted ${result.bytesWritten} of ${bytes.byteLength} bytes.`,
        "NetworkError",
      );
    }
  }
}

export class G2CaseWebUsbPort {
  constructor(device) {
    if (!isG2CaseUsbDevice(device)) {
      throw new TypeError("The selected WebUSB device is not a G2 Case CH340.");
    }
    this.device = device;
    this.transportKind = "webusb";
    this.interfaceNumber = null;
    this.inEndpoint = null;
    this.outEndpoint = null;
    this.version = null;
    this.bufferSize = 4096;
    this.outputSignals = {
      dataTerminalReady: false,
      requestToSend: false,
    };
    this.readableStream = null;
    this.writableStream = null;
    this.closing = false;
  }

  get readable() {
    if (!this.device.opened) return null;
    if (!this.readableStream) {
      this.readableStream = new ReadableStream(
        new UsbBulkReadableSource(this),
        { highWaterMark: this.bufferSize },
      );
    }
    return this.readableStream;
  }

  get writable() {
    if (!this.device.opened) return null;
    if (!this.writableStream) {
      this.writableStream = new WritableStream(
        new UsbBulkWritableSink(this),
        new ByteLengthQueuingStrategy({ highWaterMark: this.bufferSize }),
      );
    }
    return this.writableStream;
  }

  get usbDevice() {
    return this.device;
  }

  getInfo() {
    return {
      usbVendorId: this.device.vendorId,
      usbProductId: this.device.productId,
      transport: this.transportKind,
    };
  }

  async controlIn(request, value, index, length, label) {
    const result = requireOk(
      await this.device.controlTransferIn(
        usbSetup(request, value, index),
        length,
      ),
      label,
    );
    if (!result.data || result.data.byteLength !== length) {
      throw new DOMException(
        `${label} returned ${result.data?.byteLength ?? 0} of ${length} bytes.`,
        "NetworkError",
      );
    }
    return new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    ).slice();
  }

  async controlOut(request, value, index, label) {
    requireOk(
      await this.device.controlTransferOut(
        usbSetup(request, value, index),
      ),
      label,
    );
  }

  async configureLine(options) {
    const divisor = ch341Divisor(options.baudRate, this.version);
    const lineControl = ch341LineControl(options);
    await this.controlOut(
      CH341_REQ_WRITE_REG,
      (CH341_REG_DIVISOR << 8) | CH341_REG_PRESCALER,
      divisor,
      "CH340 baud-rate setup",
    );
    if (this.version < 0x30 && lineControl !== 0xc3) {
      throw new Error(
        `CH340 revision 0x${this.version
          .toString(16)
          .padStart(2, "0")} cannot safely configure the requested parity.`,
      );
    }
    if (this.version >= 0x30) {
      await this.controlOut(
        CH341_REQ_WRITE_REG,
        (CH341_REG_LCR2 << 8) | CH341_REG_LCR,
        lineControl,
        "CH340 line-control setup",
      );
    }
    if (options.flowControl !== undefined && options.flowControl !== "none") {
      throw new RangeError("The G2 Case WebUSB transport requires no flow control.");
    }
    await this.controlOut(
      CH341_REQ_WRITE_REG,
      (CH341_REG_FLOW_CTL << 8) | CH341_REG_FLOW_CTL,
      0,
      "CH340 flow-control setup",
    );
  }

  async open(options) {
    if (this.device.opened) {
      throw new DOMException("The G2 Case WebUSB port is already open.", "InvalidStateError");
    }
    this.closing = false;
    this.bufferSize = Math.max(64, options?.bufferSize ?? 4096);
    try {
      await this.device.open();
      if (!this.device.configuration) {
        const configurationValue =
          this.device.configurations?.[0]?.configurationValue ?? 1;
        await this.device.selectConfiguration(configurationValue);
      }
      const { usbInterface, alternate } = findTransferInterface(this.device);
      this.interfaceNumber = usbInterface.interfaceNumber;
      await this.device.claimInterface(this.interfaceNumber);
      if (
        alternate.alternateSetting !== undefined &&
        alternate.alternateSetting !== usbInterface.alternate?.alternateSetting
      ) {
        await this.device.selectAlternateInterface(
          this.interfaceNumber,
          alternate.alternateSetting,
        );
      }
      this.inEndpoint = findBulkEndpoint(alternate, "in");
      this.outEndpoint = findBulkEndpoint(alternate, "out");

      const version = await this.controlIn(
        CH341_REQ_READ_VERSION,
        0,
        0,
        2,
        "CH340 version read",
      );
      this.version = version[0];
      await this.controlOut(
        CH341_REQ_SERIAL_INIT,
        0,
        0,
        "CH340 serial initialization",
      );
      await this.configureLine(options);
      await this.setSignals({
        dataTerminalReady: false,
        requestToSend: false,
      });
    } catch (error) {
      await this.closeDevice();
      throw new Error(
        `Could not open the G2 Case through WebUSB: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  async setSignals(signals) {
    this.outputSignals = { ...this.outputSignals, ...signals };
    let control = 0;
    if (this.outputSignals.dataTerminalReady) control |= CH341_BIT_DTR;
    if (this.outputSignals.requestToSend) control |= CH341_BIT_RTS;
    await this.controlOut(
      CH341_REQ_MODEM_CTRL,
      (~control) & 0xffff,
      0,
      "CH340 DTR/RTS setup",
    );
  }

  async closeDevice() {
    if (!this.device.opened) return;
    try {
      if (this.interfaceNumber !== null) {
        await this.device.releaseInterface(this.interfaceNumber);
      }
    } catch {
      // A Case reset can invalidate the claimed interface before teardown.
    }
    try {
      await this.device.close();
    } catch {
      // Treat an already-disconnected USB device as closed.
    }
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try {
      if (this.device.opened) {
        try {
          await this.setSignals({
            dataTerminalReady: false,
            requestToSend: false,
          });
        } catch {
          // A reset may remove the device before its signals can be cleared.
        }
      }
      await this.closeDevice();
    } finally {
      this.readableStream = null;
      this.writableStream = null;
      this.interfaceNumber = null;
      this.inEndpoint = null;
      this.outEndpoint = null;
      this.closing = false;
    }
  }
}

export function webUsbSupported() {
  return (
    typeof navigator !== "undefined" &&
    "usb" in navigator &&
    typeof navigator.usb.requestDevice === "function"
  );
}

export async function requestG2CaseUsbPort() {
  if (!webUsbSupported()) {
    throw new Error(
      "WebUSB is not available. Use a Chromium-based browser in a secure context.",
    );
  }
  const grantedDevices = (await navigator.usb.getDevices()).filter(
    isG2CaseUsbDevice,
  );
  const device =
    grantedDevices.length === 1
      ? grantedDevices[0]
      : await navigator.usb.requestDevice({
          filters: [
            {
              vendorId: G2_CASE_VENDOR_ID,
              productId: G2_CASE_PRODUCT_ID,
            },
          ],
        });
  return new G2CaseWebUsbPort(device);
}
