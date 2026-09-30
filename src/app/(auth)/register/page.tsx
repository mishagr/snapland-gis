import type { Metadata } from 'next';
import { AuthForm } from '@/components/auth/AuthForm';

export const metadata: Metadata = { title: 'Create account · Snapland GIS' };

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
