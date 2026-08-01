import { Playground } from "@/components/Playground";

/**
 * A server component on purpose: the header is real HTML in the response, and
 * only what genuinely needs a browser is shipped as a client component.
 */
export default function Home() {
  return (
    <main className="page">
      <header className="page-header">
        <h1 className="page-title">CodeCrypto Wallet — test dApp</h1>
        <p className="page-lede">
          A page to exercise the wallet extension from the outside, the way a real dApp
          would: discovery through EIP-6963, calls through EIP-1193, and nothing else. It
          knows no more about the wallet than it would about MetaMask.
        </p>
      </header>

      <Playground />

      <footer className="section">
        <p className="section-note">
          Reading a balance goes through the extension&apos;s service worker, never through
          this page — so an HTTPS site can talk to a local node over plain HTTP without any
          mixed-content problem. See the README for why.
        </p>
      </footer>
    </main>
  );
}
