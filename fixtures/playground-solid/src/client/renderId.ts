/**
 * The renderId is a SHARED constant: the server renders Solid's markers and serialised data under
 * this namespace and the client must hydrate under the SAME one. Both entries import it, so the
 * two can never drift - a literal duplicated across two files is a hydration bug waiting to happen.
 */
export const RENDER_ID = 'playground-solid';
