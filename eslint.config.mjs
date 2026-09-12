import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "build/**"] },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
