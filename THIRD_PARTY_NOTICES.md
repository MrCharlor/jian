# Third-party notices

Jian ships a small set of skills copied from public skill marketplaces. Each one is
vendored at a pinned commit under `apps/gateway/src/skills/builtin/vendored/`, so an
installation can say exactly what its agents were told without reaching the network.

## discernment-nudge

Copyright Anthropic PBC. Licensed under the Apache License, Version 2.0.

- Source: <https://github.com/anthropics/skills/tree/main/skills/discernment-nudge>
- Commit: `f379e5ad66e2febc1616cf8d6284666fecbe514e`
- License: <https://www.apache.org/licenses/LICENSE-2.0>

The text is used unmodified apart from its YAML front matter, which Jian replaces with its
own skill name and description.

## Ponytail

Copyright (c) 2026 DietrichGebert. Licensed under the MIT License.

- Source: <https://github.com/DietrichGebert/ponytail>
- Commit: `e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`

The six skill instructions were adapted to Jian's tools and runtime. Jian does not include
Ponytail's Codex or Claude hooks. The MIT permission notice follows:

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Caveman local proxy

Copyright (c) 2026 Julius Brussee. Licensed under the MIT License.

- Source: <https://github.com/JuliusBrussee/caveman>
- Pinned proxy release: `bin-v1.1.7`

The image includes only the local `caveman-proxy` binary. Its release assets are pinned by
SHA-256 for Linux amd64 and arm64. The MIT permission notice follows:

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
