'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const data = await api('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email })
      });
      setMessage(data.message);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative min-h-screen flex items-center justify-center px-4 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 900px 600px at 15% 0%, #1a3d2a 0%, transparent 60%),
            linear-gradient(to bottom, transparent 0%, #0f1712 80%),
            #0f1712
          `
        }}
      />
      <div className="relative w-full max-w-[420px]">
        <div className="text-center mb-6">
          <Link href="/" className="text-2xl font-bold text-green-400 inline-flex items-center gap-1.5">
            <span aria-hidden="true">🌲</span> TrailMind
          </Link>
        </div>
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white">Forgot password?</h1>
          <p className="text-[#a0b4a8] mt-2 text-sm">We'll send you a reset link</p>
        </div>

        <div className="bg-[rgba(26,36,32,0.85)] backdrop-blur-xl border border-forest-border rounded-2xl p-10 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
          {message && (
            <div className="bg-green-500/10 border border-green-500/20 text-green-400 rounded-lg p-3 mb-6 text-sm">
              {message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm text-forest-muted mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@example.com"
                className="w-full bg-forest-bg border border-forest-border text-forest-text rounded-lg px-4 py-3 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/30 placeholder-forest-muted/50 transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-green-500 to-green-600 disabled:from-green-800 disabled:to-green-800 disabled:cursor-not-allowed hover:brightness-110 text-white font-semibold py-3 rounded-lg transition-[filter] duration-200"
            >
              {loading ? 'Sending...' : 'Send Reset Link'}
            </button>
          </form>

          <p className="text-center text-forest-muted text-sm mt-6">
            Remember your password?{' '}
            <Link href="/login" className="text-green-400 hover:text-green-300">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}