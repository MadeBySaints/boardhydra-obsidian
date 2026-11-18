import { defineConfig, globalIgnores } from 'eslint/config'
import obsidianmd from 'eslint-plugin-obsidianmd'

// The same rules the community directory's automated review runs.
export default defineConfig([
  globalIgnores(['node_modules', 'build', 'main.js', 'esbuild.config.mjs', 'test']),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['eslint.config.*'] } },
    },
  },
])
