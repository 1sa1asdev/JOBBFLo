import { NextResponse } from 'next/server';

// Single-user app that can send mail from your Gmail — never expose it
// unauthenticated. Set APP_PASSWORD in the deployment environment and the
// whole site (UI + API) goes behind HTTP Basic Auth. Unset locally = no gate.
export function middleware(req) {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return NextResponse.next();

  const auth = req.headers.get('authorization') || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme === 'Basic' && encoded) {
    try {
      const decoded = atob(encoded);
      const pwd = decoded.slice(decoded.indexOf(':') + 1);
      if (pwd === pass) return NextResponse.next();
    } catch { /* fall through to 401 */ }
  }
  return new NextResponse('Inloggning krävs', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="jobbjakt"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
