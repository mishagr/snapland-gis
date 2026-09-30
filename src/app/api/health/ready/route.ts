import { NextResponse } from 'next/server';
import { getServices } from '@/server/container';

export const dynamic = 'force-dynamic';

/** Readiness: database (with PostGIS) and Redis reachable; 503 otherwise. */
export async function GET() {
  const readiness = await getServices().health.readiness();
  return NextResponse.json(readiness, {
    status: readiness.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
