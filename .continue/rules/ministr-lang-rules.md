# Language Best Practices

Auto-generated rules based on detected project languages.

## TypeScript

- Enable `strict` mode in `tsconfig.json` — never use `any` (use `unknown` if needed)
- Prefer `interface` for object shapes, `type` for unions/intersections
- Use `const` by default; `let` only when mutation is required; never `var`
- Use optional chaining (`?.`) and nullish coalescing (`??`) over manual null checks
- Prefer `async/await` over raw Promise chains
- Use `eslint` + `prettier` for consistent formatting and linting
- Export types alongside values; prefer named exports over default exports
- Use `zod` or similar for runtime validation at API boundaries
- Place tests next to source files (`foo.test.ts`) or in `__tests__/`
