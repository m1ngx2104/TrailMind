'use client';
import { useState, useEffect } from 'react';
import Navbar from '../../components/Navbar';
import { api } from '../../lib/api';
import { getUnitPreference, setUnitPreference } from '../../lib/units';

const UNIT_OPTIONS = [
  { value: 'imperial', label: 'Imperial', hint: 'miles, feet, °F' },
  { value: 'metric', label: 'Metric', hint: 'kilometers, meters, °C' }
];

export default function SettingsPage() {
  const [unit, setUnit] = useState('imperial');
  const [loggedIn, setLoggedIn] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setUnit(getUnitPreference());
    fetch('http://localhost:5000/api/auth/me', { credentials: 'include' })
      .then((res) => res.json())
      .then((data) => { if (data._id) setLoggedIn(true); })
      .catch(() => {});
  }, []);

  const handleSelect = async (value) => {
    setUnit(value);
    setUnitPreference(value);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);

    if (loggedIn) {
      try {
        await api('/auth/units', {
          method: 'PATCH',
          body: JSON.stringify({ unitPreference: value })
        });
      } catch (err) {
        // Local preference already applied; account sync can be retried next visit.
      }
    }
  };

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <Navbar />

      <div className="max-w-2xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold mb-2">Settings</h2>
        <p className="text-gray-400 mb-10">Manage how TrailMind displays distances, elevation and temperature.</p>

        <div className="bg-gray-900 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Units</h3>
            {saved && <span className="text-green-400 text-sm">Saved</span>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {UNIT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleSelect(opt.value)}
                className={`text-left rounded-xl border p-4 transition-colors ${
                  unit === opt.value
                    ? 'bg-green-600/20 border-green-500 text-white'
                    : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                }`}
              >
                <p className="font-medium">{opt.label}</p>
                <p className="text-sm text-gray-400 mt-1">{opt.hint}</p>
              </button>
            ))}
          </div>

          <p className="text-gray-500 text-sm mt-4">
            {loggedIn
              ? 'This preference is saved to your account and will follow you across devices.'
              : 'This preference is saved to this browser. Sign in to sync it across devices.'}
          </p>
        </div>
      </div>
    </main>
  );
}
