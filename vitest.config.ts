import { defineConfig } from 'vitest/config';

// 测试直接跑 src（通过自定义 export 条件 "@super-loop/source"），无需先 build。
const conditions = ['@super-loop/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    include: ['{packages,plugins,apps}/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', ...(process.env.E2E ? [] : ['**/*.e2e.test.ts'])],
    environment: 'node',
  },
});
