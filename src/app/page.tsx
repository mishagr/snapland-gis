import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/auth/currentUser';

export const dynamic = 'force-dynamic';

export default async function Home() {
  redirect((await getCurrentUser()) ? '/map' : '/login');
}
