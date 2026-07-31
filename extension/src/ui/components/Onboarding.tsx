import { useState } from "react";

import { CreateWalletFlow } from "./CreateWalletFlow";
import { ImportWalletFlow } from "./ImportWalletFlow";

type Step = "choice" | "create" | "import";

interface OnboardingProps {
  onReady(): void;
}

export function Onboarding({ onReady }: OnboardingProps) {
  const [step, setStep] = useState<Step>("choice");

  if (step === "create") {
    return <CreateWalletFlow onCreated={onReady} onBack={() => setStep("choice")} />;
  }

  if (step === "import") {
    return <ImportWalletFlow onImported={onReady} onBack={() => setStep("choice")} />;
  }

  return (
    <section className="stack" data-testid="onboarding-view">
      <h2>No wallet yet</h2>
      <p className="muted">Create a new wallet, or restore one from its recovery phrase.</p>

      <button
        type="button"
        className="button--primary button--block"
        onClick={() => setStep("create")}
        data-testid="create-wallet-button"
      >
        Create a new wallet
      </button>

      <button
        type="button"
        className="button--block"
        onClick={() => setStep("import")}
        data-testid="import-wallet-button"
      >
        Import an existing wallet
      </button>
    </section>
  );
}
