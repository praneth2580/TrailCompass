import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.trailcompass',
  appName: 'TrailCompass',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    // OpenFreeMap asks apps that save maps offline to name themselves.
    appendUserAgent: 'TrailCompass',
  },
  plugins: {
    Geolocation: {
      // High-accuracy GPS preferred for motorcycle navigation prototypes.
    },
  },
};

export default config;
