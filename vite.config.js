import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// `npm run build` produces one self-contained dist/index.html (JS, CSS and
// country data inlined) that can be opened directly, hosted anywhere, or
// published as a claude.ai artifact.

// jsPDF imports these on demand for .html() and SVG, which the debrief PDF does not use
const NO_OPTIONAL = fileURLToPath(new URL('./src/vendor/no-optional.js', import.meta.url));

export default defineConfig({
  plugins: [viteSingleFile()],
  resolve: { alias: { html2canvas: NO_OPTIONAL, dompurify: NO_OPTIONAL, canvg: NO_OPTIONAL } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    include: ['tests/unit/**/*.test.js'],
    // `npm run test:coverage`: the simulation engine, scenario builder, safety nets and tools must each stay at 85% or more
    coverage: {
      provider: 'v8',
      include: ['src/sim.js', 'src/scenario.js', 'src/cmdline.js', 'src/records.js', 'src/pdf.js', 'src/progress.js', 'src/charts.js', 'src/recommend.js', 'src/nets/*.js', 'src/tools/*.js'],
      reporter: ['text', 'json-summary'],
      thresholds: { perFile: true, statements: 85, branches: 85, functions: 85, lines: 85 }
    }
  }
});
