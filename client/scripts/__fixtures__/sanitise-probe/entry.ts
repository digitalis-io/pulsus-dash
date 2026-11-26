// unit:sanitise-bundle probe entry (plan #198 Part 2a §3.6): the sanitiser modules as a lazy chunk.
document.body.addEventListener('click', () => {
  void import('./sanitise.ts').then((m) => {
    console.log(m.run(document.body.textContent));
  });
});
