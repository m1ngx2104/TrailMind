'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getUnitPreference, setUnitPreference } from '../lib/units';

export default function Navbar({ backButton = false }) {
  const [user, setUser] = useState(null);
  const router = useRouter();

  useEffect(() => {
    fetch('http://localhost:5000/api/auth/me', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data._id) {
          setUser(data);
          // The account's saved preference is the source of truth across devices.
          if (data.unitPreference && data.unitPreference !== getUnitPreference()) {
            setUnitPreference(data.unitPreference);
          }
        }
      })
      .catch(() => {});
  }, []);

  const handleLogout = async () => {
    await fetch('http://localhost:5000/api/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
    sessionStorage.removeItem('lastSearch');
    window.dispatchEvent(new Event('trailmind:logout'));
    router.push('/');
  };

  return (
    <header className="sticky top-0 z-40 border-b border-forest-border bg-forest-bg/80 backdrop-blur-md px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-4">
        {backButton ? (
          <button
            onClick={() => window.history.back()}
            className="flex items-center gap-1 text-forest-muted hover:text-green-400 text-sm transition-colors duration-200"
          >
            <span aria-hidden="true">‹</span> Back to results
          </button>
        ) : null}
        <Link href="/" className="text-2xl font-bold text-green-400 flex items-center gap-1.5">
          <span aria-hidden="true">🌲</span> TrailMind
        </Link>
      </div>
      <div className="flex items-center gap-4">
        <Link href="/map" className="text-sm text-forest-text/70 hover:text-forest-text hover:opacity-100 px-4 py-2 rounded-lg transition-colors duration-200">
          Explore Map
        </Link>
        <Link href="/settings" className="text-sm text-forest-text/70 hover:text-forest-text hover:opacity-100 px-4 py-2 rounded-lg transition-colors duration-200">
          Settings
        </Link>
        {user ? (
          <>
            <span className="text-forest-muted text-sm">Hi, {user.name.split(' ')[0]}</span>
            <button
              onClick={handleLogout}
              className="text-sm text-forest-text/70 hover:text-forest-text px-2 py-2 transition-colors duration-200"
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <Link href="/login" className="text-sm border border-forest-border hover:border-green-500/50 text-forest-text/70 hover:text-forest-text px-4 py-2 rounded-lg transition-colors duration-200">
              Sign in
            </Link>
            <Link href="/register" className="text-sm bg-gradient-to-r from-green-500 to-green-600 hover:brightness-110 text-white px-4 py-2 rounded-lg transition-[filter] duration-200">
              Sign up
            </Link>
          </>
        )}
      </div>
    </header>
  );
}