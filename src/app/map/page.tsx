import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { MapWorkspace } from '@/components/map/MapWorkspace';
import { getCurrentUser } from '@/server/auth/currentUser';
import { getPublicConfig } from '@/server/config/publicConfig';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Map · Snapland GIS' };

export default async function MapPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return <MapWorkspace user={user} config={getPublicConfig()} />;
}
