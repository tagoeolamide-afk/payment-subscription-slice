import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { maybeFail } from "@/lib/dev-faults";
import { PRODUCT_NAME } from "@/lib/plans";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await maybeFail("root_layout"); // development-only test error
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
