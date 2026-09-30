import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/auth/currentUser';

export const dynamic = 'force-dynamic';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await getCurrentUser()) redirect('/map');
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden>◈</span> Snapland GIS
        </div>
        <p className="auth-tagline">Draw and measure areas together, live, on govmap and OpenStreetMap.</p>
        {children}
      </div>
    </main>
  );
}
