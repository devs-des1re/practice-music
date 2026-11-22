import { defineConfig } from '@krate/core';

export default defineConfig({
  entry: 'src/pages/index.tsx',
  pagesDir: 'src/pages',
  outDir: 'dist',
  native: {
    appId: 'com.practicemusic.app',
    productName: 'PracticeMusic',
    version: '0.1.0',
    window: { width: 1280, height: 800 },
    permissions: ['dialog'],
  },
});
