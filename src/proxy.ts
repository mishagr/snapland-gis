import { NextResponse, type NextRequest } from 'next/server';

/**
 * Cheap edge gate: requests for the map without a session cookie go straight to
 * the login page. The cookie is validated for real (Redis lookup) by the page and
 * by every API route; this only saves a render for obviously signed-out users.
 */
export function proxy(request: NextRequest) {
  if (!request.cookies.has('snapland_sid')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/map/:path*'],
};
