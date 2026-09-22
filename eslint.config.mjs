import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["migrations/**", "node_modules/**", ".next/**", "next-env.d.ts"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Next.js route handlers and middleware must match a fixed function
      // signature even when a parameter isn't used — underscore-prefixed
      // names are the conventional way to say "required by the framework,
      // not by this implementation."
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  }
);
