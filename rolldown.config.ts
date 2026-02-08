import { defineConfig } from 'rolldown';

export default defineConfig({
  input: 'src/index.ts',
  platform: 'node',
  external: [/^node:/, 'langfuse'],
  output: {
    file: 'dist/index.js',
    format: 'esm',
  },
});
