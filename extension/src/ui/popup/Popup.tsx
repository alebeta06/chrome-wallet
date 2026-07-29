/**
 * The extension popup, opened by clicking the toolbar icon.
 * Phase 0: renders its own name and nothing else.
 */
export function Popup() {
  return (
    <main style={{ font: "14px system-ui, sans-serif", padding: "1rem", minWidth: 320 }}>
      <h1 style={{ fontSize: "1rem", margin: 0 }}>CodeCrypto Wallet</h1>
      <p style={{ margin: "0.5rem 0 0", opacity: 0.7 }}>Popup</p>
    </main>
  );
}
