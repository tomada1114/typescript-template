# Getting started

Install the ESM-only package with pnpm:

```sh
pnpm add my-package
```

```ts
import { normalizeIdentifier, withTimeout } from "my-package";

const id = normalizeIdentifier("Release candidate 3");
const response = await withTimeout(
  (signal) => fetch("https://example.com", { signal }),
  { timeoutMs: 5_000 },
);
```

Node profiles require Node.js 22.14 or newer. Import only from `my-package`;
paths not listed in `package.json#exports` are private.
