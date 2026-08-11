import type { Node } from 'web-tree-sitter';
import { Parser } from 'web-tree-sitter';
import { languageFor, type SupportedLanguage } from './grammars.js';

export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'const';

export interface SymbolRange {
  name: string;
  kind: SymbolKind;
  startByte: number;
  endByte: number;
  /**
   * Byte offset where the symbol's body block starts — populated for
   * `function`/`method` kinds only, via the node's own `body` field, so a
   * consumer (Task 8's `ContractService`) can split "signature" from
   * "implementation" without guessing at brace positions (which breaks on a
   * destructured/object-typed parameter). Left `undefined` for
   * `class`/`interface`/`type`/`const`.
   */
  bodyStartByte?: number;
}

/** Unwraps `export`/`export default` so the wrapped declaration is what gets classified. */
function unwrapExport(node: Node): Node {
  if (node.type === 'export_statement') {
    return node.childForFieldName('declaration') ?? node;
  }
  return node;
}

function tsTopLevelSymbol(node: Node): SymbolRange | undefined {
  const inner = unwrapExport(node);
  switch (inner.type) {
    case 'function_declaration': {
      const name = inner.childForFieldName('name')?.text;
      const bodyStartByte = inner.childForFieldName('body')?.startIndex;
      return name
        ? { name, kind: 'function', startByte: node.startIndex, endByte: node.endIndex, bodyStartByte }
        : undefined;
    }
    case 'interface_declaration': {
      const name = inner.childForFieldName('name')?.text;
      return name ? { name, kind: 'interface', startByte: node.startIndex, endByte: node.endIndex } : undefined;
    }
    case 'type_alias_declaration': {
      const name = inner.childForFieldName('name')?.text;
      return name ? { name, kind: 'type', startByte: node.startIndex, endByte: node.endIndex } : undefined;
    }
    case 'lexical_declaration': {
      // `const x = ...` — take the first declarator's name; multi-declarator
      // top-level consts are rare enough that only the first is claimed.
      const declarator = inner.namedChild(0);
      const name = declarator?.childForFieldName('name')?.text;
      return name ? { name, kind: 'const', startByte: node.startIndex, endByte: node.endIndex } : undefined;
    }
    default:
      return undefined;
  }
}

function tsClassMethods(classNode: Node): SymbolRange[] {
  const body = classNode.childForFieldName('body');
  if (!body) return [];
  const out: SymbolRange[] = [];
  for (const child of body.namedChildren) {
    if (!child || child.type !== 'method_definition') continue;
    const name = child.childForFieldName('name')?.text;
    const bodyStartByte = child.childForFieldName('body')?.startIndex;
    if (name) out.push({ name, kind: 'method', startByte: child.startIndex, endByte: child.endIndex, bodyStartByte });
  }
  return out;
}

function extractTsLike(root: Node): SymbolRange[] {
  const out: SymbolRange[] = [];
  for (const child of root.namedChildren) {
    if (!child) continue;
    const symbol = tsTopLevelSymbol(child);
    if (symbol) out.push(symbol);
    const inner = unwrapExport(child);
    if (inner.type === 'class_declaration') {
      const name = inner.childForFieldName('name')?.text;
      if (name) out.push({ name, kind: 'class', startByte: child.startIndex, endByte: child.endIndex });
      out.push(...tsClassMethods(inner));
    }
  }
  return out;
}

function pyClassMethods(classNode: Node): SymbolRange[] {
  const body = classNode.childForFieldName('body');
  if (!body) return [];
  const out: SymbolRange[] = [];
  for (const child of body.namedChildren) {
    if (!child || child.type !== 'function_definition') continue;
    const name = child.childForFieldName('name')?.text;
    const bodyStartByte = child.childForFieldName('body')?.startIndex;
    if (name) out.push({ name, kind: 'method', startByte: child.startIndex, endByte: child.endIndex, bodyStartByte });
  }
  return out;
}

function extractPython(root: Node): SymbolRange[] {
  const out: SymbolRange[] = [];
  for (const child of root.namedChildren) {
    if (!child) continue;
    if (child.type === 'function_definition') {
      const name = child.childForFieldName('name')?.text;
      const bodyStartByte = child.childForFieldName('body')?.startIndex;
      if (name) out.push({ name, kind: 'function', startByte: child.startIndex, endByte: child.endIndex, bodyStartByte });
    } else if (child.type === 'class_definition') {
      const name = child.childForFieldName('name')?.text;
      if (name) out.push({ name, kind: 'class', startByte: child.startIndex, endByte: child.endIndex });
      out.push(...pyClassMethods(child));
    }
  }
  return out;
}

/**
 * Returns `undefined` — never throws, never returns an empty array meaning
 * something different from "genuinely no top-level symbols" — when the
 * source's root node contains an unrecoverable syntax error. The caller
 * (Task 4's indexer) treats `undefined` as "fall back to a file-level
 * claim", per the M3 design doc §4.
 */
export function extractSymbols(source: string, language: SupportedLanguage): SymbolRange[] | undefined {
  const parser = new Parser();
  try {
    parser.setLanguage(languageFor(language));
    const tree = parser.parse(source);
    if (!tree) return undefined;
    const root = tree.rootNode;
    if (root.hasError) return undefined;
    return language === 'python' ? extractPython(root) : extractTsLike(root);
  } finally {
    parser.delete();
  }
}
