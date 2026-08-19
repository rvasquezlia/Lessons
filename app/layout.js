import "./globals.css";
import "katex/dist/katex.min.css";
import { AuthProvider } from "./contexts/AuthContext";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";

export const metadata = {
  title: "LIA Curriculum",
  description: "Git-backed static curriculum site with GitHub sign-in and TipTap CMS.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <Header />
          <div className="app-shell">
            <Sidebar />
            <main className="app-main">{children}</main>
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}

