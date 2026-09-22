import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Legal Intake Engine",
  description: "Internal scaffold — see the c19/c21 board cards for status.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
