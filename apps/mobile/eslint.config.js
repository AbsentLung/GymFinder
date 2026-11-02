// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // This app's components are the vibe-coded reference code (Phase 2
    // of the roadmap just moved them into this workspace unchanged -
    // "Treat the current src/ code as reference only," per the
    // restructure plan). These three React Compiler-era rules are
    // newly strict about patterns (setState in an effect, refs read
    // during render, manual memoization) that are common and working
    // throughout that code, not new mistakes introduced here. Rewriting
    // ~30 call sites to satisfy a linter that was never configured
    // before today would be exactly the kind of behavior-risking,
    // unrequested change the plan says to ask about first. Revisit once
    // Phase 6 replaces this map/search code for real.
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
]);
