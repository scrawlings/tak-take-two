import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `web/dist-client` is vite's intermediate output; `web/static/client.js` is
  // the committed minified bundle it becomes (ADR-0013). Named file by file —
  // `web/static/` also holds `site.css`, which is authored, not generated.
  { ignores: ['dist', 'node_modules', 'web/dist-client', 'web/static/client.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
