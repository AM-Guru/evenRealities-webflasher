const INFOC_BOOT_OVERRIDE = 0x250;
const INFOC_WIRED_CONFIG = 0x254;
const INFOC_INFO0_SELECTOR = 0x3fc;

const INFO0_WIRED_CFG0 = 0x28;
const INFO0_WIRED_CFG1 = 0x2c;
const INFO0_WIRED_CFG2 = 0x30;
const INFO0_WIRED_CFG3 = 0x34;
const INFO0_WIRED_CFG4 = 0x38;
const INFO0_WIRED_CFG5 = 0x3c;
const INFO0_WIRED_TIMEOUT = 0x54;
const INFO0_MAIN_POINTER = 0x60;
const INFO0_CERTIFICATE_CHAIN_POINTER = 0x64;
const INFO0_MRAM_RECOVERY_CONTROL = 0x68;

export const G2_APPLICATION_UART = Object.freeze({
  module: 2,
  baud: 1_000_000,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  rxPin: 44,
  txPin: 42,
  pinConfigurationWords: [
    "0x00000004",
    "0x00000004",
    "0x00000000",
    "0x00000000",
  ],
});

function asBytes(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function word(data, offset, label) {
  const bytes = asBytes(data);
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error(`${label} does not include the word at offset 0x${offset.toString(16)}.`);
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(offset, true);
}

function hex32(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

function populationCount(value) {
  let remaining = value >>> 0;
  let count = 0;
  while (remaining) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

export function decodeBootOverride(value) {
  return {
    raw: hex32(value),
    enabled: Boolean(value & (1 << 9)),
    activeLevel: value & (1 << 8) ? "high" : "low",
    gpio: value & 0xff,
  };
}

export function decodeWiredConfiguration(value) {
  return {
    raw: hex32(value),
    uartEnabled: Boolean(value & 1),
    spiEnabled: Boolean(value & 2),
    slaveInterruptPin: (value >>> 3) & 0xff,
    uartModule: (value >>> 16) & 0x3,
  };
}

export function decodeUartConfiguration0(value) {
  const parityEnabled = Boolean(value & (1 << 3));
  return {
    raw: hex32(value),
    baud: (value >>> 8) & 0x3fffff,
    dataBits: 5 + ((value >>> 6) & 0x3),
    stopBits: value & (1 << 5) ? 2 : 1,
    parity: parityEnabled ? (value & (1 << 4) ? "even" : "odd") : "none",
    cts: Boolean(value & (1 << 2)),
    rts: Boolean(value & (1 << 1)),
  };
}

export function decodeUartConfiguration1(value) {
  return {
    raw: hex32(value),
    rxPin: value & 0xff,
    txPin: (value >>> 8) & 0xff,
    ctsPin: (value >>> 16) & 0xff,
    rtsPin: (value >>> 24) & 0xff,
  };
}

export function decodeMramRecoveryControl(value) {
  const nonvolatileType = (value >>> 4) & 0x7;
  const masterField = (value >>> 28) & 0xf;
  return {
    raw: hex32(value),
    masterField,
    masterEnabled: masterField === 0x6,
    inProgressGpio: (value >>> 20) & 0xff,
    watchdogEnabled: Boolean(value & (1 << 17)),
    triggerGpioLevel: value & (1 << 16) ? "high" : "low",
    triggerGpio: (value >>> 8) & 0xff,
    applicationRecoveryReboots: Boolean(value & (1 << 7)),
    nonvolatileRecoveryType:
      { 0: "disabled", 1: "mspi", 2: "emmc" }[nonvolatileType] ??
      `reserved-${nonvolatileType}`,
    nonvolatileModule: (value >>> 2) & 0x3,
    wiredRecoveryEnabled: Boolean(value & (1 << 1)),
    applicationRecoveryEnabled: Boolean(value & 1),
  };
}

export function decodeApollo510RecoveryConfig({ infoc = null, info0 = null }) {
  if (!infoc && !info0) {
    throw new Error("Provide an INFOC or active INFO0 debugger dump.");
  }

  const report = {
    schemaVersion: 1,
    mode: "offline-read-only-dump-decoder",
    expectedG2ApplicationUart: G2_APPLICATION_UART,
    backupReadbackProvided: false,
  };

  if (infoc) {
    const bytes = asBytes(infoc);
    if (bytes.length < 0x400) {
      throw new Error("INFOC must begin at 0x400C2000 and contain at least 0x400 bytes.");
    }
    report.bootOverride = decodeBootOverride(
      word(bytes, INFOC_BOOT_OVERRIDE, "INFOC"),
    );
    report.wiredConfiguration = decodeWiredConfiguration(
      word(bytes, INFOC_WIRED_CONFIG, "INFOC"),
    );
    const selector = word(bytes, INFOC_INFO0_SELECTOR, "INFOC");
    const setBitCount = populationCount(selector);
    report.info0Selector = {
      raw: hex32(selector),
      setBitCount,
      selectedSpace: setBitCount & 1 ? "OTP" : "MRAM",
    };
  }

  if (info0) {
    const bytes = asBytes(info0);
    if (bytes.length < 0x6c) {
      throw new Error("Active INFO0 must begin at offset zero and contain at least 0x6C bytes.");
    }
    const uart = {
      ...decodeUartConfiguration0(word(bytes, INFO0_WIRED_CFG0, "INFO0")),
      ...decodeUartConfiguration1(word(bytes, INFO0_WIRED_CFG1, "INFO0")),
      pinConfigurationWords: [
        INFO0_WIRED_CFG2,
        INFO0_WIRED_CFG3,
        INFO0_WIRED_CFG4,
        INFO0_WIRED_CFG5,
      ].map((offset) => hex32(word(bytes, offset, "INFO0"))),
    };
    const wiredTimeoutMs = word(bytes, INFO0_WIRED_TIMEOUT, "INFO0") & 0xffff;
    const mramRecovery = decodeMramRecoveryControl(
      word(bytes, INFO0_MRAM_RECOVERY_CONTROL, "INFO0"),
    );
    report.info0 = {
      uart,
      wiredTimeoutMs,
      mainPointer: hex32(word(bytes, INFO0_MAIN_POINTER, "INFO0")),
      certificateChainPointer: hex32(
        word(bytes, INFO0_CERTIFICATE_CHAIN_POINTER, "INFO0"),
      ),
      mramRecovery,
    };

    const wired = report.wiredConfiguration;
    const pinConfigurationWordsMatch =
      JSON.stringify(uart.pinConfigurationWords) ===
      JSON.stringify(G2_APPLICATION_UART.pinConfigurationWords);
    const allKnownFieldsMatch = Boolean(
      wired?.uartEnabled &&
      wired.uartModule === G2_APPLICATION_UART.module &&
      uart.baud === G2_APPLICATION_UART.baud &&
      uart.dataBits === G2_APPLICATION_UART.dataBits &&
      uart.stopBits === G2_APPLICATION_UART.stopBits &&
      uart.parity === G2_APPLICATION_UART.parity &&
      !uart.cts &&
      !uart.rts &&
      uart.rxPin === G2_APPLICATION_UART.rxPin &&
      uart.txPin === G2_APPLICATION_UART.txPin &&
      pinConfigurationWordsMatch
    );
    const configuredReceiveWindowNonzero = wiredTimeoutMs > 0;
    report.pogoMatch = {
      uartModuleMatches: wired?.uartModule === G2_APPLICATION_UART.module,
      baudMatches: uart.baud === G2_APPLICATION_UART.baud,
      framingMatches:
        uart.dataBits === G2_APPLICATION_UART.dataBits &&
        uart.stopBits === G2_APPLICATION_UART.stopBits &&
        uart.parity === G2_APPLICATION_UART.parity,
      rxPinMatches: uart.rxPin === G2_APPLICATION_UART.rxPin,
      txPinMatches: uart.txPin === G2_APPLICATION_UART.txPin,
      flowControlDisabled: !uart.cts && !uart.rts,
      pinConfigurationWordsMatch,
      allKnownFieldsMatch,
    };
    report.decision = {
      completeProvisioningEvidence: Boolean(infoc),
      sblUartRestoreCandidate:
        Boolean(infoc) && allKnownFieldsMatch && configuredReceiveWindowNonzero,
      configuredReceiveWindowNonzero,
      forcedEntryContactCandidate: Boolean(
        report.bootOverride?.enabled &&
        [42, 44].includes(report.bootOverride.gpio)
      ),
      mramWiredRecoveryCandidate:
        Boolean(infoc) &&
        allKnownFieldsMatch &&
        configuredReceiveWindowNonzero &&
        mramRecovery.masterEnabled &&
        mramRecovery.wiredRecoveryEnabled,
      interpretation:
        "A positive result supports a restore candidate only; Ambiq's documented UART host does not provide installed-MRAM readback.",
    };
  }

  return report;
}
