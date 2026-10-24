// Source-run Playwright loads the built runtime. Keep this literal boundary in
// JavaScript so the TypeScript build does not ingest its own dist declarations.
export function loadPackagedExecutionFixture() {
  return import('../../../../dist/tests/helpers/execution-production-fixture.js');
}
