import { findTempleFlashTarget } from "./templeFlashTargets.js";

const MAIN_COMPONENT = "ota/s200_firmware_ota.bin";

function asBytes(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input ?? 0);
}

function componentKey(component) {
  return `${component.typeId}:${component.name}`;
}

export function describeByteDifferences(sourceInput, targetInput, maxRanges = 64) {
  const source = asBytes(sourceInput);
  const target = asBytes(targetInput);
  const comparedBytes = Math.max(source.length, target.length);
  const ranges = [];
  let rangeCount = 0;
  let changedBytes = 0;
  let rangeStart = -1;

  const closeRange = (end) => {
    if (rangeStart < 0) return;
    rangeCount += 1;
    if (ranges.length < maxRanges) {
      ranges.push({
        offset: rangeStart,
        length: end - rangeStart,
        sourceEnd: Math.min(end, source.length),
        targetEnd: Math.min(end, target.length),
      });
    }
    rangeStart = -1;
  };

  for (let offset = 0; offset < comparedBytes; offset += 1) {
    const different =
      offset >= source.length ||
      offset >= target.length ||
      source[offset] !== target[offset];
    if (different) {
      changedBytes += 1;
      if (rangeStart < 0) rangeStart = offset;
    } else {
      closeRange(offset);
    }
  }
  closeRange(comparedBytes);

  return {
    sourceBytes: source.length,
    targetBytes: target.length,
    comparedBytes,
    changedBytes,
    unchangedBytes: comparedBytes - changedBytes,
    rangeCount,
    ranges,
    rangesTruncated: rangeCount > ranges.length,
  };
}

export function findStockCfwCounterpartRelease(catalog, targetFirmware) {
  const target = targetFirmware?.templeFlashTarget;
  if (!target) return null;
  const targetChannel = targetFirmware.provenance?.channel;

  if (targetChannel === "custom") {
    return (
      catalog.find(
        (release) =>
          (release.channel ?? "official") === "official" &&
          release.version === targetFirmware.provenance.baseVersion,
      ) ?? null
    );
  }

  if (targetChannel === "official") {
    return (
      catalog.find(
        (release) =>
          release.channel === "custom" &&
          release.baseVersion === targetFirmware.g2Version,
      ) ?? null
    );
  }
  return null;
}

export function buildBundleDifferencePlan(sourceFirmware, targetFirmware) {
  const sourceTarget = findTempleFlashTarget(sourceFirmware?.fileSha256);
  const targetTarget = findTempleFlashTarget(targetFirmware?.fileSha256);
  if (
    sourceFirmware?.kind !== "bundle" ||
    targetFirmware?.kind !== "bundle" ||
    !sourceTarget ||
    !targetTarget
  ) {
    throw new Error(
      "Flash differences requires two exact, hash-pinned G2 firmware bundles.",
    );
  }
  if (
    sourceTarget.imageSha256 === targetTarget.imageSha256 ||
    new Set([sourceTarget.version, targetTarget.version]).size !== 2
  ) {
    throw new Error(
      "Flash differences requires two different reviewed Stock/CFW targets.",
    );
  }

  const channels = new Set([
    sourceFirmware.provenance?.channel,
    targetFirmware.provenance?.channel,
  ]);
  if (!channels.has("official") || !channels.has("custom")) {
    throw new Error(
      "Flash differences requires one official Stock image and one reviewed CFW image.",
    );
  }
  const customFirmware =
    sourceFirmware.provenance?.channel === "custom"
      ? sourceFirmware
      : targetFirmware;
  const officialFirmware =
    sourceFirmware.provenance?.channel === "official"
      ? sourceFirmware
      : targetFirmware;
  if (customFirmware.provenance?.baseVersion !== officialFirmware.g2Version) {
    throw new Error(
      "Flash differences requires the exact official Stock base of the reviewed CFW image.",
    );
  }

  const sourceComponents = new Map(
    (sourceFirmware.componentImages ?? []).map((component) => [
      componentKey(component),
      component,
    ]),
  );
  const targetComponents = new Map(
    (targetFirmware.componentImages ?? []).map((component) => [
      componentKey(component),
      component,
    ]),
  );
  if (
    sourceComponents.size !== targetComponents.size ||
    sourceComponents.size < 5
  ) {
    throw new Error("The Stock and CFW component topologies do not match.");
  }

  const components = [];
  for (const [key, targetComponent] of targetComponents) {
    const sourceComponent = sourceComponents.get(key);
    if (!sourceComponent) {
      throw new Error(`The source bundle is missing ${targetComponent.name}.`);
    }
    const changed =
      sourceComponent.payloadSha256 !== targetComponent.payloadSha256 ||
      sourceComponent.payloadSize !== targetComponent.payloadSize;
    components.push({
      name: targetComponent.name,
      typeId: targetComponent.typeId,
      changed,
      sourceBytes: sourceComponent.payloadSize,
      targetBytes: targetComponent.payloadSize,
      sourceSha256: sourceComponent.payloadSha256,
      targetSha256: targetComponent.payloadSha256,
    });
  }

  const changedComponents = components.filter((component) => component.changed);
  const unchangedComponents = components.filter((component) => !component.changed);
  const mainSource = sourceFirmware.mainComponent;
  const mainTarget = targetFirmware.mainComponent;
  const mainDifferences = describeByteDifferences(
    mainSource?.payload,
    mainTarget?.payload,
  );
  const changedMainOnly =
    changedComponents.length === 1 &&
    changedComponents[0].name === MAIN_COMPONENT &&
    changedComponents[0].typeId === 0;

  return {
    schemaVersion: 1,
    mode: "bundle-component-differences",
    source: {
      imageSha256: sourceFirmware.fileSha256,
      mainSha256: sourceTarget.mainSha256,
      label: sourceTarget.label,
      version: sourceTarget.version,
    },
    target: {
      imageSha256: targetFirmware.fileSha256,
      mainSha256: targetTarget.mainSha256,
      label: targetTarget.label,
      version: targetTarget.version,
    },
    components,
    changedComponentCount: changedComponents.length,
    unchangedComponentCount: unchangedComponents.length,
    skippedComponentBytes: unchangedComponents.reduce(
      (total, component) => total + component.targetBytes,
      0,
    ),
    changedMainOnly,
    mainDifferences,
    wireTransfer: {
      component: MAIN_COMPONENT,
      bytes: mainTarget?.payload?.length ?? 0,
      records: Math.ceil((mainTarget?.payload?.length ?? 0) / 1000),
      sparseByteRangesSupported: false,
      reason:
        "The G2 OTA receiver accepts one contiguous, CRC-gated component stream and exposes no destination offset.",
    },
    verification: {
      targetBundleSha256: targetFirmware.fileSha256,
      targetMainSha256: targetTarget.mainSha256,
      targetMainBytes: targetTarget.mainBytes,
      finishAcknowledgementRequired: true,
      postResetLivenessRequired: true,
      finalDualTempleResetRequired: true,
    },
    executable: Boolean(
      changedMainOnly &&
        mainTarget?.payload?.length === targetTarget.mainBytes &&
        mainTarget?.payloadSha256 === targetTarget.mainSha256,
    ),
  };
}
