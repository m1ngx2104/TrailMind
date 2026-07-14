'use client';
import dynamic from 'next/dynamic';
import Navbar from '../../components/Navbar';

const ExploreMap = dynamic(() => import('../../components/ExploreMap'), { ssr: false });

export default function MapPage() {
  return (
    <main className="h-screen bg-gray-950 text-white flex flex-col">
      <Navbar />
      <div className="flex-1 relative">
        <ExploreMap />
      </div>
    </main>
  );
}