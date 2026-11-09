import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.foldersync.app',
  appName: 'FolderSync',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
