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
    <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-4">
        {backButton ? (
          <button
            onClick={() => window.history.back()}
            className="text-green-400 hover:text-green-300 text-sm"
          >
            Back to results
          </button>
        ) : null}
        <Link href="/" className="text-xl font-bold text-green-400">TrailMind</Link>
      </div>
      <div className="flex items-center gap-4">
        <Link href="/map" className="text-sm text-gray-300 hover:text-white px-4 py-2 rounded-lg transition-colors">
          Explore Map
        </Link>
        <Link href="/settings" className="text-sm text-gray-300 hover:text-white px-4 py-2 rounded-lg transition-colors">
          Settings
        </Link>
        {user ? (
          <>
            <span className="text-gray-300 text-sm">Hi, {user.name.split(' ')[0]}</span>
            <button
              onClick={handleLogout}
              className="text-sm border border-gray-600 hover:border-gray-400 text-gray-300 hover:text-white px-4 py-2 rounded-lg transition-colors"
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <Link href="/login" className="text-sm border border-gray-600 hover:border-gray-400 text-gray-300 hover:text-white px-4 py-2 rounded-lg transition-colors">
              Sign in
            </Link>
            <Link href="/register" className="text-sm bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-lg transition-colors">
              Sign up
            </Link>
          </>
        )}
      </div>
    </header>
  );
}