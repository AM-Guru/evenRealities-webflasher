function isFunction(value) {
  return typeof value === "function";
}

export function webFlasherBrowserCapabilities({
  navigatorObject = globalThis.navigator,
  cryptoObject = globalThis.crypto,
} = {}) {
  const webBluetooth = isFunction(navigatorObject?.bluetooth?.requestDevice);
  const webUsb = isFunction(navigatorObject?.usb?.requestDevice);
  const webSerial = isFunction(navigatorObject?.serial?.requestPort);
  const secureFirmwareValidation = isFunction(cryptoObject?.subtle?.digest);

  return {
    webBluetooth,
    webUsb,
    webSerial,
    secureFirmwareValidation,
    supported:
      secureFirmwareValidation && (webBluetooth || webUsb || webSerial),
  };
}

export function webFlasherBrowserSupported(options) {
  return webFlasherBrowserCapabilities(options).supported;
}
