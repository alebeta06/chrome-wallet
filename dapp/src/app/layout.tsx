import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "CodeCrypto Wallet — test dApp",
  description:
    "Test dApp for the CodeCrypto Wallet Chrome extension: EIP-6963 discovery and the public EIP-1193 surface.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
