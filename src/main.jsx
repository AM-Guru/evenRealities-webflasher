import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { webFlasherBrowserSupported } from "./lib/browserCompatibility.js";
import "./styles.css";

function UnsupportedBrowserModal() {
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div className="browser-compatibility-backdrop">
      <section
        ref={dialogRef}
        className="browser-compatibility-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="browser-compatibility-title"
        aria-describedby="browser-compatibility-description"
        tabIndex="-1"
      >
        <div className="browser-compatibility-icon" aria-hidden="true">
          !
        </div>
        <div className="eyebrow">Unsupported browser</div>
        <h1 id="browser-compatibility-title">
          This browser can’t run WebFlasher
        </h1>
        <p id="browser-compatibility-description">
          WebFlasher needs secure firmware validation and direct browser access
          to Bluetooth or USB hardware. Open this page in the latest desktop
          version of Google Chrome to continue.
        </p>
        <a
          className="browser-compatibility-action"
          href="https://www.google.com/chrome/"
          target="_blank"
          rel="noreferrer"
        >
          Get Google Chrome
          <span aria-hidden="true">↗</span>
        </a>
      </section>
    </div>
  );
}

function BrowserCompatibilityGate({ children }) {
  if (!webFlasherBrowserSupported()) return <UnsupportedBrowserModal />;
  return children;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserCompatibilityGate>
      <App />
    </BrowserCompatibilityGate>
  </StrictMode>,
);
