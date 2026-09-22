/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['<rootDir>/src/tests/**/*.test.ts'],
  clearMocks: true,
  resolver: '<rootDir>/scripts/jest-resolver.cjs',
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', {
      tsconfig: {
        allowJs: true,
        isolatedModules: true,
        module: 'CommonJS',
        moduleResolution: 'Node',
      },
    }],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(plist)/)',
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^react-native$': '<rootDir>/src/tests/mocks/modules/react-native.ts',
    '^react-native/Libraries/Image/AssetRegistry$': '<rootDir>/src/tests/mocks/modules/assetRegistry.ts',
    '^bundle-drop-config$': '<rootDir>/src/tests/mocks/modules/bundle-drop-config.ts',
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.ts',
    '!src/tests/**',
    '!src/index.tsx',
    '!src/bootstrap.ts',
    '!src/image-manifest.ts',
  ],
  setupFilesAfterEnv: ['<rootDir>/src/tests/setupEnv.ts'],
};
