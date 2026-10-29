import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` produces one self-contained dist/index.html (JS, CSS and
// country data inlined) that can be opened directly, hosted anywhere, or
// published as a claude.ai artifact.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { outDir: 'dist', emptyOutDir: true },
  test: { include: ['tests/unit/**/*.test.js'] }
});
