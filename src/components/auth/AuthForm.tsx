'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiClientError, apiClient } from '@/lib/api/ApiClient';

interface Props {
  mode: 'login' | 'register';
  notice?: string;
}

export function AuthForm({ mode, notice }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isRegister = mode === 'register';

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    setPending(true);
    setError(null);
    try {
      if (isRegister) await apiClient.register(email, password, String(form.get('displayName') ?? ''));
      else await apiClient.login(email, password);
      router.replace('/map');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Something went wrong, please try again');
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate={false}>
      <h1>{isRegister ? 'Create your account' : 'Sign in'}</h1>
      {notice && <p className="form-notice">{notice}</p>}
      {isRegister && (
        <label>
          Display name
          <input name="displayName" autoComplete="nickname" required minLength={2} maxLength={60} placeholder="How others see you" />
        </label>
      )}
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required maxLength={254} />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          required
          minLength={isRegister ? 8 : 1}
          maxLength={128}
        />
      </label>
      {isRegister && <p className="hint">At least 8 characters.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
        {pending ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
      </button>
      <p className="auth-switch">
        {isRegister ? (
          <>
            Already have an account? <Link href="/login">Sign in</Link>
          </>
        ) : (
          <>
            New here? <Link href="/register">Create an account</Link>
          </>
        )}
      </p>
    </form>
  );
}
