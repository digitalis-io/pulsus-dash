const base = new URL('http://localhost'); fetch(base);
const v = new URL(p, 'http://localhost'); fetch(v.href);
fetch(new URL('x', 'https://react.dev/errors/'));
import(new URL('m.js', 'http://localhost').href);
