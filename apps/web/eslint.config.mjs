import { FlatCompat } from "@eslint/eslintrc";
import baseConfig from "../../eslint.config.mjs";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

export default [
  ...baseConfig,
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
    settings: {
      next: {
        rootDir: ".",
      },
    },
  },
];
