import { Onboarding } from "@/ui/components/Onboarding";
import { WalletView } from "@/ui/components/WalletView";
import { useWalletState } from "@/ui/hooks/useWalletState";

export function Popup() {
  const { snapshot, error, isLoading, refresh } = useWalletState();

  return (
    <main className="popup">
      <header className="app-header">
        <h1>CodeCrypto Wallet</h1>
      </header>

      {snapshot === null && isLoading && (
        <p className="muted" data-testid="popup-loading">
          Loading…
        </p>
      )}

      {snapshot === null && !isLoading && (
        <p className="banner banner--error" data-testid="wallet-error-banner">
          {error?.message ?? "The wallet state could not be read."}
        </p>
      )}

      {snapshot !== null &&
        (snapshot.isLoaded ? (
          <WalletView snapshot={snapshot} onChanged={() => void refresh()} />
        ) : (
          <Onboarding onReady={() => void refresh()} />
        ))}
    </main>
  );
}
