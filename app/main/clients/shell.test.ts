import { describe, expect, it } from 'vitest';

import { shellQuote } from '@app/main/clients/shell';

describe('shellQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('wraps the empty string', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('preserves spaces verbatim', () => {
    expect(shellQuote('a b c')).toBe("'a b c'");
  });

  it('escapes a single quote as close-escape-reopen', () => {
    expect(shellQuote("can't")).toBe("'can'\\''t'");
  });

  it('escapes multiple single quotes', () => {
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it('leaves double quotes untouched (inside single-quote context)', () => {
    expect(shellQuote('say "hi"')).toBe('\'say "hi"\'');
  });

  it('leaves backticks untouched', () => {
    expect(shellQuote('`whoami`')).toBe("'`whoami`'");
  });

  it('leaves dollar signs untouched', () => {
    expect(shellQuote('$HOME')).toBe("'$HOME'");
  });

  it('leaves parentheses untouched', () => {
    expect(shellQuote('Castlevania (USA, Europe).nes')).toBe(
      "'Castlevania (USA, Europe).nes'",
    );
  });

  it('leaves ampersands untouched', () => {
    expect(shellQuote('Toejam & Earl.md')).toBe("'Toejam & Earl.md'");
  });

  it('leaves semicolons untouched', () => {
    expect(shellQuote('rm -rf /; echo pwned')).toBe("'rm -rf /; echo pwned'");
  });

  it('handles a worst-case mix of metacharacters', () => {
    const input = `$(rm -rf /); echo "x" 'y' \`whoami\` & | ; \\`;
    const quoted = shellQuote(input);
    // Property: the result starts and ends with a single quote, and any
    // embedded single quote is the four-character sequence '\''.
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted).toBe(
      "'$(rm -rf /); echo \"x\" '\\''y'\\'' `whoami` & | ; \\'",
    );
  });
});
