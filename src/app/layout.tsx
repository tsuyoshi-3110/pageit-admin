import "./globals.css";
import type { ReactNode } from "react";
import NavBar from "@/components/NavBar";
import ThemeProvider from "@/components/ThemeProvider";

export const metadata = {
  title: "Firebase Admin Portal",
  description: "サイトオーナーアカウント作成用ポータル",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body className="font-sans bg-white dark:bg-black text-black dark:text-white min-h-screen">
        <ThemeProvider>
          <NavBar />
          <main className="pt-16 p-6">{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}
