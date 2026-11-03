/**
 * Three layers, one coverage report:
 *  - unit:        src/**\/*.spec.ts — one class at a time, collaborators mocked
 *  - integration: test/integration — real services wired together (Redis via
 *                 ioredis-mock, HTTP clients against a local fake server)
 *  - e2e:         test/e2e — the whole AppModule over HTTP (supertest); the
 *                 backend and the Evolution API are a local fake server
 */
const shared = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  rootDir: __dirname,
};

module.exports = {
  projects: [
    {
      ...shared,
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
    },
    {
      ...shared,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
    },
    {
      ...shared,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.spec.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: { statements: 60, branches: 60, functions: 60, lines: 60 },
  },
};
