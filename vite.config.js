import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` produces one self-contained dist/index.html (JS, CSS and
// country data inlined) that can be opened directly, hosted anywhere, or
// published as a claude.ai artifact.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    include: ['tests/unit/**/*.test.js'],
    // `npm run test:coverage`: the simulation engine and scenario builder must each stay at 85% or more
    coverage: {
      provider: 'v8',
      include: ['src/sim.js', 'src/scenario.js'],
      reporter: ['text', 'json-summary'],
      thresholds: { perFile: true, statements: 85, branches: 85, functions: 85, lines: 85 }
    }
  }
});
