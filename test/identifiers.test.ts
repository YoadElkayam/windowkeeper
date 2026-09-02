import { describe, expect, it } from 'vitest';
import { extractIdentifiers } from '../src/identifiers.js';

const values = (text: string) => extractIdentifiers(text).map((i) => i.value);

describe('extractIdentifiers', () => {
  it('finds paths, files, code spans, error codes, refs, and symbols', () => {
    const v = values('Look at src/auth/session.ts and `validateToken()` — it throws ECONNRESET, see PROJ-142 and #1234. Also fix parseUserId in config.yaml.');
    expect(v).toContain('src/auth/session.ts');
    expect(v).toContain('validateToken()');
    expect(v).toContain('ECONNRESET');
    expect(v).toContain('PROJ-142');
    expect(v).toContain('#1234');
    expect(v).toContain('parseUserId');
    expect(v).toContain('config.yaml');
  });

  it('ignores short and stop words, and de-duplicates', () => {
    const v = values('e.g. TODO ok src/x.ts src/x.ts ./src/x.ts');
    expect(v.filter((x) => x.toLowerCase().includes('src/x.ts'))).toHaveLength(1);
    expect(v).not.toContain('TODO');
  });

  it('does not match plain prose', () => {
    expect(values('please continue with the plan and tell me what you changed')).toEqual([]);
  });
});
