import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// SINGLE_FILE=1 → fully self-contained index.html (all JS/CSS/data inlined),
// used for the shareable preview build. Normal builds emit hashed assets.
const single = process.env.SINGLE_FILE === '1'

export default defineConfig({
  // Relative base → the build works at any URL depth (github.io/<repo>/,
  // a subfolder on shared hosting, or opened straight from disk).
  base: './',
  plugins: [react(), ...(single ? [viteSingleFile()] : [])],
  build: {
    outDir: single ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 6000,
    ...(single ? {} : { assetsInlineLimit: 4096 }),
  },
})
