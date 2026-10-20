import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Under the load of a full parallel run a page can need more than the 1 s default to settle.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
