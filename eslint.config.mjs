import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // 保留 Next.js 默认排除项，避免检查生成文件。
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 研发文档、历史归档和本地工具产物不属于生产源码质量门禁。
    "workplace/**",
    "project-kb/**",
    "docs/**",
    ".agents/**",
    ".claude/**",
    ".playwright-cli/**",
    "ui-screenshots/**",
    "data/**",
    "logs/**",
  ]),
]);

export default eslintConfig;
