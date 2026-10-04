import { NextResponse } from 'next/server';
import { getServices } from '@/server/container';

export const dynamic = 'force-dynamic';

/** Liveness: the process is up and serving requests. No dependency checks. */
export function GET() {
  return NextResponse.json(getServices().health.liveness(), { headers: { 'Cache-Control': 'no-store' } });
}
