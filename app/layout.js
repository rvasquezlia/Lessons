import "./globals.css";

export const metadata = {
  title: "Lessons",
  description: "Next.js static export foundation for the Lessons repository.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

