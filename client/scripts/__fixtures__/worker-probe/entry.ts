// moduleGraph test probe (review r1): the main bundle is clean; the worker it starts is not.
document.body.addEventListener('click', () => {
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
});
