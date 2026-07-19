---
"@taujs/server": patch
---

Fix: `__proto__` in route data now round-trips as an ordinary own property

Route data is injected into the page as `window.__INITIAL_DATA__ = <value>`. That value was
always emitted as a JavaScript object literal, and in an object literal a quoted `"__proto__":`
key SETS THE CREATED OBJECT'S PROTOTYPE (ES Annex B.3.1) rather than adding an own property. So a
route that legitimately returned a `__proto__` key produced a client value whose shape differed
from the server's: the key was an own property on the server and landed on the prototype in the
browser, at any depth.

This was never global prototype pollution - `Object.prototype` was untouched, and it remains
untouched - but it was silent semantic drift in the single shared serialisation boundary, and
"the global prototype was not polluted" is not the same guarantee as "the client received the
value the server sent".

Now, when a payload contains a `__proto__` key at any depth, the value is emitted as
`JSON.parse("…")`. `JSON.parse` creates the key as an ordinary own data property at every depth,
the object's prototype stays `Object.prototype`, and the global prototype is still untouched.
Breakout escaping is unchanged in both forms.

Every other payload keeps the object-literal form and is byte-identical to before, so ordinary
responses and cached pages see no difference. The one exception is a string value exactly equal to
`"__proto__"`, which also selects the `JSON.parse` form: the two forms are semantically identical,
so this costs a few bytes and changes nothing observable.
