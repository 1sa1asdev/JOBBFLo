import './globals.css';

export const metadata = {
  title: 'JOBBFLO',
  description: 'AI-assisterad jobbsökning och ansöknings-CRM',
};

export default function RootLayout({ children }) {
  return (
    <html lang="sv">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
