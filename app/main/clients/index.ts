import os from 'node:os';
import path from 'node:path';

import type { IMisterClient } from '@shared/mister-client';
import { FakeMisterClient } from '@app/main/clients/fake-mister-client';

export type { IMisterClient } from '@shared/mister-client';
export { FakeMisterClient } from '@app/main/clients/fake-mister-client';

export type MisterClientMode = 'real' | 'fake';

export function createMisterClient(mode: MisterClientMode): IMisterClient {
  if (mode === 'real') {
    throw new Error('Real MiSTer client not implemented yet.');
  }

  // The fake operates on a stable temp location so dev sessions can mutate
  // (rename) files without dirtying the canonical fixtures in git.
  const pristineRootPath = path.join(process.cwd(), 'fixtures', 'sample-mister');
  const rootPath = path.join(os.tmpdir(), 'mistercurator-fake-mister');

  return new FakeMisterClient({ rootPath, pristineRootPath });
}
