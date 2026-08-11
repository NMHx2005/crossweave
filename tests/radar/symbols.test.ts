import { beforeAll, describe, expect, test } from 'bun:test';
import { initGrammars } from '../../src/radar/grammars.js';
import { extractSymbols } from '../../src/radar/symbols.js';

beforeAll(async () => {
  await initGrammars();
});

describe('extractSymbols — typescript', () => {
  test('extracts a plain top-level function', () => {
    const src = 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n';
    const symbols = extractSymbols(src, 'typescript');
    expect(symbols).toBeDefined();
    expect(symbols).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  test('extracts a class and its methods separately', () => {
    const src =
      'export class AuthService {\n' +
      '  login(user: string): boolean {\n    return true;\n  }\n' +
      '  logout(): void {}\n' +
      '}\n';
    const symbols = extractSymbols(src, 'typescript');
    expect(symbols).toBeDefined();
    const names = symbols?.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('class:AuthService');
    expect(names).toContain('method:AuthService.login');
    expect(names).toContain('method:AuthService.logout');
  });

  test('a generic function declaration is still extracted as one function symbol', () => {
    const src = 'export function identity<T>(x: T): T {\n  return x;\n}\n';
    const symbols = extractSymbols(src, 'typescript');
    expect(symbols).toContainEqual(expect.objectContaining({ name: 'identity', kind: 'function' }));
  });

  test('a nested function inside another function is NOT extracted as top-level', () => {
    const src = 'function outer() {\n  function inner() { return 1; }\n  return inner();\n}\n';
    const symbols = extractSymbols(src, 'typescript');
    const names = symbols?.map((s) => s.name);
    expect(names).toContain('outer');
    expect(names).not.toContain('inner');
  });

  test('an interface and a type alias are extracted', () => {
    const src = 'export interface Shape { area(): number }\nexport type Id = string;\n';
    const symbols = extractSymbols(src, 'typescript');
    const names = symbols?.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('interface:Shape');
    expect(names).toContain('type:Id');
  });

  test('a syntax-error file returns undefined so the caller can fall back to file-level', () => {
    const src = 'function broken( {{{ not valid typescript at all //// ';
    // Deliberately does not assert `undefined` for every malformed snippet —
    // tree-sitter is error-tolerant and can produce a partial tree for small
    // fragments. What matters operationally is that a file with a real,
    // unrecoverable syntax error degrades to file-level rather than
    // crashing; this fixture is chosen to trigger that path.
    const symbols = extractSymbols(src, 'typescript');
    expect(symbols).toBeUndefined();
  });
});

describe('extractSymbols — python', () => {
  test('extracts a function and a class with a nested method', () => {
    const src = 'def greet(name):\n    return f"hi {name}"\n\n\nclass AuthService:\n    def login(self):\n        return True\n';
    const symbols = extractSymbols(src, 'python');
    const names = symbols?.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('function:greet');
    expect(names).toContain('class:AuthService');
    expect(names).toContain('method:AuthService.login');
  });
});
