import { useState } from 'react';
import { useFirebase } from '../contexts/FirebaseContext.tsx';
import { apiFetch, ApiError } from '../lib/api.ts';
import type { AuthUser } from '../types.ts';

interface AuthPageProps {
  onSuccess: (user: AuthUser, token: string) => void;
}

export function AuthPage({ onSuccess }: AuthPageProps) {
  const { signInWithGoogle } = useFirebase();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setError(null);
    setGoogleLoading(true);
    try {
      const res = await signInWithGoogle();
      onSuccess(res.user, res.token);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Unable to sign in with Google.',
      );
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = mode === 'login' ? { email, password } : { name, email, password };
      const res = await apiFetch<{ token: string; user: AuthUser }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onSuccess(res.user, res.token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to authenticate.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-md space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
        <div className="flex rounded-xl bg-[#F5F8FC] p-1">
          <button
            type="button"
            onClick={() => {
              setMode('login');
              setError(null);
            }}
            className={`min-h-[40px] flex-1 rounded-lg text-sm font-semibold transition-colors ${
              mode === 'login' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#718096]'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('register');
              setError(null);
            }}
            className={`min-h-[40px] flex-1 rounded-lg text-sm font-semibold transition-colors ${
              mode === 'register' ? 'bg-white text-[#1769AA] shadow-xs' : 'text-[#718096]'
            }`}
          >
            Create Account
          </button>
        </div>

        <h1 className="mt-6 font-display text-2xl font-bold text-[#12304A]">
          {mode === 'login' ? 'Sign in to HospitEase AI' : 'Create a patient account'}
        </h1>
        <p className="mt-1 text-sm text-[#718096]">
          {mode === 'login'
            ? 'Sign in with Google or email to submit OPD updates, sync saved hospitals, and save AI chat history.'
            : 'We store only your name and email. No personal medical data is ever collected.'}
        </p>

        <div className="mt-5">
          <button
            type="button"
            disabled={googleLoading || loading}
            onClick={() => void handleGoogleLogin()}
            className="flex min-h-[44px] w-full items-center justify-center gap-2.5 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-[#12304A] shadow-xs transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
              />
              <path
                fill="#FBBC05"
                d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
              />
            </svg>
            <span>{googleLoading ? 'Signing in with Google...' : 'Continue with Google'}</span>
          </button>

          <div className="relative my-5 flex items-center">
            <div className="flex-grow border-t border-slate-200" />
            <span className="mx-3 shrink-0 text-xs font-medium text-[#718096]">
              or continue with email
            </span>
            <div className="flex-grow border-t border-slate-200" />
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div>
              <label htmlFor="auth-name" className="block text-sm font-medium text-[#12304A]">
                Full Name
              </label>
              <input
                id="auth-name"
                type="text"
                required
                minLength={2}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 text-sm"
              />
            </div>
          )}

          <div>
            <label htmlFor="auth-email" className="block text-sm font-medium text-[#12304A]">
              Email Address
            </label>
            <input
              id="auth-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 text-sm"
            />
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-sm font-medium text-[#12304A]">
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-[#F5F8FC] px-3.5 text-sm"
            />
            {mode === 'register' && (
              <p className="mt-1 text-xs text-[#718096]">
                Minimum 8 characters including both letters and digits.
              </p>
            )}
          </div>

          {error && (
            <div role="alert" className="rounded-xl border border-[#E05252]/40 bg-red-50 px-3.5 py-2.5 text-sm text-red-900">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="min-h-[44px] w-full rounded-xl bg-[#1769AA] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#125388] disabled:opacity-50"
          >
            {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>
      </section>
    </div>
  );
}
