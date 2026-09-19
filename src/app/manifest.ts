import { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'WayFinder',
    short_name: 'WayFinder',
    description: 'A private, live location tracker.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f8f7f2',
    theme_color: '#f8f7f2',
    orientation: 'portrait',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  }
}
