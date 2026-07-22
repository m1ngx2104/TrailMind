'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [formData, setFormData] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (formData.password !== formData.confirmPassword) {
      return setError('Passwords do not match');
    }

    if (formData.password.length < 6) {
      return setError('Password must be at least 6 characters');
    }

    setLoading(true);
    try {
      const data = await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          password: formData.password
        })
      });
      setSuccess(data.message);
    } catch (err) {
      setError(err.message);
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
          <h1 className="text-2xl font-bold text-white">Create your account</h1>
          <p className="text-[#a0b4a8] mt-2 text-sm">Start discovering trails with TrailMind</p>
        </div>

        <div className="bg-[rgba(26,36,32,0.85)] backdrop-blur-xl border border-forest-border rounded-2xl p-10 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg p-3 mb-6 text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="bg-green-500/10 border border-green-500/20 text-green-400 rounded-lg p-3 mb-6 text-sm">
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm text-forest-muted mb-1">Full Name</label>
              <input
                type="text"
                name="name"
                value={formData.name}
                onChange={handleChange}
                required
                placeholder="John Doe"
                className="w-full bg-forest-bg border border-forest-border text-forest-text rounded-lg px-4 py-3 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/30 placeholder-forest-muted/50 transition-colors"
              />
            </div>

            <div>
              <label className="block text-sm text-forest-muted mb-1">Email</label>
              <input
                type="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                required
                placeholder="you@example.com"
                className="w-full bg-forest-bg border border-forest-border text-forest-text rounded-lg px-4 py-3 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/30 placeholder-forest-muted/50 transition-colors"
              />
            </div>

            <div>
              <label className="block text-sm text-forest-muted mb-1">Password</label>
              <input
                type="password"
                name="password"
                value={formData.password}
                onChange={handleChange}
                required
                placeholder="At least 6 characters"
                className="w-full bg-forest-bg border border-forest-border text-forest-text rounded-lg px-4 py-3 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/30 placeholder-forest-muted/50 transition-colors"
              />
            </div>

            <div>
              <label className="block text-sm text-forest-muted mb-1">Confirm Password</label>
              <input
                type="password"
                name="confirmPassword"
                value={formData.confirmPassword}
                onChange={handleChange}
                required
                placeholder="Repeat your password"
                className="w-full bg-forest-bg border border-forest-border text-forest-text rounded-lg px-4 py-3 outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/30 placeholder-forest-muted/50 transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-green-500 to-green-600 disabled:from-green-800 disabled:to-green-800 disabled:cursor-not-allowed hover:brightness-110 text-white font-semibold py-3 rounded-lg transition-[filter] duration-200"
            >
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
          </form>

          <p className="text-center text-forest-muted text-sm mt-6">
            Already have an account?{' '}
            <Link href="/login" className="text-green-400 hover:text-green-300">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}