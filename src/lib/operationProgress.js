export const OPERATION_TOTALS = Object.freeze({
  analyze: 6,
  backup: 10,
  firmware: 3,
  "glasses-analyze": 4,
  pogo: 4,
  recheck: 6,
  "temple-flash": 14,
  "ble-temple-flash": 16,
  stage: 4,
  activate: 6,
});

export function operationProgress(name, fraction, totalOverride = null) {
  const bounded = Math.max(0, Math.min(1, Number(fraction) || 0));
  const total = Math.max(
    1,
    Math.trunc(totalOverride ?? OPERATION_TOTALS[name] ?? 1),
  );
  const completed =
    bounded >= 1 ? total : Math.min(total - 1, Math.floor(bounded * total));
  return {
    fraction: bounded,
    total,
    completed,
    current: Math.min(total, completed + 1),
    percent: Math.round(bounded * 100),
  };
}
