import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// Rendering the whole app in jsdom is slow when test files run in parallel.
configure({ asyncUtilTimeout: 5_000 });

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset['theme'] = 'dark';
});

afterEach(() => {
  cleanup();
});
