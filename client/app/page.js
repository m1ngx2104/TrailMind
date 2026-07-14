'use client';
import { useState, useEffect } from 'react';

export default function Home() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('http://localhost:5000/api/health')
      .then(res => res.json())
      .then(data => {
        setStatus(data);
        setLoading(false);
      })
      .catch(() => {
        setStatus({ status: 'error', message: 'Could not reach server' });
        setLoading(false);
      });
  }, []);

  return (
    <main className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-5xl font-bold text-white mb-2">TrailMind</h1>
        <p className="text-gray-400 mb-8">Your AI-powered trail discovery app</p>
        <div className="bg-gray-800 rounded-xl p-6 text-left w-80">
          <p className="text-gray-400 text-sm mb-3">System Status</p>
          {loading ? (
            <p className="text-yellow-400">Checking connection...</p>
          ) : (
            <>
              <p className={status?.status === 'ok' ? 'text-green-400' : 'text-red-400'}>
                ● Server: {status?.message}
              </p>
              <p className={status?.database === 'connected' ? 'text-green-400' : 'text-red-400'}>
                ● Database: {status?.database}
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}